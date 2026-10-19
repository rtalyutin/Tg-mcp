import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { object, playerFail, PlayerError } from './player-profile-config.mjs';

export const PLAYER_PREFIX = 'private/player-profiles/v1/';
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const empty = () => ({ schemaVersion: 1, revision: 0, identities: {}, accounts: {}, sessions: {}, attempts: {}, assets: {}, receipts: {} });
const precondition = (e) => e.$metadata?.httpStatusCode === 412 || e.name === 'PreconditionFailed';
const absent = (e) => e.name === 'NoSuchKey' || e.name === 'NotFound' && e.$metadata?.httpStatusCode === 404;
export const digest = (value) => createHash('sha256').update(value).digest('hex');

async function bytes(body, contentLength, max) {
  if (contentLength > max || !body?.[Symbol.asyncIterator]) playerFail('storage_unavailable', 503);
  let size = 0; const chunks = [];
  try { for await (const chunk of body) { size += chunk.length; if (size > max) playerFail('storage_unavailable', 503); chunks.push(Buffer.from(chunk)); } }
  finally { if (size > max) body.destroy?.(); }
  return Buffer.concat(chunks);
}

// A private, dedicated CAS document makes identities, account/profile values and
// operation receipts atomic. It never addresses sporting/captain/media keys.
export function createPlayerS3Store({ env = process.env, s3, presign = getSignedUrl, now = Date.now } = {}) {
  const bucket = env.YCS_PLAYER_BUCKET || env.YCS_CAPTAIN_BUCKET || 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
  const configured = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !!(s3 || env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  let client = s3;
  const getClient = () => client ||= new S3Client({ region: 'ru-1', endpoint: 'https://s3.twcstorage.ru', maxAttempts: 1,
    // Timeweb's optional new AWS checksum extensions are not assumed. Intake
    // independently validates exact uploaded bytes against its signed SHA256.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  const send = async (command) => {
    if (!configured) playerFail('storage_not_configured', 503);
    return getClient().send(command, { abortSignal: AbortSignal.timeout(10_000) });
  };
  const get = async (key, max = MAX_STATE_BYTES) => {
    if (!key.startsWith(PLAYER_PREFIX)) playerFail('invalid_storage_key', 500);
    try { const o = await send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { body: await bytes(o.Body, o.ContentLength, max), etag: o.ETag, metadata: o.Metadata || {}, contentType: o.ContentType };
    } catch (e) { if (absent(e)) return null; if (e instanceof PlayerError) throw e; playerFail('storage_unavailable', 503); }
  };
  const read = async () => {
    const got = await get(`${PLAYER_PREFIX}state.json`);
    if (!got) return { value: empty(), etag: null };
    try { const value = JSON.parse(got.body.toString('utf8'));
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !['identities', 'accounts', 'sessions', 'attempts', 'assets', 'receipts'].every((k) => object(value[k])) || !got.etag) throw Error();
      return { value, etag: got.etag };
    } catch { playerFail('storage_unavailable', 503); }
  };
  const cas = async (prior, value) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) playerFail('storage_capacity_reached', 503);
    const put = (etag) => send(new PutObjectCommand({ Bucket: bucket, Key: `${PLAYER_PREFIX}state.json`, Body: body,
      ContentType: 'application/json; charset=utf-8', ACL: 'private', CacheControl: 'no-store',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }));
    try { try { await put(prior.etag); } catch (e) {
      if (precondition(e) && /^"[a-fA-F0-9]{32}"$/.test(prior.etag || '')) await put(prior.etag.slice(1, -1)); else throw e;
    } } catch (e) {
      if (precondition(e) || e.$metadata?.httpStatusCode === 409) return false;
      if (e instanceof PlayerError) throw e;
      // A timeout can occur after the effect. Caller must check durable receipt.
      playerFail('save_unknown', 503);
    }
    return true;
  };
  return { configured, read, get,
    async cleanupIntakeStaging({ key, owner, fingerprint }) {
      if (!/^private\/player-profiles\/v1\/staging\/[a-f0-9-]{36}\.jpg$/.test(key)) playerFail('invalid_storage_key', 500);
      if (!configured) return 'pending';
      // Best effort and bounded independently of the accepted final write.
      // No versionId, bucket lifecycle or retention policy is altered here.
      const abortSignal = AbortSignal.timeout(2000);
      const head = () => getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
      try {
        let staged;
        try { staged = await head(); } catch (error) { if (absent(error)) return 'deleted'; throw error; }
        if (staged.Metadata?.owner !== owner || staged.Metadata?.fingerprint !== fingerprint || typeof staged.ETag !== 'string' || !staged.ETag) return 'pending';
        await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: staged.ETag }), { abortSignal });
        try { await head(); return 'pending'; } catch (error) { if (absent(error)) return 'deleted'; throw error; }
      } catch { return 'pending'; }
    },
    async presignIntakeUpload({ key, size, metadata, expiresIn = 300 }) {
      if (!configured) playerFail('storage_not_configured', 503);
      if (!/^private\/player-profiles\/v1\/staging\/[a-f0-9-]{36}\.jpg$/.test(key) || !Number.isSafeInteger(size) || size < 1 || size > 10 * 1024 * 1024) playerFail('invalid_storage_key', 500);
      const headers = { 'Content-Type': 'image/jpeg', 'If-None-Match': '*', 'x-amz-acl': 'private',
        'x-amz-meta-owner': metadata.owner, 'x-amz-meta-fingerprint': metadata.fingerprint };
      try {
        const url = await presign(getClient(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/jpeg',
          ContentLength: size, ACL: 'private', IfNoneMatch: '*', Metadata: metadata }), { expiresIn, signingDate: new Date(now()),
          signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']),
          unhoistableHeaders: new Set(['x-amz-acl', 'x-amz-meta-owner', 'x-amz-meta-fingerprint']) });
        return { url, headers };
      } catch { playerFail('storage_unavailable', 503); }
    },
    async presignIntakeRead({ key, expiresIn = 60 }) {
      if (!configured) playerFail('storage_not_configured', 503);
      if (!key.startsWith(`${PLAYER_PREFIX}photos/`) || key.slice(`${PLAYER_PREFIX}photos/`.length).includes('/')) playerFail('invalid_storage_key', 500);
      try { return await presign(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key,
        ResponseContentType: 'image/jpeg', ResponseCacheControl: 'private, no-store', ResponseContentDisposition: 'inline' }), { expiresIn, signingDate: new Date(now()) }); }
      catch { playerFail('storage_unavailable', 503); }
    },
    async mutate(change) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const prior = await read(); const next = structuredClone(prior.value); const result = await change(next);
        if (result?.unchanged) return result.value;
        next.revision = prior.value.revision + 1;
        if (await cas(prior, next)) return result;
      }
      playerFail('version_conflict', 409);
    },
    async putNew(key, body, metadata = {}) {
      if (!key.startsWith(PLAYER_PREFIX)) playerFail('invalid_storage_key', 500);
      try { await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg', ACL: 'private',
        CacheControl: 'private, no-store', Metadata: metadata, IfNoneMatch: '*' })); return true;
      } catch (e) {
        if (precondition(e) || e.$metadata?.httpStatusCode === 409) return false;
        if (e instanceof PlayerError) throw e;
        // Resolve an ambiguous create using the operation fingerprint; never
        // overwrite another object's data or allocate a new suffix blindly.
        const got = await get(key, 10 * 1024 * 1024);
        if (got && got.metadata.fingerprint === metadata.fingerprint && got.metadata.owner === metadata.owner && digest(got.body) === digest(body)) return true;
        playerFail('save_unknown', 503);
      }
    },
  };
}

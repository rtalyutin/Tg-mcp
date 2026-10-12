import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mediaObject, validMediaClip } from '../src/lib/match-media.js';

export const MATCH_MEDIA_KEY = 'media/match-highlights-v1.json';
export const MATCH_MEDIA_BUCKET = 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
export const MATCH_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export class MatchMediaError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const mediaFail = (code, status) => { throw new MatchMediaError(code, status); };
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
export const emptyMatchMedia = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, clips: [], requests: {} });

export function validateMatchMediaDocument(value) {
  const invalid = () => mediaFail('media_storage_unavailable', 503);
  if (!mediaObject(value) || !only(value, ['schemaVersion', 'revision', 'updatedAt', 'clips', 'requests']) ||
      value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !(value.updatedAt === null && value.revision === 0 || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) ||
      !Array.isArray(value.clips) || value.clips.length > 2048 || !mediaObject(value.requests) || Object.keys(value.requests).length > 8192) invalid();
  const ids = new Set();
  for (const clip of value.clips) {
    if (!validMediaClip(clip) || !only(clip, ['id', 'tournamentId', 'matchId', 'mapKey', 'mapNumber', 'mapId', 'kind', 'url', 'title', 'startSeconds', 'endSeconds']) || ids.has(clip.id)) invalid();
    ids.add(clip.id);
  }
  for (const [id, receipt] of Object.entries(value.requests)) if (!/^[a-f0-9]{32}$/.test(id) || !mediaObject(receipt) ||
      !only(receipt, ['fingerprint', 'revision']) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > value.revision) invalid();
  return value;
}

async function bodyText(body, contentLength) {
  if (contentLength > MATCH_MEDIA_MAX_BYTES || !body?.[Symbol.asyncIterator]) mediaFail('media_storage_unavailable', 503);
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MATCH_MEDIA_MAX_BYTES) mediaFail('media_storage_unavailable', 503);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A dedicated public-safe document; this code never addresses captain or results keys.
export function createMatchMediaS3Store({ env = process.env, s3 } = {}) {
  const bucket = env.YCS_CAPTAIN_BUCKET || MATCH_MEDIA_BUCKET;
  const configured = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
    Boolean(s3 || env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  let client = s3;
  const getClient = () => client ||= new S3Client({ region: 'ru-1', endpoint: 'https://s3.twcstorage.ru', maxAttempts: 1,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  const read = async () => {
    if (!configured) mediaFail('media_not_configured', 503);
    try {
      const object = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: MATCH_MEDIA_KEY }), { abortSignal: AbortSignal.timeout(10_000) });
      if (typeof object.ETag !== 'string' || !object.ETag) mediaFail('media_storage_unavailable', 503);
      return { value: validateMatchMediaDocument(JSON.parse(await bodyText(object.Body, object.ContentLength))), etag: object.ETag };
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.name === 'NotFound' && error.$metadata?.httpStatusCode === 404) return { value: emptyMatchMedia(), etag: null };
      if (error instanceof MatchMediaError) throw error;
      mediaFail('media_storage_unavailable', 503);
    }
  };
  return { read, async compareAndSet(previous, value, requestId) {
    if (!configured) mediaFail('media_not_configured', 503);
    validateMatchMediaDocument(value);
    if (value.revision !== previous.value.revision + 1 || !value.requests[requestId]) mediaFail('media_invalid_request', 400);
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MATCH_MEDIA_MAX_BYTES) mediaFail('media_capacity_reached', 503);
    const hasReceipt = (saved) => saved.requests[requestId]?.fingerprint === value.requests[requestId].fingerprint;
    const precondition = (error) => error.$metadata?.httpStatusCode === 412 || error.$metadata?.httpStatusCode === undefined && error.name === 'PreconditionFailed';
    const bare = /^"[a-fA-F0-9]{32}"$/.test(previous.etag || '') ? previous.etag.slice(1, -1) : null;
    const put = (etag) => getClient().send(new PutObjectCommand({ Bucket: bucket, Key: MATCH_MEDIA_KEY, Body: body,
      ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store', ACL: 'private',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }), { abortSignal: AbortSignal.timeout(10_000) });
    try {
      try { await put(previous.etag); }
      catch (error) { if (!bare || !precondition(error)) throw error; await put(bare); }
    } catch (error) {
      if (precondition(error) || error.$metadata?.httpStatusCode === 409) mediaFail('media_conflict', 409);
      const recovered = await read();
      if (hasReceipt(recovered.value)) return recovered;
      mediaFail('media_save_unknown', 503);
    }
    const saved = await read();
    if (!hasReceipt(saved.value)) mediaFail('media_save_unknown', 503);
    return saved;
  } };
}

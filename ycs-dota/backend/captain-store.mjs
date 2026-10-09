import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CaptainError, fail } from './captain-auth.mjs';

export const CAPTAIN_TOURNAMENT_ID = 'dota2-autumn-2026';
export const CAPTAIN_STATE_KEY = `captains/${CAPTAIN_TOURNAMENT_ID}.json`;
export const CAPTAIN_MAX_BYTES = 8 * 1024 * 1024;
export const CAPTAIN_BUCKET = 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
export const CAPTAIN_ENVELOPE_MAX_BYTES = Math.ceil(CAPTAIN_MAX_BYTES / 3) * 4 + 256;
const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeInt = (v) => Number.isSafeInteger(v) && v >= 0;
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const array = (v) => Array.isArray(v);
const team = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(v);
const itemId = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const score = (v) => array(v) && v.length === 2 && v.every(safeInt);
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

export const emptyCaptainState = () => ({ schemaVersion: 3, tournamentId: CAPTAIN_TOURNAMENT_ID,
  revision: 0, bindings: {}, matches: {}, requests: {}, history: [] });

// A corrupt or incompatible object must never be treated as an empty registry.
export function validateCaptainState(value) {
  const invalid = () => fail('storage_unavailable', 503);
  if (!object(value) || !only(value, ['schemaVersion', 'tournamentId', 'revision', 'bindings', 'matches', 'requests', 'history']) ||
    value.schemaVersion !== 3 || value.tournamentId !== CAPTAIN_TOURNAMENT_ID || !safeInt(value.revision) ||
    !object(value.bindings) || !object(value.matches) || !object(value.requests) || !array(value.history)) invalid();
  const users = new Set(), usernames = new Set();
  for (const [teamId, b] of Object.entries(value.bindings)) {
    if (!team(teamId) || !object(b) || !only(b, ['username', 'userId', 'generation']) || !/^[a-z0-9_]{1,32}$/.test(b.username || '') ||
      (b.userId !== null && !/^[1-9]\d{0,19}$/.test(b.userId)) || !itemId(b.generation)) invalid();
    if (usernames.has(b.username) || (b.userId && users.has(b.userId))) invalid();
    usernames.add(b.username); if (b.userId) users.add(b.userId);
  }
  for (const [matchId, m] of Object.entries(value.matches)) {
    if (!team(matchId) || !object(m) || !only(m, ['scheduleVersion', 'proposal', 'agreed', 'resultClaims', 'chat', 'chatClosed']) ||
      typeof m.chatClosed !== 'boolean' || !safeInt(m.scheduleVersion) || !array(m.resultClaims) ||
      (m.proposal !== null && (!object(m.proposal) || !only(m.proposal, ['startsAt', 'confirmedTeamIds']) || !instant(m.proposal.startsAt) || !array(m.proposal.confirmedTeamIds) ||
        m.proposal.confirmedTeamIds.length < 1 || m.proposal.confirmedTeamIds.length > 2 ||
        !m.proposal.confirmedTeamIds.every(team) || new Set(m.proposal.confirmedTeamIds).size !== m.proposal.confirmedTeamIds.length)) ||
      (m.agreed !== null && (!object(m.agreed) || !only(m.agreed, ['startsAt', 'agreedAt']) || !instant(m.agreed.startsAt) || !instant(m.agreed.agreedAt)))) invalid();
    for (const entry of m.resultClaims) if (!object(entry) || !only(entry, ['id', 'teamId', 'score', 'comment', 'createdAt']) ||
      !itemId(entry.id) || !team(entry.teamId) || !instant(entry.createdAt) ||
      !score(entry.score) || typeof entry.comment !== 'string' || entry.comment.length > 1000) invalid();
    if (m.chatClosed && m.chat !== null) invalid();
    if (m.chat !== null) {
      const c = m.chat;
      if (!object(c) || !only(c, ['epoch', 'participants', 'generations', 'messages']) || !itemId(c.epoch) ||
        !array(c.participants) || c.participants.length !== 2 || !c.participants.every(team) || c.participants[0] === c.participants[1] ||
        !array(c.generations) || c.generations.length !== 2 || !c.generations.every((g) => g === null || itemId(g)) || !array(c.messages)) invalid();
      const ids = new Set();
      for (const entry of c.messages) {
        if (!object(entry) || !only(entry, ['id', 'teamId', 'text', 'createdAt']) || !itemId(entry.id) ||
          !c.participants.includes(entry.teamId) || !instant(entry.createdAt) || typeof entry.text !== 'string' ||
          !entry.text.trim() || entry.text.length > 2000 || entry.text.includes('\0') || ids.has(entry.id)) invalid();
        ids.add(entry.id);
      }
    }
  }
  for (const [key, entry] of Object.entries(value.requests)) if (!itemId(key) || !object(entry) ||
    !only(entry, ['fingerprint', 'action', 'matchId']) || !['message', 'agree', 'result', 'assignment'].includes(entry.action) || !itemId(entry.fingerprint) ||
    (entry.action === 'message' && (!team(entry.matchId) || !value.matches[entry.matchId]?.chat || value.matches[entry.matchId].chatClosed))) invalid();
  for (const event of value.history) if (!object(event) || !itemId(event.id) || !instant(event.at) ||
    !['identity_linked', 'agree', 'result', 'captain_assigned', 'captain_revoked', 'chat_opened', 'chat_reset', 'message', 'matches_closed'].includes(event.kind) ||
    !only(event, ['id', 'at', 'kind', 'teamId', 'matchId', 'actorUserId', 'bindingGeneration', 'startsAt', 'scheduleVersion',
      'confirmedTeamIds', 'previousGeneration', 'nextGeneration', 'matchIds']) ||
    (['chat_opened', 'chat_reset', 'message'].includes(event.kind) && (!team(event.matchId) || !value.matches[event.matchId]?.chat || value.matches[event.matchId].chatClosed))) invalid();
  return value;
}

async function boundedBody(body, length) {
  if (length > CAPTAIN_ENVELOPE_MAX_BYTES) fail('capacity_reached', 503);
  if (!body || !body[Symbol.asyncIterator]) fail('storage_unavailable', 503);
  const chunks = []; let bytes = 0;
  for await (const chunk of body) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > CAPTAIN_ENVELOPE_MAX_BYTES) { body.destroy?.(); fail('capacity_reached', 503); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createCaptainS3Store({ env = process.env, s3 } = {}) {
  const bucket = env.YCS_CAPTAIN_BUCKET || CAPTAIN_BUCKET;
  const configured = typeof bucket === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
    typeof env.YCS_CAPTAIN_ENCRYPTION_KEY === 'string' && /^[a-fA-F0-9]{64}$/.test(env.YCS_CAPTAIN_ENCRYPTION_KEY);
  const key = configured ? Buffer.from(env.YCS_CAPTAIN_ENCRYPTION_KEY, 'hex') : null;
  // JSON array fixes boundaries between every context field. Moving ciphertext
  // to a different bucket/key/tournament/version cannot authenticate there.
  const aad = Buffer.from(JSON.stringify(['ycs-captain-state', bucket, CAPTAIN_STATE_KEY, CAPTAIN_TOURNAMENT_ID, ENVELOPE_VERSION, ALGORITHM]));
  const encrypt = (clear) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    return JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, algorithm: ALGORITHM,
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  };
  const decrypt = (body) => {
    const envelope = JSON.parse(body);
    if (!object(envelope) || !only(envelope, ['envelopeVersion', 'algorithm', 'nonce', 'tag', 'ciphertext']) ||
      envelope.envelopeVersion !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) fail('storage_unavailable', 503);
    const decode = (value) => {
      if (typeof value !== 'string' || !value.length) fail('storage_unavailable', 503);
      const buffer = Buffer.from(value, 'base64');
      if (buffer.toString('base64') !== value) fail('storage_unavailable', 503);
      return buffer;
    };
    const nonce = decode(envelope.nonce), tag = decode(envelope.tag), ciphertext = decode(envelope.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16) fail('storage_unavailable', 503);
    if (ciphertext.length > CAPTAIN_MAX_BYTES) fail('capacity_reached', 503);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validateCaptainState(JSON.parse(clear.toString('utf8')));
  };
  let client = s3;
  const getClient = () => client ||= new S3Client({ region: 'ru-1', endpoint: 'https://s3.twcstorage.ru', maxAttempts: 1 });
  const read = async () => {
    if (!configured) fail('captain_not_configured', 503);
    try {
      const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: CAPTAIN_STATE_KEY }), { abortSignal: AbortSignal.timeout(10_000) });
      if (typeof result.ETag !== 'string' || !result.ETag) fail('storage_unavailable', 503);
      return { value: decrypt(await boundedBody(result.Body, result.ContentLength)), etag: result.ETag };
    } catch (error) {
      if (error.name === 'NoSuchKey' || (error.name === 'NotFound' && error.$metadata?.httpStatusCode === 404)) return { value: emptyCaptainState(), etag: null };
      if (error instanceof CaptainError) throw error;
      fail('storage_unavailable', 503);
    }
  };
  return { read, async compareAndSet(previous, value, mutationId) {
    if (!configured) fail('captain_not_configured', 503);
    validateCaptainState(value);
    const clear = Buffer.from(JSON.stringify(value));
    if (clear.length > CAPTAIN_MAX_BYTES) fail('capacity_reached', 503);
    const body = encrypt(clear);
    const intendedEvent = value.history.find((entry) => entry.id === mutationId);
    const committedOrClosed = (saved) => saved.history.some((entry) => entry.id === mutationId) ||
      // A concurrent official finish may already have purged this message's
      // receipt. Return the durable closure so the service rejects the send.
      (['chat_opened', 'chat_reset', 'message'].includes(intendedEvent?.kind) && saved.matches[intendedEvent.matchId]?.chatClosed === true);
    const preconditionFailed = (error) => error.$metadata?.httpStatusCode === 412 ||
      (error.$metadata?.httpStatusCode === undefined && error.name === 'PreconditionFailed');
    // Some S3-compatible providers compare the bare MD5 token while GET returns
    // a quoted ETag. Retry that representation only: never replace the expected
    // version with a wildcard, a fresh ETag, or an unconditional write.
    const bareEtag = /^"[a-fA-F0-9]{32}"$/.test(previous.etag || '') ? previous.etag.slice(1, -1) : null;
    let compatibilityRetried = false;
    const put = (etag) => getClient().send(new PutObjectCommand({ Bucket: bucket, Key: CAPTAIN_STATE_KEY, Body: body,
      ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store', ACL: 'private',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }), { abortSignal: AbortSignal.timeout(10_000) });
    try {
      try { await put(previous.etag); }
      catch (error) {
        if (!bareEtag || !preconditionFailed(error)) throw error;
        compatibilityRetried = true;
        await put(bareEtag);
      }
    } catch (error) {
      if (preconditionFailed(error) || error.$metadata?.httpStatusCode === 409) {
        const conflict = new CaptainError('storage_conflict', 409);
        conflict.storageConflict = { httpStatus: error.$metadata?.httpStatusCode === 409 ? 409 : 412,
          condition: previous.etag ? 'if-match' : 'if-none-match',
          etagFormat: compatibilityRetried ? 'bare' : bareEtag ? 'quoted' : previous.etag ? 'other' : 'absent', compatibilityRetried };
        throw conflict;
      }
      // A timed-out PUT may have committed. A later writer may already have
      // advanced it, so compare a retained commit receipt, not only full JSON.
      const recovered = await read();
      if (committedOrClosed(recovered.value)) return recovered;
      fail('storage_unavailable', 503);
    }
    const saved = await read();
    if (!committedOrClosed(saved.value)) fail('storage_unavailable', 503);
    return saved;
  } };
}

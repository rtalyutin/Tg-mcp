import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { onlyKeys, UUID, playerFail, photoBasename, resolvePlayerDiscipline } from './player-profile-config.mjs';
import { digest, PLAYER_PREFIX } from './player-profile-store.mjs';
import { processPlayerPhoto } from './player-profile-service.mjs';

export const INTAKE_TTL = Object.freeze({ upload: 300, ticket: 900, read: 60 });
const PURPOSE = 'ycs:anonymous-player-intake:v1';
const hexHash = /^[a-f0-9]{64}$/;
const validText = (value) => typeof value === 'string' && !/[\p{Cc}\p{Cs}]/u.test(value);
const unchanged = (value) => ({ unchanged: true, value });

export function createPlayerIntake({ env = process.env, config, store, now = Date.now } = {}) {
  const enabled = env.YCS_PLAYER_INTAKE_ENABLED === 'true' && config.configValid && !!config.origin && store.configured &&
    !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY;
  const derive = (purpose, value) => createHmac('sha256', env.AWS_SECRET_ACCESS_KEY || '').update(`${PURPOSE}:${purpose}\0`).update(value).digest();
  const key = derive('ticket-encryption-key', '');
  const ready = () => { if (!enabled) playerFail('player_intake_not_configured', 503); };
  const validate = (body) => {
    if (!onlyKeys(body, ['requestId', 'Dis', 'name', 'nickname', 'sha256', 'size', 'contentType']) || !UUID.test(body.requestId || '')) playerFail('validation_failed', 422);
    resolvePlayerDiscipline(config, body.Dis);
    if (body.contentType !== 'image/jpeg') playerFail('unsupported_content_type', 415);
    if (!Number.isSafeInteger(body.size) || body.size < 1) playerFail('validation_failed', 422, { photo: 'invalid_size' });
    if (body.size > config.photo.maxBytes) playerFail('file_too_large', 413);
    if (typeof body.sha256 !== 'string' || !hexHash.test(body.sha256)) playerFail('validation_failed', 422, { photo: 'invalid_sha256' });
    const cleanText = (value, field, max, required) => {
      if (!required && (value === undefined || value === null)) return null;
      if (!validText(value)) playerFail('validation_failed', 422, { [field]: 'invalid' });
      const cleaned = value.normalize('NFC').trim();
      if (required && !cleaned) playerFail('validation_failed', 422, { [field]: 'required' });
      if ([...cleaned].length > max) playerFail('validation_failed', 422, { [field]: 'too_long' });
      return cleaned || null;
    };
    const input = { requestId: body.requestId, Dis: body.Dis, name: cleanText(body.name, 'name', 200, false),
      nickname: cleanText(body.nickname, 'nickname', 64, true), sha256: body.sha256, size: body.size, contentType: 'image/jpeg' };
    if (Buffer.byteLength(photoBasename(input.name, input.nickname)) > 900) playerFail('validation_failed', 422, { name: 'filename_too_long' });
    return input;
  };
  const identity = (input) => {
    const fingerprint = derive('immutable-input', JSON.stringify(input)).toString('hex');
    const bytes = Buffer.from(fingerprint.slice(0, 32), 'hex'); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = bytes.toString('hex'); const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { id, fingerprint, key: `${PLAYER_PREFIX}staging/${id}.jpg`, owner: `intake:${id}` };
  };
  const seal = (payload) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(PURPOSE));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return `i1.${iv.toString('base64url')}.${bytes.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  };
  const open = (ticket) => {
    if (typeof ticket !== 'string' || ticket.length > 8192 || !/^i1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(ticket)) playerFail('invalid_ticket', 401);
    let payload;
    try {
      const [, nonce, value, tag] = ticket.split('.'); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      if ([nonce, value, tag].some((part) => Buffer.from(part, 'base64url').toString('base64url') !== part)) playerFail('invalid_ticket', 401);
      decipher.setAAD(Buffer.from(PURPOSE)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64url')), decipher.final()]).toString('utf8'));
    } catch { playerFail('invalid_ticket', 401); }
    if (!onlyKeys(payload, ['input', 'id', 'fingerprint', 'key', 'issuedAt', 'expiresAt']) || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt > now() + 30_000 || payload.expiresAt !== payload.issuedAt + INTAKE_TTL.ticket * 1000) playerFail('invalid_ticket', 401);
    if (payload.expiresAt <= now()) playerFail('ticket_expired', 410);
    const input = validate(payload.input); const expected = identity(input);
    if (payload.id !== expected.id || payload.fingerprint !== expected.fingerprint || payload.key !== expected.key) playerFail('invalid_ticket', 401);
    return { ...expected, input };
  };
  const validateRecord = (record, flow) => {
    const photo = record?.photo; const base = photoBasename(flow.input.name, flow.input.nickname);
    if (record?.kind !== 'anonymous_intake' || !['pending', 'finalized'].includes(record.status) || record.fingerprint !== flow.fingerprint || !photo || typeof photo.filename !== 'string' ||
      !(photo.filename === `${base}.jpg` || photo.filename.startsWith(`${base}-`) && /^\d+\.jpg$/.test(photo.filename.slice(base.length + 1))) ||
      photo.key !== `${PLAYER_PREFIX}photos/${photo.filename}` || !hexHash.test(photo.sha256 || '') || !Number.isSafeInteger(photo.size) || photo.size < 1 || photo.size > config.photo.maxBytes) playerFail('storage_unavailable', 503);
    return photo;
  };
  const hasFinal = async (record, flow, allowMissing = false) => {
    const photo = validateRecord(record, flow);
    const actual = await store.get(photo.key, config.photo.maxBytes);
    if (!actual || actual.metadata.owner !== flow.owner || actual.metadata.fingerprint !== flow.fingerprint) {
      if (allowMissing) return false;
      playerFail('storage_unavailable', 503);
    }
    if (actual.contentType !== 'image/jpeg' || actual.metadata['source-sha256'] !== flow.input.sha256 || actual.body.length !== photo.size || digest(actual.body) !== photo.sha256) playerFail('storage_unavailable', 503);
    return true;
  };
  const persist = async (record, flow, receiptId) => {
    try {
      return await store.mutate((state) => {
        if (state.receipts[receiptId]) {
          validateRecord(state.receipts[receiptId], flow);
          if (state.receipts[receiptId].status === 'finalized') return unchanged(state.receipts[receiptId]);
        }
        state.receipts[receiptId] = record; return record;
      });
    } catch (error) {
      if (error.code !== 'save_unknown') throw error;
      const recovered = (await store.read()).value.receipts[receiptId];
      if (recovered) {
        validateRecord(recovered, flow);
        if (recovered.status === 'finalized' || recovered.status === record.status && recovered.photo.key === record.photo.key && recovered.photo.sha256 === record.photo.sha256) return recovered;
      }
      throw error;
    }
  };
  const verifyFinal = async (record, flow) => {
    if (record.status !== 'finalized') playerFail('save_unknown', 503);
    await hasFinal(record, flow);
    const photo = record.photo;
    const result = { status: 'finalized', requestId: flow.input.requestId, photo: { filename: photo.filename, sha256: photo.sha256, size: photo.size,
      contentType: 'image/jpeg', width: config.photo.size, height: config.photo.size,
      readUrl: await store.presignIntakeRead({ key: photo.key, expiresIn: INTAKE_TTL.read }), readExpiresAt: new Date(now() + INTAKE_TTL.read * 1000).toISOString() } };
    result.stagingCleanup = await store.cleanupIntakeStaging({ key: flow.key, owner: flow.owner, fingerprint: flow.fingerprint });
    return result;
  };
  return { enabled,
    context(code) { return { mode: 'anonymous-direct-s3', available: enabled, discipline: resolvePlayerDiscipline(config, code), photo: { ...config.photo, formats: ['image/jpeg'], derivativeMaxPixels: config.photo.size ** 2 },
      uploadTtlSeconds: INTAKE_TTL.upload, ticketTtlSeconds: INTAKE_TTL.ticket, readTtlSeconds: INTAKE_TTL.read }; },
    async prepare(body) {
      ready(); const input = validate(body); const flow = identity(input); const issuedAt = now();
      const upload = await store.presignIntakeUpload({ key: flow.key, size: input.size, metadata: { owner: flow.owner, fingerprint: flow.fingerprint }, expiresIn: INTAKE_TTL.upload });
      return { requestId: input.requestId, ticket: seal({ input, id: flow.id, fingerprint: flow.fingerprint, key: flow.key, issuedAt, expiresAt: issuedAt + INTAKE_TTL.ticket * 1000 }),
        ticketExpiresAt: new Date(issuedAt + INTAKE_TTL.ticket * 1000).toISOString(), upload: { method: 'PUT', ...upload, expiresAt: new Date(issuedAt + INTAKE_TTL.upload * 1000).toISOString() } };
    },
    async complete(body) {
      ready(); if (!onlyKeys(body, ['ticket'])) playerFail('validation_failed', 422);
      const flow = open(body.ticket); const receiptId = `intake:${flow.fingerprint}`;
      const recover = async (record) => {
        validateRecord(record, flow);
        if (record.status === 'finalized') return verifyFinal(record, flow);
        if (await hasFinal(record, flow, true)) return verifyFinal(await persist({ ...record, status: 'finalized', completedAt: new Date(now()).toISOString() }, flow, receiptId), flow);
        return null;
      };
      const existing = (await store.read()).value.receipts[receiptId];
      if (existing) { const result = await recover(existing); if (result) return result; }
      const upload = await store.get(flow.key, config.photo.maxBytes);
      if (!upload) {
        // Another completion may have committed and removed staging after our
        // first state read. Never tell that caller to upload a second time.
        const latest = (await store.read()).value.receipts[receiptId];
        if (latest) { const result = await recover(latest); if (result) return result; }
        playerFail('upload_not_found', 409);
      }
      if (upload.metadata.owner !== flow.owner || upload.metadata.fingerprint !== flow.fingerprint || upload.contentType !== 'image/jpeg' ||
        upload.body.length !== flow.input.size || digest(upload.body) !== flow.input.sha256) playerFail('upload_mismatch', 422);
      const photo = await processPlayerPhoto(upload.body, { contentType: 'image/jpeg', limits: { ...config.photo, maxPixels: config.photo.size ** 2 } });
      const sha256 = digest(photo.body); const base = photoBasename(flow.input.name, flow.input.nickname);
      for (let suffix = 0; suffix < 10000; suffix++) {
        const filename = `${base}${suffix ? `-${suffix}` : ''}.jpg`; const key = `${PLAYER_PREFIX}photos/${filename}`;
        // Persist the exact candidate and expected processed bytes before its
        // external effect. Recovery never has to scan other players' names.
        const pending = { kind: 'anonymous_intake', status: 'pending', fingerprint: flow.fingerprint, requestId: flow.input.requestId, input: flow.input,
          photo: { key, filename, sha256, size: photo.body.length } };
        const savedIntent = await persist(pending, flow, receiptId);
        if (savedIntent.status === 'finalized') return verifyFinal(savedIntent, flow);
        if (await store.putNew(key, photo.body, { owner: flow.owner, fingerprint: flow.fingerprint, 'source-sha256': flow.input.sha256 })) {
          return verifyFinal(await persist({ ...pending, status: 'finalized', completedAt: new Date(now()).toISOString() }, flow, receiptId), flow);
        }
        const occupied = await store.get(key, config.photo.maxBytes);
        if (occupied?.metadata.owner === flow.owner && occupied.metadata.fingerprint === flow.fingerprint) {
          if (!await hasFinal(pending, flow)) playerFail('storage_unavailable', 503);
          return verifyFinal(await persist({ ...pending, status: 'finalized', completedAt: new Date(now()).toISOString() }, flow, receiptId), flow);
        }
      }
      playerFail('filename_capacity_reached', 503);
    },
  };
}

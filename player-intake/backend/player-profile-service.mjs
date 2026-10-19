import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PLAYER_BASE, UUID, onlyKeys, object, playerFail, photoBasename, resolvePlayerDiscipline } from './player-profile-config.mjs';
import { PLAYER_PREFIX, digest } from './player-profile-store.mjs';

const stable = (value) => JSON.stringify(value, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
const typed = (value, type = 'string') => ({ type, value });
const values = (parameters = {}) => Object.fromEntries(Object.entries(parameters).map(([key, entry]) => [key, entry.value]));
const validText = (v) => typeof v === 'string' && !/[\p{Cc}\p{Cs}]/u.test(v);

export async function processPlayerPhoto(input, { limits, crop, contentType } = {}) {
  if (!Buffer.isBuffer(input) || !input.length) playerFail('unsupported_image', 415);
  if (input.length > limits.maxBytes) playerFail('file_too_large', 413);
  try {
    const image = sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'warning', animated: false });
    const m = await image.metadata();
    const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[m.format];
    if (!mime || contentType !== mime || (m.pages || 1) !== 1 || !m.width || !m.height || m.width * m.height > limits.maxPixels) playerFail('unsupported_image', 415);
    let pipeline = image.autoOrient();
    if (crop !== undefined) {
      if (!onlyKeys(crop, ['rotation', 'left', 'top', 'width', 'height']) || ![0, 90, 180, 270].includes(crop.rotation) ||
        !['left', 'top', 'width', 'height'].every((k) => Number.isSafeInteger(crop[k])) || crop.left < 0 || crop.top < 0 || crop.width < 1 || crop.width !== crop.height) playerFail('validation_failed', 422, { photo: 'invalid_crop' });
      // Materialise rotation before extract: coordinates refer to oriented pixels.
      const { data, info } = await pipeline.rotate(crop.rotation).raw().toBuffer({ resolveWithObject: true });
      if (crop.left + crop.width > info.width || crop.top + crop.height > info.height) playerFail('validation_failed', 422, { photo: 'invalid_crop' });
      pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height });
    }
    // Sharp strips EXIF/GPS/XMP/ICC by default. Original bytes are never stored.
    const body = await pipeline.resize(limits.size, limits.size, { fit: 'cover', position: 'centre' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    return { body, width: limits.size, height: limits.size, contentType: 'image/jpeg', extension: 'jpg' };
  } catch (e) { if (e.code && e.status) throw e; playerFail('unsupported_image', 415); }
}

export function createPlayerProfileService({ config, store, now = Date.now }) {
  const presentation = (account, code) => {
    const p = account?.profile;
    return { playerId: p?.id || null, version: p?.version ?? null,
      profile: p ? { ...values(p.parameters), photoAssetId: p.photoAssetId, photoUrl: `${PLAYER_BASE}/photos/${p.photoAssetId}`, photoFilename: p.photoFilename } : null,
      discipline: { code, roleIds: [], gameAccount: null, ...values(p?.disciplines?.[code]?.parameters) }, usagePermissions: p?.usagePermissions || [] };
  };
  const ownAccount = (state, ownerId, sid) => {
    const session = state.sessions[sid];
    if (!session || session.ownerId !== ownerId || session.expires <= now() || !state.accounts[ownerId]) playerFail('unauthenticated', 401);
    return state.accounts[ownerId];
  };
  return {
    read(sess, code) { resolvePlayerDiscipline(config, code); return presentation(ownAccount(sess.state, sess.ownerId, sess.sid), code); },
    async photo(sess, assetId) {
      if (!UUID.test(assetId)) playerFail('photo_not_found', 404);
      ownAccount(sess.state, sess.ownerId, sess.sid);
      const asset = sess.state.assets[assetId]; if (!asset || asset.ownerId !== sess.ownerId) playerFail('photo_not_found', 404);
      const stored = await store.get(asset.finalKey || asset.key, config.photo.maxBytes);
      if (!stored || digest(stored.body) !== asset.sha256) playerFail('storage_unavailable', 503);
      return { body: stored.body, contentType: 'image/jpeg' };
    },
    async upload(sess, input, options = {}) {
      ownAccount(sess.state, sess.ownerId, sess.sid);
      if (Object.values(sess.state.assets).filter((a) => a.ownerId === sess.ownerId && !a.finalKey).length >= 30) playerFail('photo_staging_limit', 429);
      const processed = await processPlayerPhoto(input, { ...options, limits: config.photo });
      const id = randomUUID(); const key = `${PLAYER_PREFIX}staging/${id}.jpg`; const sha256 = digest(processed.body);
      if (!await store.putNew(key, processed.body, { owner: sess.ownerId, fingerprint: id })) playerFail('storage_unavailable', 503);
      await store.mutate((state) => {
        ownAccount(state, sess.ownerId, sess.sid);
        const stagedCount = Object.values(state.assets).filter((a) => a.ownerId === sess.ownerId && !a.finalKey).length;
        if (stagedCount >= 30) playerFail('photo_staging_limit', 429);
        state.assets[id] = { id, ownerId: sess.ownerId, key, sha256, createdAt: new Date(now()).toISOString(),
          width: processed.width, height: processed.height, contentType: processed.contentType };
      });
      return { assetId: id, previewUrl: `${PLAYER_BASE}/photos/${id}` };
    },
    async save(sess, body) {
      if (!onlyKeys(body, ['requestId', 'expectedVersion', 'disciplineCode', 'profile', 'discipline', 'usagePermissions']) || !UUID.test(body.requestId || '') ||
        !(body.expectedVersion === null || Number.isSafeInteger(body.expectedVersion) && body.expectedVersion > 0)) playerFail('validation_failed', 422);
      const context = resolvePlayerDiscipline(config, body.disciplineCode);
      const allowed = config.fields.map((f) => f.id);
      if (!onlyKeys(body.profile, [...allowed, 'photoAssetId']) || body.discipline !== undefined && !onlyKeys(body.discipline, ['roleIds', 'gameAccount'])) playerFail('validation_failed', 422);
      const fingerprint = digest(stable(body)); const receiptId = `${sess.ownerId}:${body.requestId}`;
      const execute = async (state) => {
        const account = ownAccount(state, sess.ownerId, sess.sid); const previous = account.profile;
        const receipt = state.receipts[receiptId];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) playerFail('idempotency_conflict', 409);
          return { unchanged: true, value: receipt.result };
        }
        if ((previous?.version ?? null) !== body.expectedVersion) playerFail('version_conflict', 409);
        const parameters = structuredClone(previous?.parameters || {});
        for (const f of config.fields) {
          if (!Object.hasOwn(body.profile, f.id)) {
            if (f.required && !parameters[f.id]?.value) playerFail('validation_failed', 422, { [f.id]: 'required' });
            continue;
          }
          let value = body.profile[f.id];
          if (value !== null && !validText(value)) playerFail('validation_failed', 422, { [f.id]: 'invalid' });
          value = value === null ? null : value.normalize('NFC').trim() || null;
          if (f.required && !value) playerFail('validation_failed', 422, { [f.id]: 'required' });
          if (value && [...value].length > f.maxLength) playerFail('validation_failed', 422, { [f.id]: 'too_long' });
          parameters[f.id] = typed(value);
        }
        const photoAssetId = Object.hasOwn(body.profile, 'photoAssetId') ? body.profile.photoAssetId : previous?.photoAssetId;
        if (!UUID.test(photoAssetId || '')) playerFail('validation_failed', 422, { photo: 'required' });
        const asset = state.assets[photoAssetId];
        if (!asset || asset.ownerId !== sess.ownerId) playerFail('photo_not_found', 404);
        const discipline = body.discipline || {}; const disciplines = structuredClone(previous?.disciplines || {});
        const discParameters = structuredClone(disciplines[context.code]?.parameters || { roleIds: typed([], 'string[]'), gameAccount: typed(null, 'steam') });
        if (Object.hasOwn(discipline, 'roleIds')) {
          const ids = discipline.roleIds;
          if (!Array.isArray(ids) || ids.length > context.roles.length || new Set(ids).size !== ids.length || ids.some((id) => !context.roles.some((r) => r.id === id))) playerFail('validation_failed', 422, { roleIds: 'invalid' });
          discParameters.roleIds = typed(ids, 'string[]');
        }
        if (Object.hasOwn(discipline, 'gameAccount')) {
          const game = discipline.gameAccount;
          if (game !== null && (!onlyKeys(game, ['platform', 'identifier']) || game.platform !== 'steam' || typeof game.identifier !== 'string' || !/^7656119\d{10}$/.test(game.identifier))) playerFail('validation_failed', 422, { gameAccount: 'invalid' });
          discParameters.gameAccount = typed(game === null ? null : { ...game, verification: 'self_declared' }, 'steam');
        }
        disciplines[context.code] = { disciplineId: context.id, parameters: discParameters };
        let usagePermissions = structuredClone(previous?.usagePermissions || []);
        if (body.usagePermissions !== undefined) {
          if (!Array.isArray(body.usagePermissions) || body.usagePermissions.length > config.permissions.length || body.usagePermissions.some((p) => !object(p)) || new Set(body.usagePermissions.map((p) => p.purpose)).size !== body.usagePermissions.length) playerFail('validation_failed', 422);
          for (const permission of body.usagePermissions) {
            if (!onlyKeys(permission, ['purpose', 'allowed', 'textVersion']) || typeof permission.allowed !== 'boolean') playerFail('validation_failed', 422);
            const registered = config.permissions.find((p) => p.purpose === permission.purpose);
            if (!registered || registered.textVersion !== permission.textVersion) playerFail('permission_text_outdated', 409);
            usagePermissions = usagePermissions.filter((p) => p.purpose !== permission.purpose);
            usagePermissions.push({ ...permission, fields: registered.fields, decidedAt: new Date(now()).toISOString() });
          }
        }
        // Reserve the exact Unicode filename with conditional object creation.
        // New content never overwrites an object referenced by a previous version.
        const base = photoBasename(parameters.name?.value, parameters.nickname.value);
        if (Buffer.byteLength(base) > 900) playerFail('validation_failed', 422, { name: 'filename_too_long' });
        let filename = previous?.photoFilename;
        if (!filename || photoAssetId !== previous.photoAssetId || previous.filenameBase !== base) {
          const image = await store.get(asset.key, config.photo.maxBytes);
          if (!image || digest(image.body) !== asset.sha256) playerFail('storage_unavailable', 503);
          let key;
          for (let n = 0; n < 10000; n++) {
            filename = `${base}${n ? `-${n}` : ''}.jpg`; key = `${PLAYER_PREFIX}photos/${filename}`;
            const reserved = await store.putNew(key, image.body, { owner: sess.ownerId, fingerprint });
            if (reserved) break;
            const occupied = await store.get(key, config.photo.maxBytes);
            if (occupied?.metadata.owner === sess.ownerId && occupied.metadata.fingerprint === fingerprint && digest(occupied.body) === asset.sha256) break;
            key = null;
          }
          if (!key) playerFail('filename_capacity_reached', 503);
          asset.finalKey = key;
        }
        account.profile = { id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1, parameters, disciplines,
          photoAssetId, photoFilename: filename, filenameBase: base, usagePermissions, updatedAt: new Date(now()).toISOString() };
        const result = { requestId: body.requestId, ...presentation(account, context.code) };
        state.receipts[receiptId] = { fingerprint, result, committedAt: now() };
        return result;
      };
      try { return await store.mutate(execute); }
      catch (e) {
        if (e.code !== 'save_unknown') throw e;
        const recovered = (await store.read()).value; ownAccount(recovered, sess.ownerId, sess.sid);
        const receipt = recovered.receipts[receiptId];
        if (receipt?.fingerprint === fingerprint) return receipt.result;
        throw e;
      }
    },
    operation(sess, id) {
      if (!UUID.test(id)) playerFail('validation_failed', 422);
      ownAccount(sess.state, sess.ownerId, sess.sid);
      const receipt = sess.state.receipts[`${sess.ownerId}:${id}`];
      return receipt ? { status: 'committed', requestId: id, version: receipt.result.version } : { status: 'not_found', requestId: id };
    },
  };
}

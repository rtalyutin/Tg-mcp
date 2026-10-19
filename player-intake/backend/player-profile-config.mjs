export const PLAYER_BASE = '/api/player/v1';
import { DEFAULT_PLAYER_DISCIPLINES, PHOTO_LIMITS, PLAYER_FIELDS } from '../src/lib/player-profile-catalog.js';
export { PHOTO_LIMITS, PLAYER_FIELDS } from '../src/lib/player-profile-catalog.js';
export class PlayerError extends Error {
  constructor(code, status = 400, fields) { super(code); this.name = 'PlayerError'; this.code = code; this.status = status; this.fields = fields; }
}
export const playerFail = (code, status, fields) => { throw new PlayerError(code, status, fields); };
export const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const onlyKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function playerConfig(env = process.env) {
  let origin = null;
  try { const u = new URL(env.YCS_PLAYER_ORIGIN); if (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) origin = u.origin; } catch {}
  const positive = (key, fallback, max) => /^\d+$/.test(env[key] || '') && Number(env[key]) > 0 && Number(env[key]) <= max ? Number(env[key]) : fallback;
  let disciplines = structuredClone(DEFAULT_PLAYER_DISCIPLINES);
  let extraFields = [], permissions = [], configValid = true;
  try {
    if (env.YCS_PLAYER_DISCIPLINES_JSON) disciplines = JSON.parse(env.YCS_PLAYER_DISCIPLINES_JSON);
    if (env.YCS_PLAYER_FIELDS_JSON) extraFields = JSON.parse(env.YCS_PLAYER_FIELDS_JSON);
    if (env.YCS_PLAYER_PERMISSIONS_JSON) permissions = JSON.parse(env.YCS_PLAYER_PERMISSIONS_JSON);
    if (!Array.isArray(disciplines) || !disciplines.length || disciplines.length > 20 || disciplines.some((d) =>
      !onlyKeys(d, ['code', 'id', 'label', 'roles']) || !/^[a-z0-9_-]{1,32}$/.test(d.code) || !/^[a-z0-9_-]{1,64}$/.test(d.id) ||
      typeof d.label !== 'string' || d.label.length > 100 || !Array.isArray(d.roles) || d.roles.length > 30 ||
      d.roles.some((r) => !onlyKeys(r, ['id', 'label']) || !/^[a-z0-9_-]{1,32}$/.test(r.id) || typeof r.label !== 'string' || r.label.length > 100) || new Set(d.roles.map((r) => r.id)).size !== d.roles.length) ||
      new Set(disciplines.map((d) => d.code)).size !== disciplines.length) throw Error();
    if (!Array.isArray(extraFields) || extraFields.length > 20 || extraFields.some((f) =>
      !onlyKeys(f, ['id', 'type', 'scope', 'required', 'maxLength', 'label']) || !/^custom_[a-z0-9_]{1,40}$/.test(f.id) || f.type !== 'string' || f.scope !== 'profile' || typeof f.required !== 'boolean' || !Number.isSafeInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 1000) ||
      new Set(extraFields.map((f) => f.id)).size !== extraFields.length) throw Error();
    if (!Array.isArray(permissions) || permissions.length > 10 || permissions.some((p) => !onlyKeys(p, ['purpose', 'textVersion', 'text', 'fields']) ||
      !/^[a-z0-9_-]{1,32}$/.test(p.purpose) || typeof p.textVersion !== 'string' || p.textVersion.length > 64 ||
      typeof p.text !== 'string' || p.text.length > 4000 || !Array.isArray(p.fields) || p.fields.some((f) => !['nickname', 'photo', 'discipline', 'roles'].includes(f))) ||
      new Set(permissions.map((p) => p.purpose)).size !== permissions.length) throw Error();
  } catch { configValid = false; disciplines = []; extraFields = []; permissions = []; }
  return { origin, configValid, secret: env.YCS_PLAYER_SESSION_SECRET || '',
    enabled: env.YCS_PLAYER_ENABLED === 'true', sessionMs: positive('YCS_PLAYER_SESSION_TTL_SECONDS', 86400, 2_592_000) * 1000,
    retryWindowMs: 86400_000, authMs: 10 * 60_000, fields: [...PLAYER_FIELDS, ...extraFields], disciplines, permissions,
    photo: PHOTO_LIMITS, cookieSecure: origin?.startsWith('https:') === true };
}

export function resolvePlayerDiscipline(config, code) {
  const found = typeof code === 'string' && config.disciplines.find((d) => d.code === code);
  if (!found) playerFail('invalid_discipline', 400);
  return found;
}

// Preserve Unicode and the literal requested ?? placeholder. Paths, controls and
// URL delimiters become harmless separators; this value is never a filesystem path.
export function photoBasename(name, nickname) {
  const safe = (text) => String(text).normalize('NFC').trim().replace(/[\p{C}/\\:#%*?"<>|]/gu, '_').replace(/\s+/gu, '-').replace(/^[.]+|[. ]+$/g, '');
  return `${name ? safe(name) : '??'}-${safe(nickname)}`;
}

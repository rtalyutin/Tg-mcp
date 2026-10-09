import { createPublicKey, verify } from 'node:crypto';

// Telegram's production Ed25519 key. No bot token is needed or accepted here.
// https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
const TELEGRAM_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
export const CAPTAIN_AUTH_MAX_AGE_MS = 60 * 60 * 1000;

export class CaptainError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'CaptainError'; this.code = code; this.status = status; }
}
export const fail = (code, status = 400) => { throw new CaptainError(code, status); };

// Key injection exists only as an explicit constructor dependency for synthetic
// signature tests; there is no environment variable or HTTP input overriding it.
export function createTelegramVerifier({ botId, now = Date.now, publicKey } = {}) {
  if (!/^[1-9]\d{0,19}$/.test(String(botId || ''))) return () => fail('captain_not_configured', 503);
  const key = publicKey || createPublicKey({ key: Buffer.concat([derPrefix, Buffer.from(TELEGRAM_KEY, 'hex')]), format: 'der', type: 'spki' });
  return (initData) => {
    if (typeof initData !== 'string' || !initData.length || Buffer.byteLength(initData) > 16_384) fail('unauthorized', 401);
    const params = new URLSearchParams(initData);
    const entries = [...params.entries()];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) fail('unauthorized', 401);
    const signature = params.get('signature');
    if (!signature || !/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature)) fail('unauthorized', 401);
    const check = `${botId}:WebAppData\n${entries.filter(([name]) => name !== 'hash' && name !== 'signature')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('\n')}`;
    try { if (!verify(null, Buffer.from(check), key, Buffer.from(signature, 'base64url'))) fail('unauthorized', 401); }
    catch { fail('unauthorized', 401); }
    const authDate = params.get('auth_date');
    if (!/^\d{1,13}$/.test(authDate || '')) fail('unauthorized', 401);
    const age = now() - Number(authDate) * 1000;
    if (!Number.isSafeInteger(Number(authDate)) || age < -30_000 || age > CAPTAIN_AUTH_MAX_AGE_MS) fail('unauthorized', 401);
    let user;
    try { user = JSON.parse(params.get('user')); } catch { fail('unauthorized', 401); }
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true ||
      (user.username !== undefined && (typeof user.username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(user.username)))) fail('unauthorized', 401);
    return { id: String(user.id), username: user.username?.toLowerCase() || null };
  };
}

export function createRateLimit({ now = Date.now, limit = 120, interval = 60_000, capacity = 2048 } = {}) {
  const entries = new Map();
  return (key) => {
    const current = now();
    for (const [id, value] of entries) if (value.until <= current) entries.delete(id);
    const value = entries.get(key) || { count: 0, until: current + interval };
    if (value.count >= limit || (!entries.has(key) && entries.size >= capacity)) fail('too_many_requests', 429);
    value.count++; entries.set(key, value);
  };
}

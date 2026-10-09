import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildOrganizerTable } from '../src/lib/organizer-table.js';
import { applyDotaSnapshot, DOTA_RESULTS_URL, validateDotaSnapshot } from '../src/lib/dota-results.js';
import { captainErrorResponse } from './captain-service.mjs';

const SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_MS = 60 * 1000;
const officialOrigin = 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
const hash = (value) => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(hash(a), hash(b));
const files = ['current-cs2-2026', 'dota2-autumn-2026', 'dota2-main-2026', 'cs2-february-2026', 'dota2-qual-2026'];

export function createOrganizerDataSource({ fetcher = fetch } = {}) {
  let baselinePromise;
  let latest;
  let refreshedAt = -Infinity;
  let pending;
  async function load() {
    baselinePromise ||= Promise.all([
      Promise.all(files.map((name) => readFile(new URL(`../src/data/tournaments/${name}.json`, import.meta.url), 'utf8').then(JSON.parse))),
      readFile(new URL('./organizer-assignments.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    const [baseline, assignments] = await baselinePromise;
    if (!pending && Date.now() - refreshedAt > 60_000) {
      pending = (async () => {
        let availability = latest ? 'unavailable' : 'pending';
        try {
          const response = await fetcher(DOTA_RESULTS_URL, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
          if (response.status !== 404 || latest) {
            if (!response.ok) throw new Error('Results unavailable');
            const snapshot = validateDotaSnapshot(await response.json(), baseline[1]);
            if (!latest || snapshot.revision > latest.revision) latest = snapshot;
            else if (snapshot.revision === latest.revision && JSON.stringify(snapshot) !== JSON.stringify(latest)) throw new Error('Conflicting results revision');
            availability = 'current';
          }
        } catch { availability = 'unavailable'; }
        refreshedAt = Date.now();
        return availability;
      })();
    }
    const availability = pending ? await pending : load.availability;
    load.availability = availability;
    pending = null;
    const tournaments = baseline.map((t) => t.id === 'dota2-autumn-2026' && latest ? applyDotaSnapshot(t, latest) : t);
    return { ...buildOrganizerTable(tournaments, assignments), generatedAt: new Date().toISOString(),
      results: { availability, revision: latest?.revision || 0 } };
  }
  return load;
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw Object.assign(new Error(), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error(), { status: 400 }); }
}

export function createOrganizerHandler({ env = process.env, getData = createOrganizerDataSource(), now = Date.now, captainService } = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const allowedOrigin = env.YCS_ORGS_ALLOWED_ORIGIN || officialOrigin;
  const configured = Boolean(env.YCS_ORGS_LOGIN && env.YCS_ORGS_PASSWORD);
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/api/orgs/')) return false;
    const send = (status, body, extra = {}) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
      return true;
    };
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) return send(403, { error: 'origin_denied' });
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (!['/api/orgs/login', '/api/orgs/matches', '/api/orgs/logout', '/api/orgs/captains'].includes(url.pathname)) return send(404, { error: 'not_found' });
    if (request.method === 'OPTIONS') return send(204, null, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
      'access-control-max-age': '600',
    });
    if (!configured) return send(503, { error: 'orgs_not_configured' });
    const current = now();
    for (const [key, expires] of sessions) if (expires <= current) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= current) attempts.delete(key);
    if (url.pathname === '/api/orgs/login') {
      if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS' });
      // Do not trust arbitrary X-Forwarded-For headers. This limit is per backend process.
      const ip = request.socket.remoteAddress || 'unknown';
      const attempt = attempts.get(ip) || { count: 0, until: current + ATTEMPT_MS };
      if (attempt.count >= 5) return send(429, { error: 'too_many_attempts' }, { 'retry-after': '60' });
      attempt.count++;
      if (attempts.size >= 1024 && !attempts.has(ip)) return send(429, { error: 'too_many_attempts' }, { 'retry-after': '60' });
      attempts.set(ip, attempt);
      let body;
      try { body = await jsonBody(request); }
      catch (error) { return send(error.status || 400, { error: 'invalid_request' }); }
      if (!body || typeof body.login !== 'string' || body.login.length > 128 ||
        typeof body.password !== 'string' || body.password.length > 512) return send(400, { error: 'invalid_request' });
      const loginValid = equal(body.login, env.YCS_ORGS_LOGIN);
      const passwordValid = equal(body.password, env.YCS_ORGS_PASSWORD);
      if (!loginValid || !passwordValid) return send(401, { error: 'invalid_credentials' });
      attempts.delete(ip);
      if (sessions.size >= 64) return send(503, { error: 'sessions_full' });
      const token = randomBytes(32).toString('hex');
      const expiresAt = current + SESSION_MS;
      sessions.set(hash(token).toString('hex'), expiresAt);
      return send(200, { token, expiresAt });
    }
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const sessionKey = token && hash(token).toString('hex');
    if (!sessionKey || !sessions.has(sessionKey)) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/api/orgs/logout') {
      if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS' });
      sessions.delete(sessionKey);
      return send(204, null);
    }
    if (url.pathname === '/api/orgs/captains') {
      if (!['GET', 'POST'].includes(request.method)) return send(405, { error: 'method_not_allowed' }, { allow: 'GET, POST, OPTIONS' });
      if (!captainService) return send(503, { error: 'captain_not_configured' });
      try {
        const body = request.method === 'POST' ? await jsonBody(request) : null;
        if (request.method === 'POST' && (body === null || Array.isArray(body) || typeof body !== 'object')) return send(400, { error: 'invalid_request' });
        return send(200, await captainService.organizer(body));
      } catch (error) {
        if (error.status && !error.code) return send(error.status, { error: 'invalid_request' });
        const failure = captainErrorResponse(error); return send(failure.status, failure.body);
      }
    }
    if (request.method !== 'GET') return send(405, { error: 'method_not_allowed' }, { allow: 'GET, OPTIONS' });
    try { return send(200, await getData()); }
    catch { return send(503, { error: 'data_unavailable' }); }
  };
}

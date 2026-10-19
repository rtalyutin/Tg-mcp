import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { PLAYER_BASE, onlyKeys, playerFail, resolvePlayerDiscipline } from './player-profile-config.mjs';

const COOKIE = 'ycs_player_session';
const random = () => randomBytes(32).toString('base64url');
const idPattern = /^[A-Za-z0-9_-]{43}$/;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hash = (s) => createHash('sha256').update(s).digest('base64url');

async function jsonResponse(response) {
  if (!response.ok || response.headers.get('content-length') > 65536) playerFail('auth_provider_unavailable', 503);
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > 65536) playerFail('auth_provider_unavailable', 503); chunks.push(Buffer.from(value)); }
    const result = JSON.parse(Buffer.concat(chunks)); if (result.error) playerFail('auth_provider_rejected', 401); return result;
  } finally { await reader.cancel().catch(() => {}); }
}

// Only fixed official endpoints are contacted. No phone/email/write scope, bot
// messaging or client-supplied provider profile is involved.
export function createPlayerProviders({ env = process.env, fetchImpl = fetch, telegramKey } = {}) {
  const telegramId = env.YCS_PLAYER_TELEGRAM_CLIENT_ID;
  const telegramSecret = env.YCS_PLAYER_TELEGRAM_CLIENT_SECRET;
  const vkId = env.YCS_PLAYER_VK_CLIENT_ID;
  const telegramKeys = telegramKey || createRemoteJWKSet(new URL('https://oauth.telegram.org/.well-known/jwks.json'), { timeoutDuration: 10_000 });
  const post = async (url, body, headers = {}) => {
    try { return await jsonResponse(await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body), redirect: 'error', signal: AbortSignal.timeout(10_000) })); }
    catch (e) { if (e.code) throw e; playerFail('auth_provider_unavailable', 503); }
  };
  return {
    telegram: { configured: /^\d+$/.test(telegramId || '') && !!telegramSecret,
      authorization(attempt, redirectUri) {
        const u = new URL('https://oauth.telegram.org/auth');
        u.search = new URLSearchParams({ client_id: telegramId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
          state: attempt.id, nonce: attempt.nonce, code_challenge: hash(attempt.verifier), code_challenge_method: 'S256' }); return u.href;
      },
      async exchange(attempt, params, redirectUri) {
        const token = await post('https://oauth.telegram.org/token', { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri,
          client_id: telegramId, code_verifier: attempt.verifier }, { authorization: `Basic ${Buffer.from(`${telegramId}:${telegramSecret}`).toString('base64')}` });
        let payload;
        try { ({ payload } = await jwtVerify(token.id_token, telegramKeys, { issuer: 'https://oauth.telegram.org', audience: telegramId,
          algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], maxTokenAge: '10m' })); }
        catch { playerFail('auth_provider_rejected', 401); }
        if (!equal(payload.nonce, attempt.nonce) || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sub)) playerFail('auth_provider_rejected', 401);
        return { subject: payload.sub };
      },
    },
    vk: { configured: /^\d+$/.test(vkId || ''),
      authorization(attempt, redirectUri) {
        const u = new URL('https://id.vk.ru/authorize');
        u.search = new URLSearchParams({ client_id: vkId, redirect_uri: redirectUri, response_type: 'code', scope: '', state: attempt.id,
          code_challenge: hash(attempt.verifier), code_challenge_method: 's256' }); return u.href;
      },
      async exchange(attempt, params, redirectUri) {
        const deviceId = params.get('device_id'); if (!deviceId || deviceId.length > 1024) playerFail('auth_provider_rejected', 401);
        const token = await post('https://id.vk.ru/oauth2/auth', { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri,
          client_id: vkId, device_id: deviceId, state: attempt.id, code_verifier: attempt.verifier });
        if (!equal(token.state, attempt.id) || typeof token.access_token !== 'string' || token.access_token.length > 8192 ||
          !/^[1-9]\d{0,19}$/.test(String(token.user_id || ''))) playerFail('auth_provider_rejected', 401);
        const info = await post(`https://id.vk.ru/oauth2/user_info?client_id=${vkId}`, { access_token: token.access_token });
        if (!info.user || String(info.user.user_id) !== String(token.user_id)) playerFail('auth_provider_rejected', 401);
        return { subject: String(token.user_id) };
      },
    },
  };
}

export function createPlayerAuth({ config, store, providers, now = Date.now }) {
  const configured = config.enabled && config.configValid && !!config.origin && Buffer.byteLength(config.secret) >= 32 && store.configured;
  const ready = () => { if (!configured) playerFail('player_not_configured', 503); };
  const mac = (purpose, sid) => createHmac('sha256', config.secret).update(`${purpose}:${sid}`).digest('base64url');
  const decode = (request) => {
    const cookie = String(request.headers.cookie || '').split(';').map((c) => c.trim()).filter((c) => c.startsWith(`${COOKIE}=`));
    if (cookie.length !== 1) return null;
    const [sid, signature, extra] = cookie[0].slice(COOKIE.length + 1).split('.');
    return !extra && idPattern.test(sid || '') && equal(signature, mac('session', sid)) ? sid : null;
  };
  const cookie = (response, sid) => response.setHeader('set-cookie', `${COOKIE}=${sid}.${mac('session', sid)}; Path=${PLAYER_BASE}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionMs / 1000)}${config.cookieSecure ? '; Secure' : ''}`);
  const session = async (request, response, { required = false } = {}) => {
    ready(); let sid = decode(request); if (!sid) { sid = random(); cookie(response, sid); }
    const state = (await store.read()).value;
    const saved = state.sessions[sid]; const active = saved && saved.expires > now() && state.accounts[saved.ownerId];
    if (required && !active) playerFail('unauthenticated', 401);
    return { sid, ownerId: active ? saved.ownerId : null, csrfToken: mac('csrf', sid), state };
  };
  const checkWrite = (request, sess) => {
    if (request.headers.origin !== config.origin) playerFail('forbidden_origin', 403);
    if (!equal(request.headers['x-csrf-token'], sess.csrfToken)) playerFail('csrf_failed', 403);
  };
  const publicSession = (sess) => ({ authenticated: !!sess.ownerId, csrfToken: sess.csrfToken,
    ...(sess.ownerId ? { ownerId: sess.ownerId, providers: Object.entries(sess.state.identities).filter(([, owner]) => owner === sess.ownerId).map(([key]) => key.split(':')[0]) } : {}) });
  return { configured, ready, session, checkWrite, publicSession,
    async start(request, response, body) {
      const sess = await session(request, response); checkWrite(request, sess);
      if (!onlyKeys(body, ['provider', 'intent', 'Dis']) || !['login', 'link'].includes(body.intent) || !Object.hasOwn(providers, body.provider)) playerFail('validation_failed', 422);
      resolvePlayerDiscipline(config, body.Dis);
      const provider = providers[body.provider]; if (!provider.configured) playerFail('auth_provider_not_configured', 503);
      if (body.intent === 'link' && !sess.ownerId) playerFail('unauthenticated', 401);
      if (body.intent === 'link' && Object.entries(sess.state.identities).some(([key, owner]) => owner === sess.ownerId && key.startsWith(`${body.provider}:`))) playerFail('identity_already_linked', 409);
      const attempt = { id: random(), sid: sess.sid, provider: body.provider, intent: body.intent, discipline: body.Dis,
        ownerId: body.intent === 'link' ? sess.ownerId : null, nonce: random(), verifier: random(), expires: now() + config.authMs };
      await store.mutate((state) => {
        for (const [id, a] of Object.entries(state.attempts)) if (a.expires <= now()) delete state.attempts[id];
        if (Object.keys(state.attempts).length > 10000) playerFail('rate_limited', 429);
        state.attempts[attempt.id] = attempt;
      });
      return { attemptId: attempt.id, authorizationUrl: provider.authorization(attempt, `${config.origin}${PLAYER_BASE}/auth/callback/${body.provider}`) };
    },
    async callback(request, response, providerName, params) {
      ready(); const sid = decode(request); const id = params.get('state');
      if (!sid || !idPattern.test(id || '') || new Set([...params.keys()]).size !== [...params.keys()].length || !Object.hasOwn(providers, providerName)) playerFail('auth_state_invalid', 401);
      const attempt = await store.mutate((state) => {
        const a = state.attempts[id];
        if (!a || a.sid !== sid || a.expires <= now() || a.provider !== providerName || a.used) playerFail('auth_state_invalid', 401);
        if (a.intent === 'link' && (state.sessions[sid]?.ownerId !== a.ownerId || state.sessions[sid].expires <= now())) playerFail('unauthenticated', 401);
        a.used = true; return structuredClone(a);
      });
      let result = 'success';
      try {
        if (params.has('error')) playerFail('auth_cancelled', 401);
        if (!params.get('code') || params.get('code').length > 8192) playerFail('auth_provider_rejected', 401);
        const identity = await providers[providerName].exchange(attempt, params, `${config.origin}${PLAYER_BASE}/auth/callback/${providerName}`);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.subject || '')) playerFail('auth_provider_rejected', 401);
        const nextSid = random();
        await store.mutate((state) => {
          if (attempt.intent === 'link' && (state.sessions[sid]?.ownerId !== attempt.ownerId || state.sessions[sid].expires <= now())) playerFail('unauthenticated', 401);
          const key = `${providerName}:${identity.subject}`; const bound = state.identities[key];
          if (attempt.intent === 'link' && bound && bound !== attempt.ownerId) playerFail('identity_already_linked', 409);
          const ownerId = attempt.ownerId || bound || randomUUID();
          for (const [sessionId, session] of Object.entries(state.sessions)) if (session.expires <= now()) delete state.sessions[sessionId];
          state.accounts[ownerId] ||= { id: ownerId, createdAt: new Date(now()).toISOString(), profile: null };
          state.identities[key] = ownerId;
          state.sessions[nextSid] = { ownerId, expires: now() + config.sessionMs };
          delete state.sessions[sid];
        });
        cookie(response, nextSid);
      } catch (e) { result = e.code || 'auth_provider_unavailable'; }
      const target = new URL('/player/profile', config.origin);
      target.search = new URLSearchParams({ Dis: attempt.discipline, auth: result, authAttempt: id });
      response.writeHead(303, { location: target.href }); response.end();
    },
    async logout(request, response) {
      const sess = await session(request, response, { required: true }); checkWrite(request, sess);
      await store.mutate((state) => { delete state.sessions[sess.sid]; });
      cookie(response, random()); return { authenticated: false };
    },
  };
}

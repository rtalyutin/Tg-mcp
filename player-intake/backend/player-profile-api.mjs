import { playerConfig, PLAYER_BASE, PlayerError, playerFail, resolvePlayerDiscipline } from './player-profile-config.mjs';
import { createPlayerS3Store } from './player-profile-store.mjs';
import { createPlayerAuth, createPlayerProviders } from './player-profile-auth.mjs';
import { createPlayerProfileService } from './player-profile-service.mjs';
import { createPlayerIntake } from './player-profile-intake.mjs';

async function readBody(request, max) {
  if (request.headers['content-length'] !== undefined && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > max)) playerFail('file_too_large', 413);
  const chunks = []; let size = 0;
  const timer = setTimeout(() => request.destroy(), 30_000); timer.unref();
  try { for await (const chunk of request.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > max) playerFail('file_too_large', 413); chunks.push(Buffer.from(chunk)); } }
  finally { clearTimeout(timer); }
  return Buffer.concat(chunks);
}
async function json(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') playerFail('unsupported_content_type', 415);
  const body = await readBody(request, 64 * 1024);
  try { return JSON.parse(body.toString('utf8')); } catch { playerFail('invalid_json', 400); }
}

export function createPlayerProfileHandler({ env = process.env, now = Date.now,
  config = playerConfig(env), store = createPlayerS3Store({ env, now }), providers = createPlayerProviders({ env }),
  auth = createPlayerAuth({ config, store, providers, now }), service = createPlayerProfileService({ config, store, now }),
  intake = createPlayerIntake({ env, config, store, now }) } = {}) {
  const rates = new Map(); let activeUploads = 0; let activeIntakes = 0;
  const limit = (key, maximum) => {
    for (const [id, entry] of rates) if (entry.until <= now()) rates.delete(id);
    const entry = rates.get(key) || { count: 0, until: now() + 60_000 };
    if (entry.count >= maximum || !rates.has(key) && rates.size >= 10000) playerFail('rate_limited', 429);
    entry.count++; rates.set(key, entry);
  };
  return async (request, response, url) => {
    if (url.pathname !== PLAYER_BASE && !url.pathname.startsWith(`${PLAYER_BASE}/`)) return false;
    const path = url.pathname.slice(PLAYER_BASE.length);
    const intakePath = path === '/intake' || path.startsWith('/intake/');
    const send = (status, result) => { response.writeHead(status); response.end(JSON.stringify(result)); };
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('vary', 'Origin');
    if (config.origin && request.headers.origin === config.origin) {
      response.setHeader('access-control-allow-origin', config.origin);
      if (!intakePath) response.setHeader('access-control-allow-credentials', 'true');
    }
    try {
      if (request.headers.origin && request.headers.origin !== config.origin) playerFail(intakePath && !config.origin ? 'player_intake_not_configured' : 'forbidden_origin', intakePath && !config.origin ? 503 : 403);
      if (request.method === 'OPTIONS') {
        if (request.headers.origin !== config.origin) playerFail('forbidden_origin', 403);
        response.writeHead(204, { 'access-control-allow-methods': intakePath ? 'GET, POST, OPTIONS' : 'GET, POST, PUT, OPTIONS',
          'access-control-allow-headers': intakePath ? 'Content-Type' : 'Content-Type, X-CSRF-Token' }); response.end(); return true;
      }
      limit(`ip:${request.socket.remoteAddress || 'unknown'}`, 300);
      if (intakePath) {
        if (path === '/intake/context' && request.method === 'GET') {
          if (url.searchParams.getAll('Dis').length !== 1) playerFail('invalid_discipline', 400);
          send(200, intake.context(url.searchParams.get('Dis'))); return true;
        }
        if (!config.origin) playerFail('player_intake_not_configured', 503);
        if (request.headers.origin !== config.origin) playerFail('forbidden_origin', 403);
        if (path === '/intake/prepare' && request.method === 'POST') {
          limit(`intake-prepare:${request.socket.remoteAddress}`, 60); send(200, await intake.prepare(await json(request))); return true;
        }
        if (path === '/intake/complete' && request.method === 'POST') {
          limit(`intake-complete:${request.socket.remoteAddress}`, 120);
          if (activeIntakes >= 4) playerFail('upload_busy', 429);
          activeIntakes++;
          try { send(200, await intake.complete(await json(request))); return true; }
          finally { activeIntakes--; }
        }
        send(['/intake/prepare', '/intake/complete', '/intake/context'].includes(path) ? 405 : 404, { error: ['/intake/prepare', '/intake/complete', '/intake/context'].includes(path) ? 'method_not_allowed' : 'not_found' }); return true;
      }
      const callback = path.match(/^\/auth\/callback\/(telegram|vk)$/);
      if (callback && request.method === 'GET') { await auth.callback(request, response, callback[1], url.searchParams); return true; }
      if (path === '/context' && request.method === 'GET') {
        if (url.searchParams.getAll('Dis').length !== 1) playerFail('invalid_discipline', 400);
        const discipline = resolvePlayerDiscipline(config, url.searchParams.get('Dis'));
        send(200, { discipline, fields: config.fields, photo: config.photo, retryWindowMs: config.retryWindowMs,
          usagePermissions: config.permissions, providers: Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, auth.configured && p.configured])), available: auth.configured }); return true;
      }
      if (path === '/session' && request.method === 'GET') { send(200, auth.publicSession(await auth.session(request, response))); return true; }
      if (path === '/auth/start' && request.method === 'POST') {
        limit(`auth:${request.socket.remoteAddress}`, 30); send(200, await auth.start(request, response, await json(request))); return true;
      }
      if (path === '/logout' && request.method === 'POST') { send(200, await auth.logout(request, response)); return true; }
      const sess = await auth.session(request, response, { required: true });
      limit(`owner:${sess.ownerId}`, 180);
      if (!['GET', 'HEAD'].includes(request.method)) auth.checkWrite(request, sess);
      if (path === '/me' && request.method === 'GET') {
        if (url.searchParams.getAll('Dis').length !== 1) playerFail('invalid_discipline', 400);
        send(200, service.read(sess, url.searchParams.get('Dis'))); return true;
      }
      if (path === '/me' && request.method === 'PUT') { limit(`save:${sess.ownerId}`, 30); send(200, await service.save(sess, await json(request))); return true; }
      if (path === '/photos' && request.method === 'POST') {
        limit(`upload:${sess.ownerId}`, 12); if (activeUploads >= 4) playerFail('upload_busy', 429);
        activeUploads++;
        try {
          const type = request.headers['content-type'];
          if (!type?.startsWith('multipart/form-data;')) playerFail('unsupported_content_type', 415);
          const body = await readBody(request, config.photo.maxBytes + 64 * 1024);
          let form;
          try { form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': type }, body }).formData(); }
          catch { playerFail('invalid_upload', 400); }
          const entries = [...form.entries()];
          if (entries.some(([name]) => !['file', 'crop'].includes(name)) || form.getAll('file').length !== 1 || form.getAll('crop').length > 1) playerFail('invalid_upload', 400);
          const file = form.get('file');
          if (!file || typeof file.arrayBuffer !== 'function') playerFail('invalid_upload', 400);
          if (file.size > config.photo.maxBytes) playerFail('file_too_large', 413);
          let crop;
          if (form.has('crop')) { try { if (typeof form.get('crop') !== 'string' || form.get('crop').length > 1000) throw Error(); crop = JSON.parse(form.get('crop')); } catch { playerFail('invalid_upload', 400); } }
          send(201, await service.upload(sess, Buffer.from(await file.arrayBuffer()), { crop, contentType: file.type })); return true;
        } finally { activeUploads--; }
      }
      const photo = path.match(/^\/photos\/([^/]+)$/);
      if (photo && request.method === 'GET') {
        const result = await service.photo(sess, photo[1]);
        response.writeHead(200, { 'content-type': result.contentType, 'content-length': result.body.length,
          'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox" }); response.end(result.body); return true;
      }
      const operation = path.match(/^\/operations\/([^/]+)$/);
      if (operation && request.method === 'GET') { send(200, service.operation(sess, operation[1])); return true; }
      const known = ['/context', '/session', '/auth/start', '/logout', '/me', '/photos'].includes(path) || photo || operation || callback;
      send(known ? 405 : 404, { error: known ? 'method_not_allowed' : 'not_found' });
    } catch (e) {
      if (response.headersSent) { response.end(); return true; }
      const expected = e instanceof PlayerError;
      if (expected && e.status === 413) response.setHeader('connection', 'close');
      send(expected ? e.status : 503, { error: expected ? e.code : 'dependency_unavailable', ...(e.fields ? { fields: e.fields } : {}) });
    }
    return true;
  };
}

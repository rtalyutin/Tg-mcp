import test from 'node:test';
import assert from 'node:assert/strict';
import { startStartupHttpListener } from '../src/startup-http.ts';
import { startYcsCaptainRuntime, type CaptainDependencies, type CaptainService, type LceResultsService } from '../src/ycs-captain/runtime.ts';
const root = new URL('../ycs-dota/backend/', import.meta.url);
const [{ createOrganizerHandler }, { createLceResultsService, createLcePublicHandler, emptyLce }] = await Promise.all([
  import(new URL('organizer-api.mjs', root).href), import(new URL('lce-results-service.mjs', root).href),
]);
const origin = 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
const env = { YCS_CAPTAIN_ENABLED: 'true', YCS_CAPTAIN_BOT_ID: '12345', YCS_CAPTAIN_ENCRYPTION_KEY: 'ab'.repeat(32),
  AWS_ACCESS_KEY_ID: 'test-only-access', AWS_SECRET_ACCESS_KEY: 'test-only-secret', YCS_ORGS_LOGIN: 'test-org', YCS_ORGS_PASSWORD: 'test-password',
  YCS_ORGS_ALLOWED_ORIGIN: origin };
const captain: CaptainService = { captain: async () => null, organizer: async () => ({ assignments: [] }), cleanup: async () => null };
const worker = () => ({ state: { status: 'idle', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null }, stop: async () => {} });
const publicPath = '/api/tournaments/cs2-lce-november-2026';
const post = (base: string, path: string, body: unknown, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});
test('production captain router mounts LCE public read and authenticated saves with one shared service and exact CORS', async () => {
  let value = emptyLce(), etag = 0, reads = 0, writes = 0, creations = 0;
  const instances: Array<LceResultsService | undefined> = [];
  const store = { async read() { reads++; return { value: structuredClone(value), etag }; },
    async compareAndSet(previous: { etag: number }, next: ReturnType<typeof emptyLce>) {
      assert.equal(previous.etag, etag); writes++; value = structuredClone(next); etag++; return this.read();
    } };
  const dependencies: CaptainDependencies = {
    createCaptainService: () => captain, createCaptainHandler: () => async () => false,
    createOrganizerHandler: options => { instances.push(options.lceService); return createOrganizerHandler({ ...options, getData: async () => ({ rows: [] }) }); },
    createLceResultsService: options => {
      creations++; assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
      const service = createLceResultsService({ ...options, store }); instances.push(service); return service;
    },
    createLcePublicHandler: options => { instances.push(options.service); return createLcePublicHandler(options); },
    startCaptainCleanupWorker: worker,
  };
  const runtime = await startYcsCaptainRuntime({ env: { ...env, TELEGRAM_BOT_TOKEN: 'unrelated-test-token' }, loadDependencies: async () => dependencies });
  assert.equal(runtime.enabled, true); assert.equal(creations, 1); assert.ok(instances.every(s => s === instances[0]));
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute);
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(base + '/api/orgs/lce-results', { headers: { Origin: origin } });
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers.get('access-control-allow-origin'), origin); assert.equal(reads, 0);
    const preflight = await fetch(base + '/api/orgs/lce-results', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/);
    const initial = await fetch(base + publicPath, { headers: { Origin: origin } }); assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('access-control-allow-origin'), origin);
    const snapshot = await initial.json(); assert.equal(snapshot.revision, 0); assert.equal(snapshot.tournament.id, 'cs2-lce-november-2026');
    const matches = snapshot.tournament.stages.flatMap((s: {matches?: unknown[]; rounds?: Array<{matches: unknown[]}>}) => [...(s.matches || []), ...(s.rounds || []).flatMap(r => r.matches)]);
    assert.equal(matches.length, 13); assert.equal(snapshot.requests, undefined);
    const login = await post(base, '/api/orgs/login', { login: env.YCS_ORGS_LOGIN, password: env.YCS_ORGS_PASSWORD });
    assert.equal(login.status, 200); const { token } = await login.json(); const headers = { Authorization: `Bearer ${token}` };
    const body = { action: 'result', requestId: 'ab'.repeat(16), expectedRevision: 0, matchId: 'lce-group-01', result: { maps: [{ score1: 13, score2: 9 }] } };
    const saved = await post(base, '/api/orgs/lce-results', body, headers); assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
    assert.equal((await post(base, '/api/orgs/lce-results', body, headers)).status, 200); assert.equal(writes, 1);
    const latest = await (await fetch(base + publicPath)).json(); assert.equal(latest.revision, 1);
    const row = latest.tournament.stages[0].groups[0].rows.find((r: {teamId: string}) => r.teamId.endsWith('-team-1'));
    assert.equal(row.points, 1); assert.equal(row.roundDifference, 4);
    assert.equal((await fetch(base + publicPath, { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await post(base, publicPath, {})).status, 405);
    listener.activate((_request, response) => { response.writeHead(404); response.end(); });
    assert.equal((await fetch(base + publicPath + '/extra')).status, 404);
    await post(base, '/api/orgs/logout', {}, headers);
    assert.equal((await fetch(base + '/api/orgs/lce-results', { headers })).status, 401);
    await runtime.stop(); assert.equal((await fetch(base + publicPath)).status, 503);
  } finally { await runtime.stop(); await listener.close(); }
});
test('missing optional LCE dependencies fail closed without swallowing other tournament paths', async () => {
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => ({
    createCaptainService: () => captain, createCaptainHandler: () => async () => false,
    createOrganizerHandler: () => async () => false, startCaptainCleanupWorker: worker,
  }) });
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute);
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + publicPath)).status, 503);
    listener.activate((_request, response) => { response.writeHead(404); response.end(); });
    assert.equal((await fetch(base + '/api/tournaments/unrelated')).status, 404);
  } finally { await runtime.stop(); await listener.close(); }
});

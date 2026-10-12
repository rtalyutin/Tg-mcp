import test from 'node:test';
import assert from 'node:assert/strict';
import { startStartupHttpListener } from '../src/startup-http.ts';
import { startYcsCaptainRuntime, type CaptainDependencies, type CaptainService, type MatchMediaService } from '../src/ycs-captain/runtime.ts';

const root = new URL('../ycs-dota/backend/', import.meta.url);
const [{ createOrganizerHandler }, { createMatchMediaService, createMatchMediaPublicHandler }, { emptyMatchMedia }] = await Promise.all([
  import(new URL('organizer-api.mjs', root).href), import(new URL('match-media-service.mjs', root).href),
  import(new URL('match-media-store.mjs', root).href),
]);
const origin = 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
const env = { YCS_CAPTAIN_ENABLED: 'true', YCS_CAPTAIN_BOT_ID: '12345', YCS_CAPTAIN_ENCRYPTION_KEY: 'ab'.repeat(32),
  AWS_ACCESS_KEY_ID: 'test-access-private', AWS_SECRET_ACCESS_KEY: 'test-secret-private', YCS_ORGS_LOGIN: 'test-organizer',
  YCS_ORGS_PASSWORD: 'test-password-private', YCS_ORGS_ALLOWED_ORIGIN: origin };
const now = () => Date.parse('2026-10-12T14:00:00Z');
const catalog = [{ tournamentId: 'dota2-autumn-2026', id: 'fixture-one', tournamentTitle: 'YCS', team1: 'A', team2: 'B', bestOf: 'BO3',
  maps: [{ mapKey: 'id:9036860954', mapNumber: 1, mapId: '9036860954', name: 'Карта 1' }] },
  { tournamentId: 'dota2-autumn-2026', id: 'fixture-two', tournamentTitle: 'YCS', team1: 'C', team2: 'D', bestOf: 'BO1',
    maps: [{ mapKey: 'id:9036860999', mapNumber: 1, mapId: '9036860999', name: 'Карта 1' }] }];
const publicPath = '/api/match-media?tournamentId=dota2-autumn-2026&matchId=fixture-one';
const post = (base: string, path: string, body: unknown, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const addressOf = (listener: Awaited<ReturnType<typeof startStartupHttpListener>>) => {
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
};
const captain: CaptainService = { captain: async () => null, organizer: async () => ({ assignments: ['private-captain-assignment'] }), cleanup: async () => null };
const dependencies = (mediaFactory: NonNullable<CaptainDependencies['createMatchMediaService']>,
  organizerFactory: CaptainDependencies['createOrganizerHandler'] = options => createOrganizerHandler({ ...options, getData: async () => ({ rows: [] }) }),
  publicFactory: NonNullable<CaptainDependencies['createMatchMediaPublicHandler']> = createMatchMediaPublicHandler): CaptainDependencies => ({
  createCaptainService: () => captain, createCaptainHandler: () => async () => false,
  createOrganizerHandler: organizerFactory, createMatchMediaService: mediaFactory, createMatchMediaPublicHandler: publicFactory,
  startCaptainCleanupWorker: () => ({ state: { status: 'idle', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null }, stop: async () => {} }),
});
const login = async (base: string) => {
  const response = await post(base, '/api/orgs/login', { login: env.YCS_ORGS_LOGIN, password: env.YCS_ORGS_PASSWORD }, { Origin: origin });
  assert.equal(response.status, 200); return (await response.json()).token as string;
};

test('one media service shares existing organizer bearer and safely projects the saved match before and after gateway activation', async () => {
  let value = emptyMatchMedia(), etag: string | null = null, reads = 0, writes = 0, creations = 0;
  let media: MatchMediaService | undefined;
  const shared: Array<MatchMediaService | undefined> = [];
  const store = { async read() { reads++; return { value: structuredClone(value), etag }; },
    async compareAndSet(previous: { etag: string | null }, next: ReturnType<typeof emptyMatchMedia>) {
      assert.equal(previous.etag, etag); writes++; value = structuredClone(next); etag = String(value.revision); return this.read();
    } };
  const runtime = await startYcsCaptainRuntime({ env: { ...env, TELEGRAM_BOT_TOKEN: 'unrelated-private-token' }, now,
    loadDependencies: async () => dependencies(options => {
      creations++; assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
      return media = createMatchMediaService({ ...options, store, getCatalog: async () => structuredClone(catalog), randomId: () => 'cd'.repeat(16) });
    }, options => { shared.push(options.mediaService); return createOrganizerHandler({ ...options, getData: async () => ({ rows: [] }) }); },
    options => { shared.push(options.service); return createMatchMediaPublicHandler(options); }) });
  assert.equal(runtime.enabled, true); assert.equal(creations, 1); assert.ok(shared.every(service => service === media));
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute), base = addressOf(listener);
  try {
    assert.equal((await fetch(base + '/api/orgs/media')).status, 401); assert.equal(reads, 0);
    const token = await login(base), headers = { authorization: `Bearer ${token}`, Origin: origin };
    assert.equal((await fetch(base + '/api/orgs/captains', { headers })).status, 200);
    const saved = await post(base, '/api/orgs/media', { action: 'upsert', requestId: 'ab'.repeat(16), expectedRevision: 0,
      tournamentId: 'dota2-autumn-2026', matchId: 'fixture-one', mapKey: 'id:9036860954', kind: 'recording',
      url: 'https://www.youtube.com/watch?v=actual-video', title: 'Момент карты', startSeconds: 83, endSeconds: 105 }, headers);
    assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1); assert.equal(writes, 1);
    listener.activate((_request, response) => { response.writeHead(418); response.end('gateway'); });
    const response = await fetch(base + publicPath, { headers: { Origin: origin } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const projection = await response.json();
    assert.deepEqual(Object.keys(projection).sort(), ['catalogVersion', 'clips', 'matchId', 'revision', 'schemaVersion', 'tournamentId', 'updatedAt'].sort());
    assert.equal(projection.clips.length, 1); assert.equal(projection.clips[0].mapId, '9036860954');
    assert.equal(new URL(projection.clips[0].href).searchParams.get('t'), '83s');
    for (const secret of ['private-captain-assignment', 'requests', 'fingerprint', token, ...Object.values(env).filter(value => value.includes('private'))]) {
      assert.ok(!JSON.stringify(projection).includes(secret));
    }
    const other = await fetch(base + '/api/match-media?tournamentId=dota2-autumn-2026&matchId=fixture-two');
    assert.equal(other.status, 200); assert.deepEqual((await other.json()).clips, []);
    assert.equal((await fetch(base + '/api/match-media/extra')).status, 418);
    assert.equal((await fetch(base + '/mcp')).status, 418);
    assert.equal((await post(base, '/api/orgs/logout', {}, headers)).status, 204);
    assert.equal((await fetch(base + '/api/orgs/media', { headers })).status, 401);
    assert.equal((await fetch(base + publicPath)).status, 200);
  } finally { await runtime.stop(); await listener.close(); }
});

test('media routes honor exact website preflight, read-only public methods, HEAD and request validation without bypassing auth', async () => {
  let reads = 0, writes = 0;
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => dependencies(options => createMatchMediaService({ ...options,
    getCatalog: async () => structuredClone(catalog), store: { read: async () => { reads++; return { value: emptyMatchMedia(), etag: null }; },
      compareAndSet: async () => { writes++; assert.fail('read-only requests must not write'); } } })) });
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute), base = addressOf(listener);
  try {
    for (const path of ['/api/match-media', '/api/orgs/media']) {
      const response = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
      assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-max-age'), '600');
      assert.equal((await fetch(base + path, { method: 'OPTIONS', headers: { Origin: 'https://foreign.example' } })).status, 403);
    }
    assert.equal((await fetch(base + publicPath, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await post(base, '/api/match-media', {})).status, 405);
    assert.equal((await fetch(base + publicPath + '&matchId=fixture-two')).status, 400);
    assert.equal((await fetch(base + publicPath + '&private=1')).status, 400);
    assert.equal((await fetch(base + '/api/orgs/media')).status, 401); assert.equal(reads, 0);
    const head = await fetch(base + publicPath, { method: 'HEAD', headers: { Origin: origin } });
    assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(reads, 1); assert.equal(writes, 0);
  } finally { await runtime.stop(); await listener.close(); }
});

test('disabled runtime and legacy captain-only injected dependencies fail public media closed', async () => {
  for (const settings of [{ env: {} }, { env, loadDependencies: async () => {
    const deps = dependencies(() => assert.fail('media factory removed'));
    delete deps.createMatchMediaService; delete deps.createMatchMediaPublicHandler; return deps;
  } }]) {
    const runtime = await startYcsCaptainRuntime(settings), listener = await startStartupHttpListener(0, undefined, runtime.apiRoute);
    try {
      const response = await fetch(addressOf(listener) + publicPath); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'media_storage_unavailable' });
    } finally { await runtime.stop(); await listener.close(); }
  }
});

test('stop drains both accepted public reads and organizer media writes while refusing later requests', async () => {
  let releaseRead!: () => void, releaseWrite!: () => void, enterRead!: () => void, enterWrite!: () => void;
  const reading = new Promise<void>(resolve => { enterRead = resolve; }), writing = new Promise<void>(resolve => { enterWrite = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; }), writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let readCalls = 0, writeCalls = 0;
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => dependencies(() => ({
    async publicRead() { readCalls++; enterRead(); await readGate; return { clips: [] }; },
    async organizer() { writeCalls++; enterWrite(); await writeGate; return { revision: 1 }; },
  })) });
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute), base = addressOf(listener);
  try {
    const token = await login(base), headers = { authorization: `Bearer ${token}` };
    const readRequest = fetch(base + publicPath), writeRequest = post(base, '/api/orgs/media', { action: 'upsert' }, headers);
    await Promise.all([reading, writing]);
    let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
    assert.equal(runtime.stop(), runtime.stop()); await Promise.resolve(); assert.equal(stopped, false);
    assert.equal((await fetch(base + publicPath)).status, 503);
    assert.equal((await post(base, '/api/orgs/media', {}, headers)).status, 503);
    assert.equal(readCalls, 1); assert.equal(writeCalls, 1);
    releaseRead(); assert.equal((await readRequest).status, 200); await Promise.resolve(); assert.equal(stopped, false);
    releaseWrite(); assert.equal((await writeRequest).status, 200); await stop; assert.equal(runtime.state.status, 'stopped');
  } finally { releaseRead(); releaseWrite(); await runtime.stop(); await listener.close(); }
});

test('uncaught public handler failures become safe media errors instead of falling into the gateway', async () => {
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => dependencies(() => ({
    publicRead: async () => null, organizer: async () => null,
  }), undefined, () => async () => { throw new Error('private provider detail'); }) });
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute);
  listener.activate((_request, response) => { response.writeHead(418); response.end('gateway'); });
  try {
    const response = await fetch(addressOf(listener) + publicPath); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'media_storage_unavailable' });
  } finally { await runtime.stop(); await listener.close(); }
});

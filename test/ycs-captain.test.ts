import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { startStartupHttpListener } from '../src/startup-http.ts';
import { readYcsCaptainConfig, startYcsCaptainRuntime, type CaptainDependencies, type CaptainService } from '../src/ycs-captain/runtime.ts';
import { createYcsCaptainStatusRoute } from '../src/ycs-captain/status.ts';
import { createYcsDotaStatusRoute } from '../src/ycs-dota/status.ts';
import { startYcsDotaRuntime } from '../src/ycs-dota/runtime.ts';

const env = { YCS_CAPTAIN_ENABLED: 'true', YCS_CAPTAIN_BOT_ID: '12345', YCS_CAPTAIN_ENCRYPTION_KEY: 'ab'.repeat(32),
  AWS_ACCESS_KEY_ID: 'test-access-private', AWS_SECRET_ACCESS_KEY: 'test-secret-private', YCS_ORGS_LOGIN: 'test-organizer', YCS_ORGS_PASSWORD: 'test-password-private' };
const root = new URL('../ycs-dota/', import.meta.url);
const [{ createCaptainService }, { createCaptainHandler }, { createOrganizerHandler }, { startCaptainCleanupWorker },
  { createTelegramVerifier }, { emptyCaptainState }] = await Promise.all([
  import(new URL('backend/captain-service.mjs', root).href), import(new URL('backend/captain-api.mjs', root).href),
  import(new URL('backend/organizer-api.mjs', root).href), import(new URL('backend/captain-cleanup-worker.mjs', root).href),
  import(new URL('backend/captain-auth.mjs', root).href), import(new URL('backend/captain-store.mjs', root).href),
]);
const addressOf = (listener: Awaited<ReturnType<typeof startStartupHttpListener>>) => {
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
};
const post = (base: string, path: string, body: unknown, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('captain activation fails closed without all mandatory settings and never imports optional modules', async () => {
  for (const settings of [{}, { ...env, YCS_CAPTAIN_ENABLED: 'false' }, { ...env, YCS_CAPTAIN_ENABLED: 'yes' },
    { ...env, YCS_CAPTAIN_BOT_ID: '' }, { ...env, YCS_CAPTAIN_BOT_ID: '0' }, { ...env, YCS_CAPTAIN_ENCRYPTION_KEY: 'short' },
    { ...env, AWS_ACCESS_KEY_ID: '' }, { ...env, AWS_SECRET_ACCESS_KEY: ' ' }, { ...env, YCS_CAPTAIN_BUCKET: '../invalid' }]) {
    assert.equal(readYcsCaptainConfig(settings).enabled, false);
    const runtime = await startYcsCaptainRuntime({ env: settings, loadDependencies: async () => { assert.fail('must not load optional modules'); } });
    assert.equal(runtime.enabled, false); assert.equal(runtime.state.attempts, 0); await runtime.stop();
  }
  const failed = await startYcsCaptainRuntime({ env, loadDependencies: async () => { throw new Error(env.AWS_SECRET_ACCESS_KEY); } });
  assert.equal(failed.code, 'CAPTAIN_START_FAILED'); assert.ok(!JSON.stringify(failed).includes(env.AWS_SECRET_ACCESS_KEY));
});

test('one real captain service serves both APIs and cleanup before/after gateway activation with independent auth', async () => {
  const now = () => Date.parse('2026-10-08T10:00:00Z');
  const tournament = { id: 'dota2-autumn-2026', participants: [{ teamId: 'a', displayName: 'A' }, { teamId: 'b', displayName: 'B' }],
    stages: [{ rounds: [{ matches: [{ id: 'ab', team1Id: 'a', team2Id: 'b', bestOf: 'BO1', status: 'scheduled' }] }] }] };
  let value = emptyCaptainState(), etag: string | null = null, service: CaptainService | undefined;
  const shared: CaptainService[] = [];
  const keys = generateKeyPairSync('ed25519');
  const store = { async read() { return { value: structuredClone(value), etag }; }, async compareAndSet(previous: { etag: string | null }, next: unknown) {
    if (previous.etag !== etag) throw Object.assign(new Error(), { code: 'storage_conflict' });
    value = structuredClone(next); etag = String(value.revision); return this.read();
  } };
  const runtime = await startYcsCaptainRuntime({ env: { ...env, TELEGRAM_BOT_TOKEN: 'unrelated-never-share' }, now,
    loadDependencies: async () => ({
      createCaptainService(options) { assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined); return service = createCaptainService({ ...options, store,
        getTournament: async () => structuredClone(tournament), verify: createTelegramVerifier({ botId: env.YCS_CAPTAIN_BOT_ID, now, publicKey: keys.publicKey }) }); },
      createCaptainHandler(options) { shared.push(options.service); return createCaptainHandler(options); },
      createOrganizerHandler(options) { shared.push(options.captainService); return createOrganizerHandler({ ...options, getData: async () => ({ rows: [] }) }); },
      startCaptainCleanupWorker(options) { shared.push(options.service); return startCaptainCleanupWorker(options); },
    }) });
  assert.ok(service); assert.equal(shared.length, 3); assert.ok(shared.every(item => item === service));
  const dota = await startYcsDotaRuntime({ env: {} });
  const captainStatus = createYcsCaptainStatusRoute(() => runtime), dotaStatus = createYcsDotaStatusRoute(() => dota);
  const listener = await startStartupHttpListener(0, (req, res) => captainStatus(req, res) || dotaStatus(req, res), runtime.apiRoute);
  const base = addressOf(listener);
  try {
    assert.equal((await fetch(base + '/api/orgs/captains')).status, 401);
    assert.equal((await post(base, '/api/captain', { action: 'access', initData: 'forged' })).status, 401);
    assert.equal((await post(base, '/api/captain', {}, { Origin: 'https://xn--90aiaibl0ahlel5n.xn--p1ai' })).status, 403);
    assert.equal((await fetch(base + '/mcp')).status, 503);
    const login = await post(base, '/api/orgs/login', { login: env.YCS_ORGS_LOGIN, password: env.YCS_ORGS_PASSWORD });
    assert.equal(login.status, 200); const token = (await login.json()).token;
    const assignment = await post(base, '/api/orgs/captains', { requestId: 'assign-first', expectedRevision: 0, teamId: 'a', username: 'captain' }, { authorization: `Bearer ${token}` });
    assert.equal(assignment.status, 200);
    const params = new URLSearchParams({ auth_date: String(now() / 1000), user: JSON.stringify({ id: 11, username: 'captain' }) });
    const check = `${env.YCS_CAPTAIN_BOT_ID}:WebAppData\n${[...params].sort(([a], [b]) => a < b ? -1 : 1).map(([key, val]) => `${key}=${val}`).join('\n')}`;
    params.set('signature', sign(null, Buffer.from(check), keys.privateKey).toString('base64url'));
    const initData = params.toString();
    const access = await post(base, '/api/captain', { action: 'access', initData }); assert.equal(access.status, 200);
    assert.equal((await access.json()).authorized, true);
    listener.activate((_req, res) => { res.writeHead(401); res.end('gateway-auth'); });
    const match = await post(base, '/api/captain', { action: 'match', matchId: 'ab', initData }); assert.equal(match.status, 200);
    const epoch = (await match.json()).chatEpoch;
    const message = await post(base, '/api/captain', { action: 'message', matchId: 'ab', requestId: 'message-one', expectedChatEpoch: epoch, text: 'private chat test', initData });
    assert.equal(message.status, 200); assert.equal((await message.json()).messages[0].text, 'private chat test');
    assert.equal((await fetch(base + '/mcp')).status, 401);
    const statusResponse = await fetch(base + '/healthz/ycs-captain'); assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get('cache-control'), 'no-store'); const status = await statusResponse.json();
    assert.equal(status.enabled, true); assert.equal(status.configured, true); assert.equal(status.sourceRevision, JSON.parse(await readFile(new URL('captain-manifest.json', root), 'utf8')).sourceRevision);
    for (const secret of [...Object.values(env).filter(item => item.includes('private')), 'private chat test', initData, token]) assert.ok(!JSON.stringify(status).includes(secret));
    assert.equal((await fetch(base + '/healthz/ycs-dota')).status, 200);
    assert.equal(await (await fetch(base + '/healthz/ycs-captain', { method: 'HEAD' })).text(), '');
    assert.equal((await fetch(base + '/healthz/ycs-captain', { method: 'POST' })).status, 405);
  } finally { await runtime.stop(); await listener.close(); await dota.stop(); }
});

test('shutdown drains active API and cleanup once and prevents new captain work', async () => {
  let releaseRequest!: () => void, releaseCleanup!: () => void, enteredRequest!: () => void, enteredCleanup!: () => void;
  const requestEntered = new Promise<void>(resolve => { enteredRequest = resolve; });
  const cleanupEntered = new Promise<void>(resolve => { enteredCleanup = resolve; });
  let calls = 0;
  const service: CaptainService = {
    async captain() { calls++; enteredRequest(); await new Promise<void>(resolve => { releaseRequest = resolve; }); return { authorized: false }; },
    async organizer() { return {}; }, async cleanup() { enteredCleanup(); await new Promise<void>(resolve => { releaseCleanup = resolve; }); },
  };
  const deps: CaptainDependencies = { createCaptainService: () => service, createCaptainHandler, createOrganizerHandler, startCaptainCleanupWorker };
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => deps });
  await cleanupEntered;
  const listener = await startStartupHttpListener(0, undefined, runtime.apiRoute), base = addressOf(listener);
  try {
    const request = post(base, '/api/captain', { action: 'access' }); await requestEntered;
    let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
    assert.equal(runtime.stop(), runtime.stop());
    await Promise.resolve(); assert.equal(stopped, false);
    assert.equal((await post(base, '/api/captain', { action: 'access' })).status, 503); assert.equal(calls, 1);
    releaseCleanup(); await Promise.resolve(); assert.equal(stopped, false);
    releaseRequest(); assert.equal((await request).status, 200); await stop; assert.equal(runtime.state.status, 'stopped');
  } finally { releaseCleanup(); releaseRequest(); await runtime.stop(); await listener.close(); }
});

test('captain manifest preserves all pinned files and the collector fingerprint separately', async () => {
  const manifest = JSON.parse(await readFile(new URL('captain-manifest.json', root), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 17);
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), hash);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'), manifest.packageFingerprint);
  const collector = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(collector.files)).digest('hex'), collector.packageFingerprint);
  assert.equal(manifest.sourceRevision, collector.sourceRevision);
  assert.notEqual(manifest.packageFingerprint, collector.packageFingerprint);
});

test('public cleanup diagnostics expose allowlisted codes, redact unknown failures and clear on success', async () => {
  let failure: unknown = Object.assign(new Error('private diagnostic payload'), { code: 'invalid_request' });
  const service: CaptainService = { captain: async () => null, organizer: async () => null,
    cleanup: async () => { if (failure) throw failure; return null; } };
  const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => ({
    createCaptainService: () => service, createCaptainHandler: () => async () => false,
    createOrganizerHandler: () => async () => false,
    startCaptainCleanupWorker: () => ({ state: { status: 'idle', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null }, stop: async () => {} }),
  }) });
  const listener = await startStartupHttpListener(0, createYcsCaptainStatusRoute(() => runtime));
  try {
    await assert.rejects(service.cleanup());
    let status = await (await fetch(addressOf(listener) + '/healthz/ycs-captain')).json();
    assert.equal(status.cleanupErrorCode, 'invalid_request'); assert.ok(!JSON.stringify(status).includes('private diagnostic payload'));
    failure = Object.assign(new Error(env.AWS_SECRET_ACCESS_KEY), { code: env.AWS_ACCESS_KEY_ID });
    await assert.rejects(service.cleanup());
    status = await (await fetch(addressOf(listener) + '/healthz/ycs-captain')).json();
    assert.equal(status.cleanupErrorCode, 'cleanup_failed');
    assert.ok(!JSON.stringify(status).includes(env.AWS_SECRET_ACCESS_KEY)); assert.ok(!JSON.stringify(status).includes(env.AWS_ACCESS_KEY_ID));
    failure = null; await service.cleanup();
    status = await (await fetch(addressOf(listener) + '/healthz/ycs-captain')).json(); assert.equal(status.cleanupErrorCode, null);
  } finally { await runtime.stop(); await listener.close(); }
});

test('safe storage diagnostics distinguish CAS failure from application conflict while preserving store calls', async () => {
  for (const scenario of ['read', 'write', 'application', 'success']) {
    const original = Object.assign(new Error('private storage payload'), { code: scenario === 'read' ? 'storage_unavailable' : scenario === 'write' ? 'storage_conflict' : 'conflict' });
    const calls: unknown[][] = []; let service: CaptainService;
    const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => ({
      createCaptainStore: () => ({
        read: async (...args) => { calls.push(['read', ...args]); if (scenario === 'read') throw original; return 'private snapshot'; },
        compareAndSet: async (...args) => { calls.push(['write', ...args]); if (scenario === 'write') throw original; return 'private committed'; },
      }),
      createCaptainService: options => service = { captain: async () => null, organizer: async () => null,
        cleanup: async () => { const value = await options.store!.read(); if (scenario === 'application') throw original; return options.store!.compareAndSet(value, 'private next', 'private mutation'); } },
      createCaptainHandler: () => async () => false, createOrganizerHandler: () => async () => false,
      startCaptainCleanupWorker: () => ({ state: { status: 'idle', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null }, stop: async () => {} }),
    }) });
    const listener = await startStartupHttpListener(0, createYcsCaptainStatusRoute(() => runtime));
    try {
      assert.equal(runtime.storageStatus(), null);
      if (scenario === 'success') assert.equal(await service!.cleanup(), 'private committed');
      else await assert.rejects(service!.cleanup(), error => error === original);
      const status = await (await fetch(addressOf(listener) + '/healthz/ycs-captain')).json();
      assert.deepEqual(status.storage, { phase: ['read', 'application'].includes(scenario) ? 'read' : 'write', errorCode: scenario === 'read' ? 'storage_unavailable' : scenario === 'write' ? 'storage_conflict' : null });
      assert.ok(!JSON.stringify(status).includes('private'));
      assert.deepEqual(calls[0], ['read']);
      if (['write', 'success'].includes(scenario)) assert.deepEqual(calls[1], ['write', 'private snapshot', 'private next', 'private mutation']);
    } finally { await runtime.stop(); await listener.close(); }
  }
});

test('storage conflict details expose only enum fields and return detached copies', async () => {
  for (const invalid of [false, true]) {
    const detail = { httpStatus: invalid ? 503 : 412, condition: 'if-match', etagFormat: 'bare', compatibilityRetried: true,
      secret: 'private provider payload', etag: 'private-version' };
    const original = Object.assign(new Error('private raw response'), { code: 'storage_conflict', storageConflict: detail });
    let service: CaptainService;
    const runtime = await startYcsCaptainRuntime({ env, loadDependencies: async () => ({
      createCaptainStore: () => ({ read: async () => null, compareAndSet: async () => { throw original; } }),
      createCaptainService: options => service = { captain: async () => null, organizer: async () => null, cleanup: () => options.store!.compareAndSet() },
      createCaptainHandler: () => async () => false, createOrganizerHandler: () => async () => false,
      startCaptainCleanupWorker: () => ({ state: { status: 'idle', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null }, stop: async () => {} }),
    }) });
    const listener = await startStartupHttpListener(0, createYcsCaptainStatusRoute(() => runtime));
    try {
      await assert.rejects(service!.cleanup(), error => error === original);
      const snapshot = runtime.storageStatus();
      if (snapshot?.conflict) snapshot.conflict.httpStatus = 409;
      detail.condition = 'private-mutated';
      const status = await (await fetch(addressOf(listener) + '/healthz/ycs-captain')).json();
      assert.deepEqual(status.storage, { phase: 'write', errorCode: 'storage_conflict', ...(invalid ? {} : {
        conflict: { httpStatus: 412, condition: 'if-match', etagFormat: 'bare', compatibilityRetried: true },
      }) });
      assert.ok(!JSON.stringify(status).includes('private'));
    } finally { await runtime.stop(); await listener.close(); }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { startLocalPublicPublisher } from '../src/secret-server.ts';
import { combinePlayerIntakeApi, PLAYER_INTAKE_ORIGIN, readYcsPlayerIntakeConfig, startYcsPlayerIntakeRuntime } from '../src/ycs-player-intake/runtime.ts';
const { configureIntakeCors, INTAKE_CORS_HEADERS } = await import(new URL('../player-intake/setup-cors.mjs', import.meta.url).href);

// Independent local gateway and S3-control protocol oracles. No real provider,
// bucket, CLI --apply, production entrypoint or remote repository is contacted.
const synthetic = { YCS_PLAYER_INTAKE_ENABLED: 'true', AWS_ACCESS_KEY_ID: 'SYNTHETIC_RUNTIME_ACCESS',
  AWS_SECRET_ACCESS_KEY: 'synthetic-runtime-private-secret-never-live' };
const defer = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function gateway(t: any, runtime: Awaited<ReturnType<typeof startYcsPlayerIntakeRuntime>>) {
  let captainCalls = 0;
  const app = await startLocalPublicPublisher({ profile: 'readonly', publishEnabled: false, publicOrigin: 'http://127.0.0.1:1', port: 0,
    apiRoute: combinePlayerIntakeApi(() => runtime, () => async (req, res) => {
      if (req.url !== '/captain-synthetic-protected') return false;
      captainCalls++; res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"captain_auth_required"}'); return true;
    }) });
  t.after(async () => { await runtime.stop(); await app.close(); });
  return { base: new URL(app.url).origin, captainCalls: () => captainCalls };
}

test('runtime verifier DEFAULT-01: disabled/invalid/missing credentials never load source and answer only intake namespace', async (t) => {
  for (const env of [{}, { YCS_PLAYER_ENABLED: 'true' }, { ...synthetic, YCS_PLAYER_INTAKE_ENABLED: 'TRUE' },
    { YCS_PLAYER_INTAKE_ENABLED: 'true' }, { ...synthetic, YCS_PLAYER_BUCKET: 'bad/bucket' }]) {
    assert.equal(readYcsPlayerIntakeConfig(env).enabled, false);
    const runtime = await startYcsPlayerIntakeRuntime({ env, loadDependencies: async () => assert.fail('closed gate loaded implementation') });
    const app = await gateway(t, runtime);
    const response = await fetch(app.base + '/api/player/v1/intake/context?Dis=cs', { headers: { origin: PLAYER_INTAKE_ORIGIN } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('access-control-allow-credentials'), null); assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'player_intake_not_configured' });
    assert.equal((await fetch(app.base + '/api/player/v1/session')).status, 404);
    assert.equal((await fetch(app.base + '/captain-synthetic-protected')).status, 401);
  }
});

test('runtime verifier ISOLATION-01: env allowlist, exact prefix, existing captain/MCP fallback and no full auth exposure', async (t) => {
  let selected: NodeJS.ProcessEnv = {}, invoked = 0;
  const runtime = await startYcsPlayerIntakeRuntime({ env: { ...synthetic, YCS_PLAYER_ENABLED: 'true',
    YCS_PLAYER_SESSION_SECRET: 'synthetic-session-secret', TELEGRAM_BOT_TOKEN: 'synthetic-bot-token', DATABASE_URL: 'synthetic-db-secret' },
    loadDependencies: async () => ({ createPlayerProfileHandler(options) {
      selected = options.env;
      return async (_req, res) => { invoked++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"accepted":true}'); return true; };
    } }) });
  assert.deepEqual(Object.keys(selected).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'YCS_PLAYER_ENABLED', 'YCS_PLAYER_INTAKE_ENABLED', 'YCS_PLAYER_ORIGIN'].sort());
  assert.equal(selected.YCS_PLAYER_ENABLED, 'false'); assert.equal(selected.YCS_PLAYER_ORIGIN, PLAYER_INTAKE_ORIGIN);
  const app = await gateway(t, runtime);
  assert.equal((await fetch(app.base + '/api/player/v1/intake/prepare')).status, 200);
  for (const path of ['/api/player/v1/auth/start', '/api/player/v1/me', '/api/player/v1/session', '/api/player/v1/intake-other',
    '/api/player/v1/intake%2Fprepare', '/api/player/v1/intake/../auth/start']) assert.equal((await fetch(app.base + path)).status, 404, path);
  assert.equal(invoked, 1); assert.equal((await fetch(app.base + '/captain-synthetic-protected')).status, 401); assert.equal(app.captainCalls(), 1);
  const response = await fetch(app.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).result.tools.map((tool: { name: string }) => tool.name), ['get_publisher_status']);
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
  assert.equal(JSON.stringify(runtime).includes(synthetic.AWS_SECRET_ACCESS_KEY), false);
});

test('runtime verifier SHUTDOWN-01: stop drains accepted call, rejects later calls and preserves other routes', async (t) => {
  const entered = defer(), release = defer(); let calls = 0;
  const runtime = await startYcsPlayerIntakeRuntime({ env: synthetic, loadDependencies: async () => ({ createPlayerProfileHandler: () => async (_req, res) => {
    calls++; entered.resolve(); await release.promise; res.writeHead(200); res.end('accepted before shutdown'); return true;
  } }) });
  t.after(() => release.resolve()); const app = await gateway(t, runtime);
  const accepted = fetch(app.base + '/api/player/v1/intake/complete'); await entered.promise;
  let done = false; const stop = runtime.stop(); stop.then(() => { done = true; }); assert.strictEqual(runtime.stop(), stop);
  assert.equal((await fetch(app.base + '/api/player/v1/intake/complete')).status, 503); assert.equal(done, false); assert.equal(calls, 1);
  assert.equal((await fetch(app.base + '/captain-synthetic-protected')).status, 401); assert.equal((await fetch(app.base + '/healthz')).status, 200);
  release.resolve(); assert.equal((await accepted).status, 200); await stop; assert.equal(runtime.state.status, 'stopped');
});

test('runtime verifier FAILURE-01: constructor/request errors do not reflect secret messages or expose full handler', async (t) => {
  const closed = await startYcsPlayerIntakeRuntime({ env: synthetic, loadDependencies: async () => { throw Error(synthetic.AWS_SECRET_ACCESS_KEY); } });
  assert.equal(closed.code, 'PLAYER_INTAKE_START_FAILED'); assert.equal(closed.enabled, false); assert.equal(JSON.stringify(closed).includes(synthetic.AWS_SECRET_ACCESS_KEY), false); await closed.stop();
  const broken = await startYcsPlayerIntakeRuntime({ env: synthetic, loadDependencies: async () => ({ createPlayerProfileHandler: () => async () => { throw Error(synthetic.AWS_SECRET_ACCESS_KEY); } }) });
  const app = await gateway(t, broken); const response = await fetch(app.base + '/api/player/v1/intake/context?Dis=cs');
  assert.equal(response.status, 503); assert.equal((await response.text()).includes(synthetic.AWS_SECRET_ACCESS_KEY), false);
});

test('runtime verifier CLOSURE-01: copied bytes equal manifest; adjacent accepted source is cross-checked when present; checker executes offline', async (t) => {
  const root = new URL('../player-intake/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const acceptedSource = new URL('../../yarcyberseason/', import.meta.url);
  let adjacentSourcePresent = false;
  try { adjacentSourcePresent = (await stat(acceptedSource)).isDirectory(); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (!adjacentSourcePresent) t.diagnostic('Adjacent source checkout absent; mandatory vendored manifest/hash/import checks still run.');
  const expected = ['backend/player-profile-api.mjs', 'backend/player-profile-auth.mjs', 'backend/player-profile-config.mjs',
    'backend/player-profile-intake.mjs', 'backend/player-profile-service.mjs', 'backend/player-profile-store.mjs', 'src/lib/player-profile-catalog.js', 'setup-cors.mjs'].sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), expected);
  for (const file of expected) {
    const actual = await readFile(new URL(file, root)); assert.equal(createHash('sha256').update(actual).digest('hex'), manifest.files[file], file);
    if (file !== 'setup-cors.mjs' && adjacentSourcePresent) assert.deepEqual(actual, await readFile(new URL(file, acceptedSource)), file);
  }
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'), manifest.packageFingerprint);
  const checker = spawnSync(process.execPath, ['scripts/check-ycs-player-intake-assets.mjs'], { cwd: new URL('../', import.meta.url),
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(checker.status, 0, checker.stderr); assert.match(checker.stdout, /YCS_PLAYER_INTAKE_ASSETS_VALID/);
  const main = await readFile(new URL('../src/production-main.ts', import.meta.url), 'utf8');
  assert.match(main, /combinePlayerIntakeApi\(\(\) => ycsPlayerIntake, \(\) => ycsCaptain\?\.apiRoute\)/);
  assert.match(main, /startStartupHttpListener\(config.port, ycsStatusRoute, ycsApiRoute\)/);
  assert.match(main, /startStartupHttpListener\(Number\(port\), ycsStatusRoute, ycsApiRoute\)/);
  assert.equal((main.match(/ycsPlayerIntake\?\.stop\(\)/g) || []).length, 3);
});

const originalRules = [{ ID: 'preserve-old-origin', AllowedOrigins: ['https://old.synthetic.invalid'], AllowedMethods: ['GET'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 },
  { ID: 'preserve-captains', AllowedOrigins: [PLAYER_INTAKE_ORIGIN], AllowedMethods: ['GET'], AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'] }];
function corsFixture({ initialReadError = false, missingRules = false, concurrent = false, loseWriteAck = false, writeWithoutEffect = false,
  lostReadback = false, mismatchedReadback = false } = {}) {
  let reads = 0; const state = { rules: structuredClone(originalRules), calls: [] as string[], writes: [] as any[] };
  const s3 = { async send(command: any) {
    const kind = command.constructor.name; state.calls.push(kind);
    if (kind === 'GetBucketCorsCommand') {
      reads++;
      if (initialReadError || lostReadback && reads === 3) throw Object.assign(Error(synthetic.AWS_SECRET_ACCESS_KEY), { name: 'AccessDenied' });
      if (missingRules) return {};
      if (concurrent && reads === 2) state.rules.push({ ...originalRules[0]!, ID: 'another-operator' });
      return { CORSRules: structuredClone(state.rules) };
    }
    assert.equal(kind, 'PutBucketCorsCommand'); state.writes.push(structuredClone(command.input));
    if (!writeWithoutEffect) state.rules = structuredClone(command.input.CORSConfiguration.CORSRules);
    if (mismatchedReadback) state.rules.pop();
    if (loseWriteAck) throw Error(synthetic.AWS_SECRET_ACCESS_KEY); return {};
  } };
  return { s3, state };
}

test('runtime verifier CORS-01: plan has no write; explicit merge preserves all existing rules and exact readback', async () => {
  const plan = corsFixture(); assert.equal((await configureIntakeCors({ s3: plan.s3 })).status, 'prepared'); assert.deepEqual(plan.state.calls, ['GetBucketCorsCommand']);
  const f = corsFixture(); const result = await configureIntakeCors({ s3: f.s3, apply: true }); assert.equal(result.status, 'verified');
  assert.deepEqual(f.state.rules.slice(0, 2), originalRules); assert.equal(f.state.writes.length, 1);
  const added = f.state.rules.at(-1) as any; assert.deepEqual(added.AllowedOrigins, [PLAYER_INTAKE_ORIGIN]);
  assert.deepEqual(added.AllowedMethods, ['PUT', 'GET', 'HEAD']); assert.deepEqual(added.AllowedHeaders, INTAKE_CORS_HEADERS);
  assert.equal(added.AllowedHeaders.some((header: string) => /authorization|cookie|^\*$/.test(header.toLowerCase())), false);
  assert.equal((await configureIntakeCors({ s3: f.s3, apply: true })).status, 'unchanged'); assert.equal(f.state.writes.length, 1);
});

test('runtime verifier CORS-02: read denial, absent response field and concurrent edits never replace CORS', async () => {
  for (const options of [{ initialReadError: true }, { missingRules: true }, { concurrent: true }]) {
    const f = corsFixture(options);
    await assert.rejects(configureIntakeCors({ s3: f.s3, apply: true }), (error: any) => {
      assert.equal(error.message.includes(synthetic.AWS_SECRET_ACCESS_KEY), false); return true;
    });
    assert.equal(f.state.writes.length, 0);
  }
});

test('runtime verifier CORS-03: lost write ACK needs exact readback; unknown or mismatched outcomes never claim verified or retry write', async () => {
  const recovered = corsFixture({ loseWriteAck: true }); assert.equal((await configureIntakeCors({ s3: recovered.s3, apply: true })).status, 'verified'); assert.equal(recovered.state.writes.length, 1);
  for (const [options, code] of [[{ loseWriteAck: true, writeWithoutEffect: true }, 'CORS_WRITE_UNKNOWN'],
    [{ lostReadback: true }, 'CORS_WRITE_UNKNOWN'], [{ mismatchedReadback: true }, 'CORS_READBACK_MISMATCH']] as const) {
    const f = corsFixture(options); await assert.rejects(configureIntakeCors({ s3: f.s3, apply: true }), new RegExp(code)); assert.equal(f.state.writes.length, 1);
  }
});

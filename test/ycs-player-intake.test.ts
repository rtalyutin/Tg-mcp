import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startLocalPublicPublisher } from '../src/secret-server.ts';
import { combinePlayerIntakeApi, PLAYER_INTAKE_ORIGIN, readYcsPlayerIntakeConfig, startYcsPlayerIntakeRuntime } from '../src/ycs-player-intake/runtime.ts';

const source = new URL('../player-intake/', import.meta.url);
const [{ createPlayerProfileHandler }, { createPlayerS3Store }] = await Promise.all([
  import(new URL('backend/player-profile-api.mjs', source).href), import(new URL('backend/player-profile-store.mjs', source).href),
]);
const credentials = { AWS_ACCESS_KEY_ID: 'synthetic-intake-runtime-access', AWS_SECRET_ACCESS_KEY: 'synthetic-intake-runtime-secret-private' };
const settings = { ...credentials, YCS_PLAYER_INTAKE_ENABLED: 'true' };
const post = (base: string, path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { origin: PLAYER_INTAKE_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('anonymous runtime is a separate opt-in, narrows env and exposes only the intake prefix before existing MCP/captain', async t => {
  for (const env of [{}, credentials, { ...credentials, YCS_PLAYER_ENABLED: 'true' }, { ...settings, YCS_PLAYER_INTAKE_ENABLED: 'invalid' },
    { YCS_PLAYER_INTAKE_ENABLED: 'true' }, { ...settings, YCS_PLAYER_ORIGIN: 'https://site.example/path' }]) {
    assert.equal(readYcsPlayerIntakeConfig(env).enabled, false);
    const runtime = await startYcsPlayerIntakeRuntime({ env, loadDependencies: async () => assert.fail('disabled runtime must not load a source handler') });
    assert.equal(runtime.enabled, false); await runtime.stop();
  }
  let seen: NodeJS.ProcessEnv | undefined; let invoked = 0;
  const runtime = await startYcsPlayerIntakeRuntime({ env: { ...settings, YCS_PLAYER_ENABLED: 'true', YCS_PLAYER_SESSION_SECRET: 'must-not-pass', TELEGRAM_BOT_TOKEN: 'must-not-pass', DATABASE_URL: 'must-not-pass' },
    loadDependencies: async () => ({ createPlayerProfileHandler(options) {
      seen = options.env;
      return async (_req, res) => { invoked++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"mode":"intake-only"}'); return true; };
    } }) });
  t.after(() => runtime.stop()); assert.equal(runtime.enabled, true); assert.equal(seen?.YCS_PLAYER_ENABLED, 'false'); assert.equal(seen?.YCS_PLAYER_ORIGIN, PLAYER_INTAKE_ORIGIN);
  for (const key of ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'YCS_PLAYER_SESSION_SECRET']) assert.equal(seen?.[key], undefined);
  const app = await startLocalPublicPublisher({ profile: 'readonly', publishEnabled: false, publicOrigin: 'http://127.0.0.1:34876', port: 0,
    apiRoute: combinePlayerIntakeApi(() => runtime, () => async (req, res) => {
      if (req.url !== '/api/captain') return false;
      res.writeHead(401); res.end('captain-auth-preserved'); return true;
    }) }); t.after(() => app.close()); const base = new URL(app.url).origin;
  const intake = await post(base, '/api/player/v1/intake/prepare', {}); assert.equal(intake.status, 200); assert.equal(invoked, 1);
  for (const path of ['/api/player/v1/session', '/api/player/v1/auth/start', '/api/player/v1/me', '/api/player/v1/intake-extra']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/api/captain')).status, 401); assert.equal((await fetch(base + '/healthz')).status, 200);
  const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(mcp.status, 200); assert.deepEqual((await mcp.json()).result.tools.map((tool: { name: string }) => tool.name), ['get_publisher_status']); assert.equal(invoked, 1);
});

test('actual vendored intake prepares and completes with injected S3 only; no account API or cookie is exposed', async t => {
  type Stored = { body: Buffer; Metadata: Record<string, string>; ETag: string; ContentType?: string };
  const objects = new Map<string, Stored>(); const grants: Array<{ method: string; key: string; expiresIn: number }> = [];
  const s3 = { async send(command: { constructor: { name: string }; input: { Key: string; Body?: Buffer | string; ContentType?: string; Metadata?: Record<string, string>; IfMatch?: string; IfNoneMatch?: string; ACL?: string } }) {
    const p = command.input; const current = objects.get(p.Key);
    if (command.constructor.name === 'HeadObjectCommand') {
      if (!current) throw Object.assign(Error('missing'), { name: 'NoSuchKey' }); return current;
    }
    if (command.constructor.name === 'DeleteObjectCommand') { assert.ok(p.Key.includes('/staging/')); assert.equal(p.IfMatch, current?.ETag); objects.delete(p.Key); return {}; }
    if (command.constructor.name === 'GetObjectCommand') { if (!current) throw Object.assign(Error('missing'), { name: 'NoSuchKey' }); return { ...current, Body: Readable.from([current.body]), ContentLength: current.body.length }; }
    assert.equal(command.constructor.name, 'PutObjectCommand'); assert.equal(p.ACL, 'private');
    if (p.IfNoneMatch === '*' && current || p.IfMatch && p.IfMatch.replaceAll('"', '') !== current?.ETag.replaceAll('"', '')) throw Object.assign(Error('condition'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    const body = Buffer.isBuffer(p.Body) ? p.Body : Buffer.from(p.Body || ''); objects.set(p.Key, { body, Metadata: p.Metadata || {}, ContentType: p.ContentType, ETag: `"${createHash('md5').update(body).digest('hex')}"` }); return {};
  } };
  const runtime = await startYcsPlayerIntakeRuntime({ env: settings, loadDependencies: async () => ({ createPlayerProfileHandler(options) {
    const store = createPlayerS3Store({ env: options.env, s3, presign: async (_client: unknown, command: { constructor: { name: string }; input: { Key: string } }, opts: { expiresIn: number }) => {
      grants.push({ method: command.constructor.name === 'PutObjectCommand' ? 'PUT' : 'GET', key: command.input.Key, expiresIn: opts.expiresIn });
      return `https://storage.synthetic.invalid/${command.input.Key.split('/').map(encodeURIComponent).join('/')}?capability=synthetic`;
    } });
    return createPlayerProfileHandler({ ...options, store });
  } }) }); t.after(() => runtime.stop());
  const app = await startLocalPublicPublisher({ profile: 'readonly', publishEnabled: false, publicOrigin: 'http://127.0.0.1:34876', port: 0, apiRoute: runtime.apiRoute }); t.after(() => app.close()); const base = new URL(app.url).origin;
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#345678' } }).jpeg().toBuffer();
  const prepared = await post(base, '/api/player/v1/intake/prepare', { requestId: randomUUID(), Dis: 'cs', nickname: 'native-runtime', name: null,
    sha256: createHash('sha256').update(image).digest('hex'), size: image.length, contentType: 'image/jpeg' });
  assert.equal(prepared.status, 200); assert.equal(prepared.headers.get('set-cookie'), null); const body = await prepared.json(); assert.equal(grants[0]?.expiresIn, 300);
  const stage = grants[0]!.key; objects.set(stage, { body: image, ContentType: 'image/jpeg', ETag: '"staging"', Metadata: {
    owner: body.upload.headers['x-amz-meta-owner'], fingerprint: body.upload.headers['x-amz-meta-fingerprint'] } });
  const completed = await post(base, '/api/player/v1/intake/complete', { ticket: body.ticket }); assert.equal(completed.status, 200); const saved = await completed.json();
  assert.equal(saved.photo.filename, '??-native-runtime.jpg'); assert.equal(saved.stagingCleanup, 'deleted'); assert.equal(grants.at(-1)?.expiresIn, 60);
  const final = objects.get(grants.at(-1)!.key)!; assert.equal(createHash('sha256').update(final.body).digest('hex'), saved.photo.sha256); assert.equal(final.body.length, saved.photo.size);
  assert.deepEqual(JSON.parse(objects.get('private/player-profiles/v1/state.json')!.body.toString()).accounts, {});
  assert.equal((await post(base, '/api/player/v1/intake/complete', { ticket: body.ticket })).status, 200);
  assert.equal([...objects.keys()].filter(key => key.includes('/photos/')).length, 1); assert.equal((await fetch(base + '/api/player/v1/session')).status, 404);
});

test('shutdown drains accepted intake operations, refuses later traffic and safely handles dependency errors', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await startYcsPlayerIntakeRuntime({ env: settings, loadDependencies: async () => ({ createPlayerProfileHandler: () => async (_req, res) => {
    entered(); await gate; res.writeHead(200); res.end('accepted'); return true;
  } }) });
  const app = await startLocalPublicPublisher({ profile: 'readonly', publishEnabled: false, publicOrigin: 'http://127.0.0.1:34876', port: 0, apiRoute: runtime.apiRoute });
  t.after(async () => { release(); await runtime.stop(); await app.close(); }); const base = new URL(app.url).origin;
  const pending = post(base, '/api/player/v1/intake/complete', {}); await started;
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; }); assert.equal(runtime.stop(), runtime.stop());
  assert.equal((await post(base, '/api/player/v1/intake/complete', {})).status, 503); assert.equal(stopped, false); assert.equal((await fetch(base + '/healthz')).status, 200);
  release(); assert.equal((await pending).status, 200); await stopping; assert.equal(runtime.state.status, 'stopped');
  const failed = await startYcsPlayerIntakeRuntime({ env: settings, loadDependencies: async () => { throw Error(credentials.AWS_SECRET_ACCESS_KEY); } });
  assert.equal(failed.code, 'PLAYER_INTAKE_START_FAILED'); assert.ok(!JSON.stringify(failed).includes(credentials.AWS_SECRET_ACCESS_KEY)); await failed.stop();
});

test('copied closure is hash pinned and production integration starts/drains it without changing collectors', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 8);
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(new URL(file, source))).digest('hex'), hash);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'), manifest.packageFingerprint);
  const main = await readFile(new URL('../src/production-main.ts', import.meta.url), 'utf8');
  assert.match(main, /combinePlayerIntakeApi\(\(\) => ycsPlayerIntake, \(\) => ycsCaptain\?\.apiRoute\)/);
  assert.match(main, /ycsPlayerIntake = await startYcsPlayerIntakeRuntime\(\)/);
  assert.equal((main.match(/ycsPlayerIntake\?\.stop\(\)/g) || []).length, 3);
});

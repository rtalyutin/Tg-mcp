import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AdmissionQueue } from '../src/outreach/admission-queue.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { migrateOutreach } from '../src/outreach/database.ts';
import { generateLogin } from '../src/outreach/access.ts';

const allowed = { allowed: true, retryAfter: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const source = { url: 'https://queue-qa.example.test/company', retrieved_at: '2026-09-22T12:00:00Z', claim: 'Synthetic queue fixture', verification: 'Independent local QA' };
const candidateInput = (name: string) => ({ name, sources: [source], rationale: 'Synthetic queue verification', request_id: randomUUID() });
const mcpBody = (name: string, args: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function controlledApp(attempt: (ip: string) => Promise<typeof allowed>) {
  // HTTP integration with a controlled dependency. This fixture is not SQL evidence.
  const app = await startLocalOutreach({ pool: {} as pg.Pool, trustedProxyCidrs: ['127.0.0.0/8'] });
  const state = { authChecks: 0, rateWrites: 0, events: [] as unknown[] };
  app.access.admitIp = attempt;
  app.access.authenticateLogin = async () => { state.authChecks++; return null; };
  app.access.recordAccess = async event => { state.events.push(event); };
  app.access.recordRateRejection = async () => { state.rateWrites++; };
  const request = (path: string, ip: string, init: RequestInit = {}) => fetch(app.url + path, {
    ...init, headers: { 'x-forwarded-for': ip, ...init.headers },
  });
  return { app, state, request };
}

test('held-out queue: global capacity composes across sixteen full IP lanes and close drains safely', async () => {
  const gate = deferred<typeof allowed>(); let attempts = 0;
  const queue = new AdmissionQueue(async () => { attempts++; return gate.promise; });
  const pending = Array.from({ length: 64 }, (_, i) => queue.acquire(`192.0.2.${Math.floor(i / 4) + 1}`, new AbortController().signal));
  await Promise.resolve();
  assert.equal(attempts, 16, 'one outstanding admission attempt per IP lane');
  assert.equal(await queue.acquire('192.0.2.17', new AbortController().signal), 'limited');
  assert.equal(await queue.acquire('192.0.2.1', new AbortController().signal), 'limited');
  queue.close();
  assert.ok((await Promise.all(pending)).every(result => result === 'closed'));
  let drained = false; const draining = queue.drained().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  gate.resolve(allowed); await draining;
  assert.equal(attempts, 16, 'followers cancelled by close never reach the dependency');
  assert.equal(await queue.acquire('192.0.2.17', new AbortController().signal), 'closed');
});

test('held-out queue HTTP: four slots, prompt overflow, five-second deadline and no late authentication', async () => {
  const gate = deferred<typeof allowed>(); const started = deferred<void>(); let attempts = 0;
  const { app, state, request } = await controlledApp(async () => { attempts++; started.resolve(); return gate.promise; });
  const secret = generateLogin(); const path = `/mcp?login=${encodeURIComponent(secret)}`;
  const began = performance.now();
  const waiting = Array.from({ length: 4 }, () => request(path, '192.0.2.30', { method: 'POST', headers: mcpHeaders, body: mcpBody('search_companies', {}) }));
  try {
    await started.promise; await sleep(50); // let all four raw HTTP fixtures reach the queue
    const overflowAt = performance.now();
    const overflow = await request(path, '192.0.2.30', { method: 'POST', headers: mcpHeaders, body: mcpBody('search_companies', {}) });
    assert.equal(overflow.status, 429); assert.ok(performance.now() - overflowAt < 1000);
    assert.equal((await request('/healthz', '192.0.2.30')).status, 200);
    assert.equal((await request('/assets/app.css', '192.0.2.30')).status, 200);
    const results = await Promise.all(waiting);
    const elapsed = performance.now() - began;
    assert.ok(elapsed >= 4950 && elapsed < 6500, `HTTP deadline ${elapsed}ms`);
    for (const result of [...results, overflow]) {
      assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '1');
      const body = await result.text(); assert.equal(body, '{"code":"RATE_LIMITED"}');
      assert.ok(!body.includes(secret) && !body.includes(encodeURIComponent(secret)));
    }
    assert.equal(state.authChecks, 0); assert.equal(attempts, 1);
    gate.resolve(allowed); await app.close();
    assert.equal(state.authChecks, 0); assert.equal(attempts, 1); assert.equal(state.rateWrites, 5);
  } finally { gate.resolve(allowed); await app.close(); }
});

test('held-out queue HTTP: disconnect, shutdown and dependency errors cannot reach authentication', async () => {
  const gate = deferred<typeof allowed>(); let started = deferred<void>();
  const { app, state, request } = await controlledApp(async () => { started.resolve(); return gate.promise; });
  const secret = generateLogin(); const path = `/mcp?login=${encodeURIComponent(secret)}`;
  const init = { method: 'POST', headers: mcpHeaders, body: mcpBody('upsert_company_candidate', candidateInput('Never written')) };
  try {
    const cancellation = new AbortController();
    const disconnected = request(path, '192.0.2.40', { ...init, signal: cancellation.signal }).catch(error => error);
    await started.promise; cancellation.abort(); await disconnected;
    started = deferred<void>();
    const waiting = request(path, '192.0.2.41', init);
    await started.promise;
    const closing = app.close(); assert.equal(app.close(), closing);
    const response = await waiting; assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' });
    gate.resolve(allowed); await closing;
    assert.equal(state.authChecks, 0); assert.equal(state.rateWrites, 0);
  } finally { gate.resolve(allowed); await app.close(); }
  const broken = await controlledApp(async () => { throw new Error('SYNTHETIC_PRIVATE_DEPENDENCY_DETAIL'); });
  const logged: string[] = []; const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const response = await broken.request(path, '192.0.2.42', init);
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('SYNTHETIC_PRIVATE_DEPENDENCY_DETAIL'), false);
    assert.equal(broken.state.authChecks, 0);
    assert.ok(logged.length > 0 && logged.every(line => !line.includes('SYNTHETIC_PRIVATE_DEPENDENCY_DETAIL') && !line.includes(secret)));
  } finally { console.error = originalError; await broken.app.close(); }
});

test('held-out queue HTTP: every overflow remains counted when audit writes are delayed but succeed', async () => {
  const admission = deferred<typeof allowed>(); const audit = deferred<void>(); const started = deferred<void>();
  const { app, state, request } = await controlledApp(async () => { started.resolve(); return admission.promise; });
  let completedWrites = 0;
  app.access.recordRateRejection = async () => { await audit.promise; completedWrites++; };
  const controls = Array.from({ length: 4 }, () => new AbortController());
  const waiting = controls.map(controller => request('/login', '192.0.2.50', { signal: controller.signal }).catch(() => undefined));
  const logged: string[] = []; const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await started.promise; await sleep(50);
    for (let i = 0; i < 70; i++) assert.equal((await request('/login', '192.0.2.50')).status, 429);
    for (const controller of controls) controller.abort();
    await Promise.all(waiting); audit.resolve(); admission.resolve(allowed);
    await app.close();
    assert.equal(state.authChecks, 0);
    assert.equal(completedWrites, 70, '70 actual HTTP rejections require 70 events or an equivalent exact aggregate; the dependency did not fail');
  } finally {
    console.error = originalError;
    controls.forEach(controller => controller.abort()); audit.resolve(); admission.resolve(allowed);
    await app.close();
  }
});

test('held-out queue SQL/HTTP: plain SDK, authorization after waiting and shared admission interval', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false,
}, async t => {
  const connectionString = process.env.OUTREACH_TEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString });
  const schema = `queue_heldout_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  const cleanup: { apps: Awaited<ReturnType<typeof startLocalOutreach>>[] } = { apps: [] };
  t.after(async () => { for (const app of cleanup.apps) await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await migrateOutreach(pool);
  await pool.query(`CREATE TABLE queue_qa_admissions(ip inet, admitted_at timestamptz);
    CREATE FUNCTION queue_qa_record_admission() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO queue_qa_admissions VALUES(NEW.ip,NEW.last_admitted_at); RETURN NEW; END; $$;
    CREATE TRIGGER queue_qa_record_admission AFTER UPDATE OF last_admitted_at ON outreach_ip_rates
    FOR EACH ROW EXECUTE FUNCTION queue_qa_record_admission()`);
  const app = await startLocalOutreach({ pool, trustedProxyCidrs: ['127.0.0.0/8'] }); cleanup.apps.push(app);
  const second = await startLocalOutreach({ pool, trustedProxyCidrs: ['127.0.0.0/8'] }); cleanup.apps.push(second);
  const secret = generateLogin(); const credential = await app.access.addLogin(secret, 'Independent queue fixture');
  const endpoint = `/mcp?login=${encodeURIComponent(secret)}`;
  const request = (target: typeof app, path: string, ip: string, init: RequestInit = {}) => fetch(target.url + path, {
    ...init, headers: { 'x-forwarded-for': ip, ...init.headers },
  });
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['companies', 'candidates', 'contacts', 'opportunities', 'operations', 'audit']) result[table] = (await pool.query(`SELECT * FROM outreach_${table} ORDER BY id`)).rows;
    return result;
  };
  await t.test('unmodified MCP SDK connects and writes/reads without custom fetch or sleeps', async () => {
    const client = new Client({ name: 'independent-unpaced-sdk', version: '1' });
    const errors: Error[] = []; client.onerror = error => errors.push(error);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + endpoint)));
      assert.equal((await client.listTools()).tools.length, 10);
      const created = await client.callTool({ name: 'upsert_company_candidate', arguments: candidateInput('Unpaced SDK fixture') });
      assert.notEqual(created.isError, true);
      const id = (created.structuredContent as { candidate_id: string }).candidate_id;
      const read = await client.callTool({ name: 'get_company', arguments: { id } });
      assert.equal((read.structuredContent as { id: string }).id, id); assert.deepEqual(errors, []);
    } finally { await client.close(); }
  });
  await t.test('revoking MCP permission during queue wait denies the eventual mutation', async () => {
    const before = await snapshot();
    assert.equal((await request(app, '/login', '198.51.100.1')).status, 200);
    const waiting = request(app, endpoint, '198.51.100.1', { method: 'POST', headers: mcpHeaders, body: mcpBody('upsert_company_candidate', candidateInput('Revoked while waiting')) });
    await app.access.revokeLogin(credential.id);
    const response = await waiting; assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.result.isError, true);
    assert.deepEqual(body.result.structuredContent, { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' });
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('revoking owner session during queue wait also denies the eventual mutation', async () => {
    await app.access.seedOwner('queue-owner', 'Synthetic queue owner password');
    const owner = await app.access.authenticateOwner('queue-owner', 'Synthetic queue owner password');
    const session = await app.access.createSession(owner!.id); const before = await snapshot();
    assert.equal((await request(app, '/login', '198.51.100.2')).status, 200);
    const waiting = request(app, '/api/v1/candidates', '198.51.100.2', { method: 'POST', headers: {
      'content-type': 'application/json', origin: app.url, cookie: `ycs_session=${session.token}`, 'x-csrf-token': session.csrfToken,
    }, body: JSON.stringify(candidateInput('Owner logged out while waiting')) });
    await app.access.revokeSession(session.token);
    assert.equal((await waiting).status, 503); assert.deepEqual(await snapshot(), before);
  });
  await t.test('two application instances preserve every 1000ms DB interval and do not log polling as rejection', async () => {
    const ip = '198.51.100.3';
    assert.equal((await request(app, '/login', ip)).status, 200);
    const results = await Promise.all([app, second, app, second].map(target => request(target, '/login', ip)));
    assert.deepEqual(results.map(result => result.status), [200, 200, 200, 200]);
    const admissions = (await pool.query(`SELECT extract(epoch FROM admitted_at)::numeric*1000 AS ms FROM queue_qa_admissions WHERE ip=$1 ORDER BY admitted_at`, [ip])).rows.map(row => Number(row.ms));
    assert.equal(admissions.length, 5);
    for (let i = 1; i < admissions.length; i++) assert.ok(admissions[i] - admissions[i - 1] >= 1000, `DB interval ${admissions[i] - admissions[i - 1]}ms`);
    assert.equal((await pool.query('SELECT sum(rejected_count)::int AS n FROM outreach_rate_rejections WHERE ip=$1', [ip])).rows[0].n, null);
    const logs = JSON.stringify((await pool.query('SELECT * FROM outreach_access_events')).rows);
    assert.ok(!logs.includes(secret) && !logs.includes(encodeURIComponent(secret)) && !logs.includes('Synthetic queue owner password'));
  });
});

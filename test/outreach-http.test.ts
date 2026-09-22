import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { migrateOutreach } from '../src/outreach/database.ts';
import { generateLogin } from '../src/outreach/access.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const source = { url: 'https://example.test/about', retrieved_at: '2026-09-20T10:00:00Z', claim: 'Synthetic test company', verification: 'Synthetic fixture, no commercial claim' };

test('HTTP owner/MCP isolation and shared persistent registry under the actual rate policy', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false,
}, async t => {
  const admin = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL });
  const schema = `http_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  await migrateOutreach(pool); await migrateOutreach(pool);
  const app = await startLocalOutreach({ pool });
  const secret = generateLogin(); const otherSecret = generateLogin();
  const credential = await app.access.addLogin(secret, 'Synthetic MCP test');
  await app.access.seedOwner('owner', 'Synthetic password for local tests');
  const endpoint = `${app.url}/mcp?login=${encodeURIComponent(secret)}`;
  let cookie = '', csrf = ''; let companyId = '';
  let last = 0;
  // This is a controlled pacing adapter, NOT evidence that ChatGPT/Codex implement pacing.
  let requests: Promise<unknown> = Promise.resolve();
  const pacedFetch: typeof fetch = (input, init) => {
    const pending = requests.then(async () => {
      await sleep(Math.max(0, 1060 - (Date.now() - last)));
      const result = await fetch(input, init); last = Date.now(); return result;
    });
    requests = pending.catch(() => {});
    return pending;
  };
  const ownerPost = async (path: string, body: unknown, token = csrf) => pacedFetch(app.url + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.url, cookie, 'x-csrf-token': token }, body: JSON.stringify(body),
  });
  const client = new Client({ name: 'paced-local-test', version: '1' });
  try {
    await t.test('ordinary SDK connects, lists and calls without client pacing or transport errors', async () => {
      const fast = new Client({ name: 'unpaced-local-test', version: '1' });
      const errors: Error[] = []; fast.onerror = error => errors.push(error);
      try {
        await fast.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        assert.equal((await fast.listTools()).tools.length, 6);
        const result = await fast.callTool({ name: 'search_companies', arguments: {} });
        assert.notEqual(result.isError, true); assert.deepEqual(errors, []);
      } finally { await fast.close(); }
    });
    await t.test('same IP cannot evade limit with login, route, another app instance or spoofed XFF', async () => {
      const second = await startLocalOutreach({ pool });
      try {
        const response = await pacedFetch(app.url + '/login'); assert.equal(response.status, 200);
        const before = (await pool.query("SELECT last_admitted_at FROM outreach_ip_rates WHERE ip='127.0.0.1'")).rows[0].last_admitted_at;
        const delayed = await fetch(second.url + '/api/v1/companies', { headers: { 'x-forwarded-for': '192.0.2.77' } });
        assert.equal(delayed.status, 503);
        const after = (await pool.query("SELECT last_admitted_at FROM outreach_ip_rates WHERE ip='127.0.0.1'")).rows[0].last_admitted_at;
        assert.ok(new Date(after).getTime() - new Date(before).getTime() >= 1000);
        assert.equal((await fetch(app.url + '/assets/app.css')).status, 200);
        assert.equal((await fetch(app.url + '/healthz')).status, 200);
      } finally { await second.close(); }
    });
    await t.test('paced MCP reads and writes; one shared candidate appears to another connection', async () => {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch: pacedFetch }));
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 6);
      assert.ok(!tools.tools.some(x => /approve|send|resolve/.test(x.name)));
      const result = await client.callTool({ name: 'upsert_company_candidate', arguments: { name: 'Test <script>alert(1)</script>', sources: [source], rationale: 'Synthetic', request_id: randomUUID() } });
      assert.notEqual(result.isError, true);
      const id = (result.structuredContent as { candidate_id: string }).candidate_id;
      const read = await client.callTool({ name: 'get_company', arguments: { id } });
      assert.equal((read.structuredContent as { id: string }).id, id);
    });
    await t.test('unknown login always receives unavailable and cannot inspect known IDs or mutate', async () => {
      const before = await pool.query('SELECT count(*) FROM outreach_candidates');
      for (const query of ['', `?login=${encodeURIComponent(otherSecret)}`, `?login=${encodeURIComponent(secret)}&login=${encodeURIComponent(secret)}`]) {
        const response = await pacedFetch(app.url + '/mcp' + query, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'upsert_company_candidate', arguments: { name: 'Should never exist' } } }) });
        const body = await response.json();
        assert.equal(body.result.isError, true);
        assert.deepEqual(body.result.structuredContent, { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' });
        assert.ok(!JSON.stringify(body).includes(secret));
      }
      assert.deepEqual((await pool.query('SELECT count(*) FROM outreach_candidates')).rows, before.rows);
      assert.equal((await pacedFetch(app.url + '/api/v1/companies?login=' + encodeURIComponent(secret))).status, 503);
    });
    await t.test('owner login creates separate cookie; CSRF fails; candidate resolves into visible company', async () => {
      assert.equal((await ownerPost('/login', { login: 'owner', password: 'wrong' })).status, 503);
      const response = await ownerPost('/login', { login: 'owner', password: 'Synthetic password for local tests' });
      assert.equal(response.status, 200);
      cookie = response.headers.get('set-cookie')!.split(';')[0];
      assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
      const page = await pacedFetch(app.url + '/', { headers: { cookie } });
      const content = await page.text();
      assert.ok(content.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(!content.includes('<script>alert(1)</script>'));
      csrf = /name="csrf-token" content="([^"]+)"/.exec(content)![1];
      const candidate = (await app.registry.searchCompanies({})).items[0];
      const command = { candidate_id: candidate.id, expected_version: candidate.version, request_id: randomUUID() };
      assert.equal((await ownerPost('/api/v1/candidates/resolve', command, 'wrong')).status, 403);
      const resolved = await ownerPost('/api/v1/candidates/resolve', command);
      assert.equal(resolved.status, 200);
      companyId = (await resolved.json()).company_id;
      const card = await pacedFetch(app.url + '/companies/' + companyId, { headers: { cookie } });
      assert.equal(card.status, 200); assert.ok((await card.text()).includes('Контакты'));
      assert.equal((await client.callTool({ name: 'get_company', arguments: { id: companyId } })).isError, undefined);
    });
    await t.test('revocation affects existing MCP client; logout invalidates web session; no secrets in audit', async () => {
      await app.access.revokeLogin(credential.id);
      const response = await client.callTool({ name: 'get_company', arguments: { id: companyId } });
      assert.equal(response.isError, true);
      assert.equal((await ownerPost('/logout', {})).status, 200);
      assert.equal((await pacedFetch(app.url + '/api/v1/companies', { headers: { cookie } })).status, 503);
      const events = JSON.stringify((await pool.query('SELECT * FROM outreach_access_events')).rows);
      for (const value of [secret, encodeURIComponent(secret), otherSecret, 'Synthetic password for local tests', cookie]) assert.ok(!events.includes(value));
    });
  } finally {
    await client.close(); await app.close(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { migrateOutreach } from '../src/outreach/database.ts';
import { Registry, RegistryError } from '../src/outreach/registry.ts';
import { generateLogin } from '../src/outreach/access.ts';

// Independent, synthetic, loopback-only fixtures. No Telegram/mail credentials.
const source = { url: 'https://qa.example.test/company', retrieved_at: '2026-09-20T12:00:00Z', claim: 'Held-out synthetic record', verification: 'QA fixture' };
const input = (name: string) => ({ name, sources: [source], rationale: 'Held-out QA', request_id: randomUUID() });
const code = (expected: string) => (error: unknown) => error instanceof RegistryError && error.code === expected;

test('held-out HTTP trust boundaries and transaction rollback', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false,
}, async t => {
  const connectionString = process.env.OUTREACH_TEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString });
  const schema = `heldout_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  const cleanup = { closeApp: async () => {} };
  t.after(async () => {
    await cleanup.closeApp(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  await migrateOutreach(pool);
  const app = await startLocalOutreach({ pool, trustedProxyCidrs: ['127.0.0.0/8'] });
  cleanup.closeApp = app.close;
  let address = 0;
  const fetchLocal = (path: string, options: RequestInit = {}, ip?: string) => fetch(app.url + path, {
    ...options, headers: { 'x-forwarded-for': ip ?? `192.0.2.${++address}`, ...options.headers },
  });
  const businessSnapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['companies', 'candidates', 'contacts', 'opportunities', 'operations', 'audit']) {
      result[table] = (await pool.query(`SELECT * FROM outreach_${table} ORDER BY id`)).rows;
    }
    return result;
  };
  const secret = generateLogin();
  await app.access.addLogin(secret, 'Held-out synthetic credential');
  await app.access.seedOwner('heldout-owner', 'Held-out synthetic owner password');
  const candidate = await app.registry.upsertCompanyCandidate(input('Hidden held-out company'), 'mcp:fixture');
  const resolved = await app.registry.resolveCandidate({ candidate_id: candidate.candidate_id, expected_version: 1, request_id: randomUUID() }, 'owner:fixture');
  const companyId = resolved.company_id;
  const owner = await app.access.authenticateOwner('heldout-owner', 'Held-out synthetic owner password');
  const session = await app.access.createSession(owner!.id);
  const cookie = `ycs_session=${session.token}`;
  const rpc = async (query: string, name: string, args: unknown, headers: Record<string, string> = {}) => {
    const response = await fetchLocal(`/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('location'), null);
    return response.json();
  };
  {
    await t.test('known IDs, owner cookie and forged MCP session never authorize missing/wrong query login', async () => {
      const before = await businessSnapshot();
      const queries = ['', `?login=${encodeURIComponent(generateLogin())}`, `?login=${encodeURIComponent(secret)}&extra=1`];
      for (const query of queries) {
        for (const [name, args] of [
          ['get_company', { id: companyId }],
          ['get_operation', { operation_id: resolved.operation_id }],
          ['upsert_company_candidate', input('Must not be written')],
          ['resolve_candidate', { candidate_id: candidate.candidate_id, expected_version: 2, request_id: randomUUID() }],
        ] as const) {
          const body = await rpc(query, name, args, { cookie, 'mcp-session-id': randomUUID() });
          assert.deepEqual(body.result, { isError: true, content: [{ type: 'text', text: '{"code":"SERVICE_UNAVAILABLE","status":"unavailable"}' }], structuredContent: { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' } });
          assert.ok(!JSON.stringify(body).includes(companyId));
        }
      }
      assert.deepEqual(await businessSnapshot(), before);
    });

    await t.test('valid MCP login cannot resolve via tool name/arguments or reach owner routes', async () => {
      const before = await businessSnapshot();
      const query = `?login=${encodeURIComponent(secret)}`;
      const direct = await rpc(query, 'resolve_candidate', { candidate_id: candidate.candidate_id, expected_version: 2, actor_id: 'owner:forged', request_id: randomUUID() });
      assert.equal(direct.result.isError, true);
      assert.equal(direct.result.structuredContent.code, 'UNKNOWN_TOOL');
      const injected = await rpc(query, 'upsert_company_candidate', { ...input('Forged owner'), actor_id: 'owner:forged' });
      assert.equal(injected.result.structuredContent.code, 'VALIDATION_ERROR');
      for (const path of ['/api/v1/candidates/resolve', '/api/v1/operations', `/companies/${companyId}`, `/mcp/${secret}`]) {
        const response = await fetchLocal(path + query, { method: path.startsWith('/api') ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(path.startsWith('/api') ? { body: '{}' } : {}) });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.ok(!(await response.text()).includes(companyId));
      }
      assert.deepEqual(await businessSnapshot(), before);
    });

    await t.test('CSRF requires both the current session token and exact origin; duplicate cookies fail closed', async () => {
      const before = await businessSnapshot();
      const cases: Record<string, string>[] = [
        { cookie, 'x-csrf-token': session.csrfToken },
        { cookie, origin: app.url },
        { cookie, origin: 'https://other.example.test', 'x-csrf-token': session.csrfToken },
        { cookie: `${cookie}; ${cookie}`, origin: app.url, 'x-csrf-token': session.csrfToken },
      ];
      for (const headers of cases) {
        const response = await fetchLocal('/api/v1/candidates', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input('CSRF should fail')) });
        assert.ok([403, 503].includes(response.status));
        assert.equal(response.headers.get('set-cookie'), null);
      }
      assert.deepEqual(await businessSnapshot(), before);
    });

    await t.test('trusted proxy stops at nearest untrusted IP across app instances and dynamic methods', async () => {
      const second = await startLocalOutreach({ pool, trustedProxyCidrs: ['127.0.0.0/8'] });
      try {
        const first = await fetchLocal('/login', {}, '203.0.113.60, 198.51.100.60');
        assert.equal(first.status, 200);
        const blocked = await Promise.all([
          fetchLocal('/healthz?unexpected=1', {}, '203.0.113.61, 198.51.100.60'),
          fetchLocal('/assets/app.js?unexpected=1', {}, '203.0.113.62, 198.51.100.60'),
          fetchLocal('/mcp', { method: 'OPTIONS' }, '203.0.113.63, 198.51.100.60'),
          fetch(second.url + '/api/v1/companies', { headers: { 'x-forwarded-for': '203.0.113.64, 198.51.100.60', forwarded: 'for=203.0.113.90' } }),
        ]);
        assert.deepEqual(blocked.map(r => r.status), [429, 429, 429, 429]);
        assert.ok(blocked.every(r => r.headers.get('retry-after') === '1'));
        const counts = await pool.query("SELECT sum(rejected_count)::int AS n FROM outreach_rate_rejections WHERE ip='198.51.100.60'");
        assert.equal(counts.rows[0].n, 4);
        assert.equal((await fetchLocal('/login', {}, '198.51.100.61')).status, 200);
      } finally { await second.close(); }
    });

    await t.test('injected driver failure after a business write rolls back all effects; same request safely retries', async () => {
      const command = { company_id: companyId, email: 'qa@example.test', source, verified_at: source.retrieved_at, request_id: randomUUID() };
      const before = await businessSnapshot();
      // Inject the driver failure after the real contact INSERT. Actual server SQL-error
      // recovery is a separate native PostgreSQL gate: the PGlite TCP adapter loses
      // protocol synchronization after a constraint error (observed in initial run).
      const failingPool = { connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, args?: unknown[]) => {
            if (sql.startsWith('INSERT INTO outreach_audit') && args?.[3] === 'contact') throw new Error('Injected driver failure');
            return client.query(sql, args);
          },
          release: () => client.release(),
        };
      } } as unknown as pg.Pool;
      await assert.rejects(new Registry(failingPool).saveContact(command, 'mcp:fixture'), code('DEPENDENCY_UNAVAILABLE'));
      assert.deepEqual(await businessSnapshot(), before);
      await assert.rejects(app.registry.getOperation({ request_id: command.request_id }), code('NOT_FOUND'));
      const saved = await app.registry.saveContact(command, 'mcp:fixture');
      assert.equal(saved.result, 'created');
      assert.deepEqual(await app.registry.saveContact(command, 'mcp:other-fixture'), saved);
      const count = await pool.query('SELECT count(*)::int AS n FROM outreach_contacts WHERE company_id=$1', [companyId]);
      assert.equal(count.rows[0].n, 1);
    });

    await t.test('contact update binds record to its company and enforces expected version without partial changes', async () => {
      const contact = (await app.registry.getCompany({ id: companyId })).contacts[0];
      const otherCandidate = await app.registry.upsertCompanyCandidate(input('Other synthetic company'), 'mcp:fixture');
      const other = await app.registry.resolveCandidate({ candidate_id: otherCandidate.candidate_id, expected_version: 1, request_id: randomUUID() }, 'owner:fixture');
      const command = { company_id: other.company_id, contact_id: contact.id, expected_version: contact.version, email: 'changed@example.test', source, verified_at: source.retrieved_at, request_id: randomUUID() };
      await assert.rejects(app.registry.saveContact(command, 'mcp:fixture'), code('NOT_FOUND'));
      await assert.rejects(app.registry.saveContact({ ...command, company_id: companyId, expected_version: contact.version + 1, request_id: randomUUID() }, 'mcp:fixture'), code('VERSION_CONFLICT'));
      assert.deepEqual((await app.registry.getCompany({ id: companyId })).contacts[0], contact);
    });

    await t.test('application audit contains neither raw nor encoded synthetic credentials', async () => {
      const events = JSON.stringify((await pool.query('SELECT * FROM outreach_access_events')).rows);
      assert.ok(events.includes('MCP_DENIED') && events.includes('CSRF_DENIED') && events.includes('WEB_DENIED'));
      for (const value of [secret, encodeURIComponent(secret), session.token, session.csrfToken, 'Held-out synthetic owner password']) assert.ok(!events.includes(value));
    });
  }
});

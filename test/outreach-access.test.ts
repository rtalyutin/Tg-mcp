import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { verify } from '@node-rs/argon2';
import {
  AccessError, AccessStore, accessMigrationSql, clientIp, generateConnectionUrl,
  generateLogin, hashSecret, parseMcpLogin,
} from '../src/outreach/access.ts';
import { readOutreachConfig } from '../src/outreach/config.ts';

const syntheticSecret = '#&+%=!?@[]{}<>~^';
const origin = 'https://outreach.example';
const rawUrl = (secret: string) => {
  const url = new URL(generateConnectionUrl(origin, secret));
  return `${url.pathname}${url.search}`;
};

test('MCP login survives percent encoding exactly once; malformed query never authenticates', () => {
  assert.equal(parseMcpLogin(rawUrl(syntheticSecret)), syntheticSecret);
  for (const raw of [
    '/mcp', '/mcp?', '/mcp?login=', '/mcp?login=%', '/mcp?login=%G0',
    `${rawUrl(syntheticSecret)}&login=${encodeURIComponent(syntheticSecret)}`,
    `${rawUrl(syntheticSecret)}&`, `${rawUrl(syntheticSecret)}&other=1`,
    rawUrl(syntheticSecret).replace('login=', '%6cogin='),
    `/mcp?login=${encodeURIComponent(encodeURIComponent(syntheticSecret))}`,
    '/mcp?login=++++++++++++++++', '/mcp?login=!!!!!!!!!!!!!!!1',
    '/mcp?login=!!!!!!!!!!!!!!!!%0A', '/mcp?login=!!!!!!!!!!!!!!!!%0D',
    '/mcp?login=%C0%AF', '/mcp?login=!!!!!!!!!!!!!!!!#fragment',
    `/mcp/?login=${encodeURIComponent(syntheticSecret)}`,
    `/other/../mcp?login=${encodeURIComponent(syntheticSecret)}`,
  ]) assert.equal(parseMcpLogin(raw), null);
  const punctuation = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)).filter(value => !/[A-Za-z0-9]/.test(value));
  assert.equal(punctuation.length, 32);
  for (const char of punctuation) assert.equal(parseMcpLogin(rawUrl(char.repeat(16))), char.repeat(16));
});

test('generator produces valid 16-symbol secrets and URL generation rejects unsafe origins', () => {
  const values = new Set(Array.from({ length: 64 }, generateLogin));
  assert.equal(values.size, 64);
  for (const value of values) assert.equal(parseMcpLogin(rawUrl(value)), value);
  for (const bad of ['http://outreach.example', 'https://outreach.example/mcp', 'https://secret@outreach.example', 'https://outreach.example?value=hidden']) {
    assert.throws(() => generateConnectionUrl(bad, syntheticSecret));
  }
});

test('Argon2id hashes have independent salts and verify only the original input', async () => {
  const first = await hashSecret(syntheticSecret);
  const second = await hashSecret(syntheticSecret);
  assert.notEqual(first, second);
  assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verify(first, syntheticSecret), true);
  assert.equal(await verify(first, syntheticSecret.slice(1) + '$'), false);
});

function request(peer: string, xff?: string, forwarded?: string): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff, forwarded } } as unknown as IncomingMessage;
}

test('client IP canonicalizes mapped addresses and trusts only the configured proxy chain', () => {
  assert.equal(clientIp(request('::ffff:192.0.2.5', '198.51.100.3', 'for=203.0.113.2'), []), '192.0.2.5');
  assert.equal(clientIp(request('2001:0db8:0000:0000:0000:0000:0000:0001'), []), '2001:db8::1');
  assert.equal(clientIp(request('10.0.0.2', '198.51.100.4, 10.0.0.3'), ['10.0.0.0/24']), '198.51.100.4');
  assert.equal(clientIp(request('10.0.0.2', '203.0.113.8, 198.51.100.4, 10.0.0.3'), ['10.0.0.0/24']), '198.51.100.4');
  assert.equal(clientIp(request('::ffff:10.0.0.2', '198.51.100.4'), ['::ffff:10.0.0.0/120']), '198.51.100.4');
  assert.equal(clientIp(request('192.0.2.5', 'garbage'), []), '192.0.2.5');
  for (const peer of ['', '127.1', '0x7f000001', 'fe80::1%eth0']) assert.throws(() => clientIp(request(peer), []), AccessError);
  assert.throws(() => clientIp(request('10.0.0.2', '198.51.100.4, invalid'), ['10.0.0.0/24']), AccessError);
});

test('outreach config is independent of Telegram and validates without leaking settings', () => {
  const env = { MCP_PUBLIC_ORIGIN: origin, DATABASE_URL: 'postgresql://owner:synthetic@db.example/outreach' };
  assert.deepEqual(readOutreachConfig(env), { publicOrigin: origin, databaseUrl: env.DATABASE_URL, port: 8080, trustedProxyCidrs: [], mail: null });
  assert.deepEqual(readOutreachConfig({ ...env, MCP_TRUSTED_PROXY_CIDRS: '10.0.0.0/24, 2001:db8::/32', MAIL_TRANSPORT_ENABLED: 'false' }).trustedProxyCidrs,
    ['10.0.0.0/24', '2001:db8::/32']);
  for (const change of [
    { DATABASE_URL: 'https://synthetic@db.example' }, { DATABASE_URL: '' }, { MCP_PUBLIC_ORIGIN: '' },
    { PORT: '8080junk' }, { PORT: '0' }, { MCP_TRUSTED_PROXY_CIDRS: '10.0.0.1' },
    { MCP_TRUSTED_PROXY_CIDRS: ',' }, { MAIL_TRANSPORT_ENABLED: 'true' },
  ]) assert.throws(() => readOutreachConfig({ ...env, ...change }), error => error instanceof Error && !error.message.includes('synthetic'));
});

test('dependency failure is controlled, malformed login never reaches the DB', async () => {
  let queries = 0;
  const store = new AccessStore({ query: async () => { queries++; throw new Error('synthetic_sensitive_database_detail'); } } as unknown as pg.Pool);
  assert.equal(await store.authenticateLogin(null), null);
  assert.equal(await store.authenticateLogin('invalid'), null);
  assert.equal(queries, 0);
  await assert.rejects(store.authenticateLogin(syntheticSecret), error => error instanceof AccessError && error.code === 'ACCESS_DEPENDENCY_UNAVAILABLE' && !error.message.includes('sensitive'));
});

test('parallel expensive authentication capacity is bounded without unbounded queueing', async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const store = new AccessStore({ query: async () => { await pending; return { rows: [] }; } } as unknown as pg.Pool);
  const admitted = Array.from({ length: 4 }, () => store.authenticateLogin(syntheticSecret));
  await assert.rejects(store.authenticateLogin(syntheticSecret), error => error instanceof AccessError && error.code === 'ACCESS_CAPACITY_EXCEEDED');
  release!();
  assert.deepEqual(await Promise.all(admitted), [null, null, null, null]);
  assert.equal(await store.authenticateLogin(syntheticSecret), null);
});

test('audit never persists query values or legacy secret paths', async () => {
  const writes: unknown[][] = [];
  const store = new AccessStore({ query: async (_sql: string, values: unknown[]) => { writes.push(values); return { rows: [] }; } } as unknown as pg.Pool);
  await store.recordAccess({ ip: '192.0.2.1', route: rawUrl(syntheticSecret), outcome: 'UNAVAILABLE', requestId: randomUUID() });
  await store.recordAccess({ ip: '192.0.2.1', route: `/mcp/${syntheticSecret}`, outcome: 'UNAVAILABLE', requestId: randomUUID() });
  assert.equal(writes[0][1], '/mcp');
  assert.equal(writes[1][1], '/unknown');
  assert.ok(!JSON.stringify(writes).includes(syntheticSecret));
  assert.ok(!JSON.stringify(writes).includes('%23%26'));
});

test('PostgreSQL access, sessions, revocation and cross-pool rate limit', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required for PostgreSQL integration' : false,
}, async t => {
  const admin = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL });
  const schema = `access_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString: process.env.OUTREACH_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 12 };
  const pool = new pg.Pool(config);
  const otherPool = new pg.Pool(config);
  const store = new AccessStore(pool);
  const other = new AccessStore(otherPool);
  try {
    await pool.query(accessMigrationSql);
    await pool.query(accessMigrationSql);
    await t.test('empty list, exact match, one-symbol mismatch and immediate revocation', async () => {
      assert.equal(await store.authenticateLogin(syntheticSecret), null);
      const credential = await store.addLogin(syntheticSecret, 'Synthetic test client');
      assert.deepEqual(await other.authenticateLogin(syntheticSecret), credential);
      assert.equal(await other.authenticateLogin(syntheticSecret.slice(1) + '$'), null);
      await assert.rejects(store.addLogin(syntheticSecret, 'Duplicate'), error => error instanceof AccessError && error.code === 'LOGIN_ALREADY_EXISTS');
      const row = (await pool.query('SELECT * FROM outreach_mcp_logins WHERE id=$1', [credential.id])).rows[0];
      assert.ok(!JSON.stringify(row).includes(syntheticSecret));
      await other.revokeLogin(credential.id);
      assert.equal(await store.authenticateLogin(syntheticSecret), null);
    });
    await t.test('owner session stores no raw token/password and expires or revokes', async () => {
      await store.seedOwner('owner', 'synthetic owner password');
      await assert.rejects(store.seedOwner('other', 'another synthetic password'), error => error instanceof AccessError && error.code === 'OWNER_ALREADY_EXISTS');
      assert.equal(await store.authenticateOwner('owner', 'wrong'), null);
      assert.equal(await store.authenticateOwner('absent', 'synthetic owner password'), null);
      const owner = await store.authenticateOwner('owner', 'synthetic owner password');
      assert.ok(owner);
      const session = await store.createSession(owner.id);
      assert.deepEqual(await other.getSession(session.token), { ownerId: owner.id, csrfToken: session.csrfToken });
      assert.equal(await store.getSession(randomUUID()), null);
      const ownerRows = await pool.query('SELECT * FROM outreach_owners');
      const sessionRows = await pool.query('SELECT * FROM outreach_owner_sessions');
      assert.ok(!JSON.stringify(ownerRows.rows).includes('synthetic owner password'));
      assert.ok(!JSON.stringify(sessionRows.rows).includes(session.token));
      await other.revokeSession(session.token);
      assert.equal(await store.getSession(session.token), null);
      const expired = await store.createSession(owner.id);
      await pool.query("UPDATE outreach_owner_sessions SET expires_at=clock_timestamp()-interval '1 second'");
      assert.equal(await store.getSession(expired.token), null);
    });
    await t.test('corrupt whitelist hash fails closed with diagnostic error', async () => {
      const credential = await store.addLogin(syntheticSecret, 'Corrupted fixture');
      await pool.query('UPDATE outreach_mcp_logins SET login_hash=$1 WHERE id=$2', ['broken', credential.id]);
      await assert.rejects(store.authenticateLogin(syntheticSecret), error => error instanceof AccessError && error.code === 'ACCESS_DEPENDENCY_UNAVAILABLE');
      await store.revokeLogin(credential.id);
    });
    await t.test('parallel pools allow only one request, count every rejection and canonicalize IP', async () => {
      const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).admitIp(i % 3 ? '192.0.2.40' : '::ffff:192.0.2.40')));
      assert.equal(attempts.filter(result => result.allowed).length, 1);
      assert.ok(attempts.filter(result => !result.allowed).every(result => result.retryAfter === 1));
      const count = await pool.query("SELECT sum(rejected_count)::int AS total FROM outreach_rate_rejections WHERE ip='192.0.2.40'");
      assert.equal(count.rows[0].total, 11);
      assert.equal((await store.admitIp('192.0.2.41')).allowed, true);
      await setTimeout(1050);
      assert.deepEqual(await other.admitIp('192.0.2.40'), { allowed: true, retryAfter: 0 });
      assert.equal((await store.admitIp('192.0.2.40')).allowed, false);
    });
    await t.test('whitelist active capacity remains eight across concurrent provisioning', async () => {
      for (let i = 0; i < 7; i++) await store.addLogin(generateLogin(), `Fixture ${i}`);
      const result = await Promise.allSettled([store.addLogin(generateLogin(), 'One'), other.addLogin(generateLogin(), 'Two')]);
      assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
      const count = await pool.query('SELECT count(*)::int AS count FROM outreach_mcp_logins WHERE revoked_at IS NULL');
      assert.equal(count.rows[0].count, 8);
    });
  } finally {
    await Promise.all([pool.end(), otherPool.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

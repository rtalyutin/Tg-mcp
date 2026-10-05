import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { startLocalOutreach } from '../src/outreach/server.ts';
import type { TelegramCollectorGateway } from '../src/telegram-collector/gateway.ts';
import { TelegramCollectorError } from '../src/telegram-collector/api.ts';

test('owner MCP reads expose only bounded failure codes; validation and authorization retain their contract', async t => {
  const owner = '14a4d6e9-63b0-44ea-9f45-a6237692aef1';
  const other = '68c15837-4b5a-47db-8ced-f10aae51e0dc';
  const secret = 'synthetic-password-never-expose';
  const privateUrl = `postgresql://fixture:${secret}@127.0.0.1/unused`;
  let failure: unknown = new Error(privateUrl, { cause: { code: '42P01', message: privateUrl } });
  const output: string[] = [];
  const originalLog = console.error;
  console.error = (...values: unknown[]) => output.push(values.join(' '));
  t.after(() => { console.error = originalLog; });
  const pool = { query: async () => { throw new Error('Unexpected database access in this MCP fixture'); } } as unknown as Pool;
  const gateway = { credentialId: owner, status: async () => { throw failure; },
    readEvents: async () => { throw failure; } } as unknown as TelegramCollectorGateway;
  const app = await startLocalOutreach({ pool, telegramCollector: gateway, dashboardWriter: {
    credentialId: owner, readState: async () => { throw failure; }, update: async () => ({}),
  } });
  t.after(() => app.close());
  app.access.admitIp = async () => ({ allowed: true, retryAfter: 0 });
  app.access.recordAccess = async () => {};
  app.access.authenticateLogin = async login => login === '!!!!!!!!!!!!!!!!' ? { id: owner }
    : login === '################' ? { id: other } : null;
  const call = async (name: string, args: object = {}, login = '!!!!!!!!!!!!!!!!') => {
    const response = await fetch(`${app.url}/mcp?login=${encodeURIComponent(login)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-password-never-expose|postgresql:|stack/);
    return body.result.structuredContent;
  };
  assert.deepEqual(await call('telegram_collector_status'), { code: 'SERVICE_UNAVAILABLE', diagnostic_code: '42P01' });
  failure = new Error('Connection terminated due to connection timeout');
  assert.deepEqual(await call('telegram_daily_events'), { code: 'SERVICE_UNAVAILABLE', diagnostic_code: 'DB_CONNECTION_TIMEOUT' });
  failure = new Error(privateUrl);
  assert.deepEqual(await call('telegram_collector_status'), { code: 'SERVICE_UNAVAILABLE', diagnostic_code: 'STARTUP_UNKNOWN' });
  failure = new AggregateError([{ code: '42703', message: privateUrl }]);
  assert.deepEqual(await call('get_dashboard_snapshot_state'), { code: 'SERVICE_UNAVAILABLE', diagnostic_code: '42703' });
  const logsBefore = output.length;
  failure = new TelegramCollectorError('TGC_OWNER_MISMATCH');
  assert.deepEqual(await call('telegram_collector_status'), { code: 'TGC_OWNER_MISMATCH' });
  assert.deepEqual(await call('telegram_collector_status', { unexpected: true }), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(await call('telegram_collector_status', {}, '################'), { code: 'FORBIDDEN' });
  assert.deepEqual(await call('telegram_collector_status', {}, '%%%%%%%%%%%%%%%%'), { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' });
  assert.equal(output.length, logsBefore);
  assert.deepEqual(output, [
    'MCP_READ_FAILED tool=telegram_collector_status code=42P01',
    'MCP_READ_FAILED tool=telegram_daily_events code=DB_CONNECTION_TIMEOUT',
    'MCP_READ_FAILED tool=telegram_collector_status code=STARTUP_UNKNOWN',
    'MCP_READ_FAILED tool=get_dashboard_snapshot_state code=42703',
  ]);
});

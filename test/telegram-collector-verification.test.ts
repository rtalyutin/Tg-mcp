import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { TelegramEventStore } from '../src/telegram-collector/store.ts';
import { TelegramCollectorGateway } from '../src/telegram-collector/gateway.ts';
import { TelegramCollectorApi, TelegramCollectorError, type CollectorApi } from '../src/telegram-collector/api.ts';
import { collectTelegramBatch, startTelegramCollector } from '../src/telegram-collector/runtime.ts';
import { readTelegramCollectorConfig } from '../src/telegram-collector/config.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { DatabaseTools } from '../src/outreach/database-tools.ts';

// Independent contract fixtures. SQL is actually executed by PGlite; advisory
// locks are synthetic here and do not establish native PostgreSQL lock safety.
const bot = '123', owner = '456';
const permitted = '14a4d6e9-63b0-44ea-9f45-a6237692aef1';
const other = '68c15837-4b5a-47db-8ced-f10aae51e0dc';
const config = { botToken: '123:synthetic_token_abcdefghijklmnop', ownerTelegramId: owner,
  credentialId: permitted, expectedUsername: 'RevitOpenClawBot' };
const window = { from: '2026-10-04T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' };
const received = new Date('2026-10-04T09:00:00.000Z');
const unix = (value: string) => Date.parse(value) / 1000;
const connection = (id = 'owner-connection', ownerId = Number(owner)) => ({ id, user: { id: ownerId }, is_enabled: true });
const message = (updateId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: updateId,
  business_message: { business_connection_id: 'owner-connection', chat: { id: 789, type: 'private' },
    message_id: messageId, from: { id: Number(owner) }, date: unix('2026-10-04T08:00:00.000Z'), text, ...extra },
});
type Row = Record<string, unknown>;

async function fixture(t: TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  let failAt: ((sql: string) => boolean) | null = null;
  let acquired = true;
  const clients: (EventEmitter & { released: boolean; destroyed: boolean })[] = [];
  const statements: string[] = [];
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> => {
    statements.push(sql);
    if (failAt?.(sql)) throw new Error('SYNTHETIC_TRANSACTION_FAILURE');
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }], rowCount: 1 };
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('pg_advisory_unlock')) return { rows: [{}], rowCount: 1 };
    if (!params && sql.includes('CREATE TABLE') && sql.includes(';')) {
      const results = await db.exec(sql);
      const result = results.at(-1)!;
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
    const result = await db.query<Row>(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => {
    const client = Object.assign(new EventEmitter(), { query, released: false, destroyed: false,
      release(destroy = false) { this.released = true; this.destroyed = destroy; } });
    clients.push(client); return client;
  } } as unknown as Pool;
  const store = new TelegramEventStore(pool, bot, owner);
  await store.migrate();
  return { pool, store, query, clients, statements,
    failWhen(value: ((sql: string) => boolean) | null) { failAt = value; },
    allowLock(value: boolean) { acquired = value; } };
}

function apiWith(getUpdates: CollectorApi['getUpdates'], resolve: CollectorApi['getBusinessConnection'] = async id => connection(id)): CollectorApi {
  return { getMe: async () => ({ id: Number(bot), is_bot: true, username: config.expectedUsername, can_connect_to_business: true }),
    getWebhookInfo: async () => ({ url: '' }), getBusinessConnection: resolve, getUpdates };
}

test('independent: owner isolation and unresolved connection fail closed atomically', async t => {
  const f = await fixture(t);
  const foreign = { update_id: 11, business_message: {
    business_connection_id: 'foreign', text: { private: 'FOREIGN_DO_NOT_CAPTURE' }, chat: null,
  } };
  await f.store.ingestBatch([message(10, 1, 'owner evidence'), foreign], [connection(), connection('foreign', 999)], received);
  assert.equal((await f.store.getCheckpoint()).nextOffset, 12);
  const before = await f.query('SELECT event_id, text FROM telegram_collector.events ORDER BY seq');
  assert.deepEqual(before.rows.map(row => row.text), ['owner evidence']);
  assert.ok(!JSON.stringify((await f.store.readStatus())).includes('FOREIGN_DO_NOT_CAPTURE'));
  const unknown = message(13, 3, 'unknown body', { business_connection_id: 'unresolved' });
  await assert.rejects(f.store.ingestBatch([message(12, 2, 'must rollback'), unknown], [], received), { code: 'TELEGRAM_CONNECTION_UNKNOWN' });
  assert.equal((await f.store.getCheckpoint()).nextOffset, 12);
  assert.deepEqual((await f.query('SELECT event_id, text FROM telegram_collector.events ORDER BY seq')).rows, before.rows);
  assert.equal((await f.query('SELECT count(*)::int AS total FROM telegram_collector.updates')).rows[0].total, 2);
});

test('independent: excluded groups skip content; missing scope refuses acknowledgement; owner binding is durable', async t => {
  const f = await fixture(t);
  const group = (updateId: number, type: string) => ({ update_id: updateId, business_message: {
    business_connection_id: 'owner-connection', chat: { type }, text: { excluded: 'GROUP_DO_NOT_CAPTURE' },
  } });
  await f.store.ingestBatch([group(14, 'group'), group(15, 'supergroup'), group(16, 'channel')], [connection()], received);
  assert.equal((await f.store.getCheckpoint()).nextOffset, 17);
  assert.equal((await f.query('SELECT count(*)::int AS total FROM telegram_collector.events')).rows[0].total, 0);
  const missingType = { update_id: 17, business_message: { business_connection_id: 'owner-connection', chat: { id: 789 }, text: 'unknown scope' } };
  await assert.rejects(f.store.ingestBatch([missingType], [], received), { code: 'TELEGRAM_EVENT_INVALID' });
  assert.equal((await f.store.getCheckpoint()).nextOffset, 17);
  const wrongOwner = new TelegramEventStore(f.pool, bot, '999');
  await assert.rejects(wrongOwner.migrate(), { code: 'TGC_OWNER_MISMATCH' });
  await assert.rejects(wrongOwner.getConnection('owner-connection'), { code: 'TGC_OWNER_MISMATCH' });
  assert.equal((await f.query('SELECT owner_id FROM telegram_collector.state')).rows[0].owner_id, owner);
});

test('independent: database failure rolls back event, projection and acknowledgement; replay is idempotent', async t => {
  const f = await fixture(t);
  const update = message(20, 1, 'prepared evidence');
  f.failWhen(sql => sql.includes('SET next_offset'));
  await assert.rejects(f.store.ingestBatch([update], [connection()], received), /SYNTHETIC_TRANSACTION_FAILURE/);
  f.failWhen(null);
  assert.equal((await f.store.getCheckpoint()).nextOffset, null);
  for (const table of ['events', 'messages', 'updates', 'connections']) {
    assert.equal((await f.query(`SELECT count(*)::int AS total FROM telegram_collector.${table}`)).rows[0].total, 0, table);
  }
  await f.store.ingestBatch([update], [connection()], received);
  await f.store.ingestBatch([update], [connection()], new Date('2026-10-04T10:00:00Z'));
  assert.equal((await f.query('SELECT count(*)::int AS total FROM telegram_collector.events')).rows[0].total, 1);
  assert.equal((await f.store.getCheckpoint()).nextOffset, 21);
  const rebuilt = new TelegramEventStore(f.pool, bot, owner);
  await rebuilt.migrate();
  assert.equal((await rebuilt.getCheckpoint()).nextOffset, 21);
  assert.equal((await rebuilt.readEvents({ ...window, limit: 50 })).events[0].text, 'prepared evidence');
});

test('independent: stable pages exclude new receipts; refreshed snapshot includes late and edited evidence honestly', async t => {
  const f = await fixture(t);
  await f.store.ingestBatch([message(30, 1, 'original'), message(31, 2, 'second')], [connection()], received);
  const gateway = new TelegramCollectorGateway(f.store, permitted, 'synthetic-cursor-secret');
  const first = await gateway.readEvents({ ...window, limit: 1 });
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  await f.store.ingestBatch([
    message(32, 3, 'late previous-day evidence', { date: unix('2026-10-03T08:00:00Z') }),
    { update_id: 33, edited_business_message: { ...message(1, 1, 'edited').business_message, edit_date: unix('2026-10-04T10:00:00Z') } },
  ], [], new Date('2026-10-04T11:00:00Z'));
  const second = await gateway.readEvents({ ...window, cursor: first.next_cursor, limit: 1 });
  assert.equal(second.snapshot_max_seq, first.snapshot_max_seq);
  assert.equal(second.has_more, false);
  const pageEvents = [...first.events, ...second.events] as Row[];
  assert.deepEqual(pageEvents.map(event => event.text), ['original', 'second']);
  assert.equal(new Set(pageEvents.map(event => event.seq)).size, 2);
  const refreshed = await gateway.readEvents({ ...window });
  const late = (refreshed.events as Row[]).find(event => event.text === 'late previous-day evidence')!;
  assert.deepEqual(late.matched_by, ['received_time']);
  assert.equal(late.message_at, '2026-10-03T08:00:00.000Z');
  const edited = (refreshed.events as Row[]).find(event => event.event_kind === 'edited')!;
  assert.equal(edited.message_at, '2026-10-04T08:00:00.000Z');
  assert.equal(edited.edit_at, '2026-10-04T10:00:00.000Z');
  assert.equal(edited.event_at, edited.edit_at);
  assert.equal(edited.source_message_id, pageEvents[0].source_message_id);
  await f.store.ingestBatch([{ update_id: 34, edited_business_message: message(1, 1, 'edit with unavailable timestamp').business_message }],
    [], new Date('2026-10-04T12:00:00Z'));
  const observedEdit = (await f.store.readEvents({ ...window, limit: 50 })).events.find(event => event.text === 'edit with unavailable timestamp')!;
  assert.equal(observedEdit.message_at, '2026-10-04T08:00:00.000Z');
  assert.equal(observedEdit.edit_at, null);
  assert.equal(observedEdit.event_at, observedEdit.received_at);
  assert.equal(observedEdit.event_time_basis, 'observed');
  await assert.rejects(gateway.readEvents({ ...window, cursor: first.next_cursor!.slice(0, -1) + 'x' }), { code: 'TGC_CURSOR_INVALID' });
  await assert.rejects(gateway.readEvents({ ...window, to: '2026-10-06T00:00:00Z', cursor: first.next_cursor }), { code: 'TGC_CURSOR_INVALID' });
});

test('independent: deletion carries only previously captured evidence; uncaptured body remains unknown', async t => {
  const f = await fixture(t);
  await f.store.ingestBatch([message(40, 1, 'claimed work, not proof')], [connection()], received);
  await f.store.ingestBatch([{ update_id: 41, deleted_business_messages: {
    business_connection_id: 'owner-connection', chat: { id: 789, type: 'private' }, message_ids: [1, 2, 2],
  } }], [], new Date('2026-10-04T12:00:00Z'));
  const deleted = (await f.store.readEvents({ ...window, limit: 50 })).events.filter(event => event.event_kind === 'deleted');
  assert.equal(deleted.length, 2);
  const known = deleted.find(event => event.message_id === '1')!;
  const unknown = deleted.find(event => event.message_id === '2')!;
  assert.equal(known.text, 'claimed work, not proof');
  assert.equal(known.deletion_content_known, true);
  assert.equal(unknown.text, null);
  assert.equal(unknown.message_at, null);
  assert.equal(unknown.deletion_content_known, false);
  assert.equal(unknown.direction, 'unknown');
  for (const event of deleted) {
    assert.equal(event.event_time_basis, 'observed');
    assert.equal(event.event_at, '2026-10-04T12:00:00.000Z');
    assert.equal(event.received_at, event.event_at);
  }
});

test('independent: network and connection lookup failures preserve checkpoint, stale lower IDs are collectable', async t => {
  const f = await fixture(t);
  await f.store.ingestBatch([message(900, 1, 'before idle')], [connection()], new Date('2026-09-25T00:00:00Z'));
  const failures = apiWith(async () => { throw new TelegramCollectorError('TGC_NETWORK_UNAVAILABLE'); });
  await assert.rejects(collectTelegramBatch(failures, f.store, received), { code: 'TGC_NETWORK_UNAVAILABLE' });
  assert.equal((await f.store.getCheckpoint()).nextOffset, 901);
  let requestedOffset: number | null | undefined;
  const missing = message(901, 2, 'lookup body', { business_connection_id: 'missing' });
  await assert.rejects(collectTelegramBatch(apiWith(async offset => { requestedOffset = offset; return [missing]; },
    async () => { throw new TelegramCollectorError('TGC_API_UNAVAILABLE'); }), f.store, received), { code: 'TGC_API_UNAVAILABLE' });
  assert.equal(requestedOffset, null);
  assert.equal((await f.store.getCheckpoint()).nextOffset, 901);
  await collectTelegramBatch(apiWith(async offset => { requestedOffset = offset; return [message(2, 3, 'after randomized restart')]; }), f.store, received);
  assert.equal(requestedOffset, null);
  assert.equal((await f.store.getCheckpoint()).nextOffset, 3);
  assert.equal((await f.query('SELECT count(*)::int AS total FROM telegram_collector.events')).rows[0].total, 2);
});

test('independent: reused random update ID distinguishes fresh evidence from an exact replay', async t => {
  const f = await fixture(t);
  await f.store.ingestBatch([message(100, 1, 'historical payload')], [connection()], new Date('2026-09-25T00:00:00Z'));
  const fresh = message(100, 2, 'fresh after ID collision');
  await f.store.ingestBatch([fresh], [], received);
  await f.store.ingestBatch([fresh], [], new Date('2026-10-04T10:00:00Z'));
  const rows = await f.query('SELECT text FROM telegram_collector.events ORDER BY seq');
  assert.deepEqual(rows.rows.map(row => row.text), ['historical payload', 'fresh after ID collision']);
});

test('independent: recovered polling preserves the missed span and partial coverage', async t => {
  const f = await fixture(t);
  await f.store.markPoll(null, new Date('2026-10-01T00:00:00Z'));
  await f.store.markPoll('TGC_NETWORK_UNAVAILABLE', new Date('2026-10-01T00:01:00Z'));
  await f.store.markPoll(null, new Date('2026-10-02T00:00:01Z'));
  await f.store.markPoll(null, new Date('2026-10-02T00:00:31Z'));
  const state = await f.store.readStatus('2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z');
  const gaps = state.polling_gaps as Row[];
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].started_at, '2026-10-01T00:00:00.000Z');
  assert.equal(gaps[0].ended_at, '2026-10-02T00:00:01.000Z');
  assert.equal(gaps[0].retention_risk, true);
  const health = await new TelegramCollectorGateway(f.store, permitted, 'synthetic').status();
  assert.equal(health.coverage.complete, false);
  assert.ok(health.coverage.blind_spots.includes('no_history_before_connection'));
});

test('independent: private MCP tools are hidden and forbidden; generic database route cannot bypass collector', async t => {
  const f = await fixture(t);
  await f.store.ingestBatch([message(110, 1, 'owner-only synthetic body')], [connection()], received);
  const gateway = new TelegramCollectorGateway(f.store, permitted, 'synthetic');
  const app = await startLocalOutreach({ pool: f.pool, telegramCollector: gateway, databaseTools: new DatabaseTools(f.pool, other) });
  t.after(() => app.close());
  app.access.admitIp = async () => ({ allowed: true, retryAfter: 0 });
  app.access.recordAccess = async () => {};
  app.access.authenticateLogin = async secret => secret === '!!!!!!!!!!!!!!!!' ? { id: permitted } : secret === '################' ? { id: other } : null;
  const call = async (login: string, method: string, params: object) => {
    const response = await fetch(`${app.url}/mcp?login=${encodeURIComponent(login)}`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const envelope = await response.json() as { result: { tools?: { name: string }[]; structuredContent?: Row; isError?: boolean } };
    return envelope.result;
  };
  const ownList = await call('!!!!!!!!!!!!!!!!', 'tools/list', {});
  const otherList = await call('################', 'tools/list', {});
  const names = ['telegram_collector_status', 'telegram_daily_events'];
  assert.deepEqual(ownList.tools!.filter(tool => names.includes(tool.name)).map(tool => tool.name), names);
  assert.ok(!otherList.tools!.some(tool => names.includes(tool.name)));
  for (const name of names) {
    const denied = await call('################', 'tools/call', { name, arguments: name === 'telegram_daily_events' ? window : {} });
    assert.equal(denied.structuredContent?.code, 'FORBIDDEN');
    assert.ok(!JSON.stringify(denied).includes('owner-only synthetic body'));
  }
  const own = await call('!!!!!!!!!!!!!!!!', 'tools/call', { name: 'telegram_daily_events', arguments: window });
  assert.equal((own.structuredContent?.events as Row[])[0].text, 'owner-only synthetic body');
  const blockedRead = await call('################', 'tools/call', { name: 'read_database', arguments: { schema: 'telegram_collector', table: 'events' } });
  assert.equal(blockedRead.structuredContent?.code, 'DATABASE_PERMISSION_DENIED');
  const blockedWrite = await call('################', 'tools/call', { name: 'write_database', arguments: {
    schema: 'telegram_collector', table: 'events', operation: 'insert', rows: [{ values: { text: 'bypass' } }],
  } });
  assert.equal(blockedWrite.structuredContent?.code, 'DATABASE_PERMISSION_DENIED');
  const listing = await call('################', 'tools/call', { name: 'read_database', arguments: {} });
  assert.ok(!(listing.structuredContent?.tables as Row[]).some(row => row.schema === 'telegram_collector'));
  assert.equal((await f.query('SELECT count(*)::int AS total FROM telegram_collector.events')).rows[0].total, 1);
});

test('collector resumes from its committed checkpoint after losing the lock session', {timeout:15000}, async t => {
  const f = await fixture(t);
  let calls = 0;
  const offsets: (number|null)[] = [];
  let firstWaiting!: () => void, resumed!: () => void;
  const waiting = new Promise<void>(resolve=>{firstWaiting=resolve;});
  const recovered = new Promise<void>(resolve=>{resumed=resolve;});
  const api = apiWith(async (offset, signal) => {
    offsets.push(offset); calls++;
    if (calls === 1) return [{update_id:1,business_connection:connection()},message(2,1,'first fixture')];
    if (calls === 3) return [message(3,2,'recovered fixture')];
    if (calls === 2) firstWaiting();
    if (calls === 4) resumed();
    return new Promise<unknown[]>((_resolve,reject)=>{
      if (signal?.aborted) {reject(new TelegramCollectorError('TGC_ABORTED'));return;}
      signal?.addEventListener('abort',()=>reject(new TelegramCollectorError('TGC_ABORTED')),{once:true});
    });
  });
  const gateway = await startTelegramCollector(f.pool, config, {api});
  t.after(()=>gateway.close());
  await waiting;
  const original = f.clients.find(client=>!client.released)!;
  original.emit('error', Object.assign(new Error('synthetic-password-never-log'), {code:'ECONNRESET'}));
  assert.equal((await gateway.status()).running, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([recovered,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Collector did not resume')),8000);})]); }
  finally {clearTimeout(timer);}
  assert.equal((await gateway.status()).running, true);
  assert.deepEqual(offsets.slice(0,4), [null,3,3,4]);
  assert.equal(original.destroyed, true);
  assert.equal((await f.store.readStatus()).events_count, '2');
  await gateway.close(); await gateway.close();
  assert.ok(f.clients.every(client=>client.released));
});

test('collector recovery does not poll while another session owns the lock', {timeout:15000}, async t => {
  const f = await fixture(t);
  let calls=0, waiting!:()=>void, retried!:()=>void;
  const started=new Promise<void>(resolve=>{waiting=resolve;});
  const attempted=new Promise<void>(resolve=>{retried=resolve;});
  const api=apiWith(async (_offset,signal)=>{
    calls++; waiting();
    return new Promise<unknown[]>((_resolve,reject)=>{
      if(signal?.aborted){reject(new TelegramCollectorError('TGC_ABORTED'));return;}
      signal?.addEventListener('abort',()=>reject(new TelegramCollectorError('TGC_ABORTED')),{once:true});
    });
  });
  const gateway=await startTelegramCollector(f.pool,config,{api});
  t.after(()=>gateway.close());
  await started;
  f.allowLock(false);
  f.failWhen(sql=>{if(sql.includes('pg_try_advisory_lock'))retried();return false;});
  f.clients.find(client=>!client.released)!.emit('error',new Error('SYNTHETIC_LOCK_SESSION_LOSS'));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([attempted,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('No recovery attempt')),8000);})]);}
  finally{clearTimeout(timer);}
  const state=await gateway.status();
  assert.equal(state.running,false); assert.equal(calls,1);
  await gateway.close();
  const callsAtClose=calls;
  assert.equal(callsAtClose,1);
  assert.ok(f.clients.every(client=>client.released));
  assert.equal(f.clients.filter(client=>!client.released).length,0);
});

test('independent: disabled config preserves the existing service; runtime guards and close avoid write effects', async t => {
  assert.equal(readTelegramCollectorConfig({}), null);
  assert.equal(readTelegramCollectorConfig({ TELEGRAM_COLLECTOR_ENABLED: 'false', TELEGRAM_COLLECTOR_BOT_TOKEN: 'invalid' }), null);
  const f = await fixture(t);
  const app = await startLocalOutreach({ pool: f.pool });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.url}/healthz`)).status, 200);
  await assert.rejects(startTelegramCollector(f.pool, config, { api: {
    ...apiWith(async () => []), getWebhookInfo: async () => ({ url: 'https://synthetic.invalid/webhook' }),
  } }), { code: 'TGC_WEBHOOK_ACTIVE' });
  f.allowLock(false);
  await assert.rejects(startTelegramCollector(f.pool, config, { api: apiWith(async () => []) }), { code: 'TGC_ALREADY_RUNNING' });
  f.allowLock(true);
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => { started = resolve; });
  const api = apiWith(async (_offset, signal) => {
    started();
    return await new Promise<unknown[]>((_resolve, reject) => {
      if (signal?.aborted) { reject(new TelegramCollectorError('TGC_ABORTED')); return; }
      signal?.addEventListener('abort', () => reject(new TelegramCollectorError('TGC_ABORTED')), { once: true });
    });
  });
  const gateway = await startTelegramCollector(f.pool, config, { api });
  await hasStarted;
  assert.equal((await gateway.status()).running, true);
  const lockSession = f.clients.find(client => !client.released)!;
  lockSession.emit('error', new Error('SYNTHETIC_LOCK_SESSION_LOSS'));
  await gateway.close();
  await gateway.close();
  assert.equal((await gateway.status()).running, false);
  assert.equal(lockSession.destroyed, true);
  const normal = await startTelegramCollector(f.pool, config, { api: apiWith(async () => []) });
  await normal.close();
  assert.ok(f.clients.every(client => client.released));
  assert.ok(f.statements.some(sql => sql.includes('pg_advisory_unlock')));
  const methods: string[] = [];
  const readonlyApi = new TelegramCollectorApi('123:synthetic', (async (url: string | URL | Request) => {
    methods.push(String(url).split('/').at(-1)!);
    return new Response(JSON.stringify({ ok: true, result: methods.at(-1) === 'getUpdates' ? [] : {} }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  await readonlyApi.getMe(); await readonlyApi.getWebhookInfo(); await readonlyApi.getBusinessConnection('synthetic'); await readonlyApi.getUpdates(null);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo', 'getBusinessConnection', 'getUpdates']);
});

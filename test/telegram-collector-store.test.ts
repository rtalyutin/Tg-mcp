import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { TelegramEventStore } from '../src/telegram-collector/store.ts';

const botId = '7000000001', ownerId = '123456789';
const connection = { id: 'personal-connection', user: { id: Number(ownerId) }, is_enabled: true };
const t0 = new Date('2026-10-04T01:00:00.000Z');
const timestamp = Math.floor(t0.getTime() / 1000);
const window = { from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z', limit: 200 };

function createDatabase() {
  const db = new PGlite();
  let failInsert = false;
  const query = async (sql: string, params?: unknown[]) => {
    if (failInsert && sql.startsWith('INSERT INTO telegram_collector.events')) throw new Error('INJECTED_DB_FAILURE');
    const result = !params && /;\s*\S/.test(sql) ? (await db.exec(sql)).at(-1)! : await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { db, pool, query, store: new TelegramEventStore(pool, botId, ownerId), failInserts: (value: boolean) => { failInsert = value; } };
}

function message(updateId: number, options: { edit?: boolean; id?: number; text?: string; sender?: number; connection?: string; date?: number } = {}) {
  const payload = { business_connection_id: options.connection ?? connection.id, chat: { id: 987654321, type: 'private' },
    message_id: options.id ?? 10, from: { id: options.sender ?? 987654321 },
    date: options.date ?? timestamp, text: options.text ?? 'Клиент подтвердил встречу',
    ...(options.edit ? { edit_date: timestamp + 60 } : {}) };
  return { update_id: updateId, [options.edit ? 'edited_business_message' : 'business_message']: payload };
}

test('additive migration is idempotent, keeps other schemas, and refuses an owner change/future schema', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.query('CREATE TABLE public.existing (id integer PRIMARY KEY, title text)');
  await fixture.query("INSERT INTO public.existing VALUES(1, 'kept')");
  await fixture.store.migrate();
  await fixture.store.migrate();
  assert.deepEqual((await fixture.query('SELECT * FROM public.existing')).rows, [{ id: 1, title: 'kept' }]);
  assert.deepEqual(await fixture.store.getCheckpoint(), { nextOffset: null, lastUpdateAt: null });
  const wrongOwner = new TelegramEventStore(fixture.pool, botId, '333333');
  await assert.rejects(wrongOwner.migrate(), { code: 'TGC_OWNER_MISMATCH' });
  await assert.rejects(wrongOwner.readStatus(), { code: 'TGC_OWNER_MISMATCH' });
  await assert.rejects(wrongOwner.readEvents(window), { code: 'TGC_OWNER_MISMATCH' });
  await assert.rejects(wrongOwner.getConnection(connection.id), { code: 'TGC_OWNER_MISMATCH' });
  await fixture.query('UPDATE telegram_collector.schema_version SET version = 2');
  await assert.rejects(fixture.store.migrate(), { code: 'UNSUPPORTED_TELEGRAM_COLLECTOR_SCHEMA' });
});

test('replays preserve immutable create/edit/delete evidence, direction, and unknown deletion tombstones', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  const created = message(100);
  await fixture.store.ingestBatch([created], [connection], t0);
  await fixture.store.ingestBatch([created], [connection], new Date(t0.getTime() + 30_000));
  await fixture.store.ingestBatch([message(101, { edit: true, text: 'Встреча перенесена на завтра' }),
    message(102, { id: 11, sender: Number(ownerId), text: 'Договор отправлен' })], [], new Date(t0.getTime() + 90_000));
  const deleted = { update_id: 103, deleted_business_messages: { business_connection_id: connection.id,
    chat: { id: 987654321, type: 'private' }, message_ids: [10, 99, 10] } };
  const deletedAt = new Date(t0.getTime() + 120_000);
  await fixture.store.ingestBatch([deleted], [], deletedAt);
  await fixture.store.ingestBatch([deleted], [], new Date(t0.getTime() + 180_000));
  const result = await fixture.store.readEvents(window);
  assert.equal(result.events.length, 5);
  const [create, edit, outgoing, deletion, unknown] = result.events;
  assert.equal(create.text, 'Клиент подтвердил встречу');
  assert.equal(create.direction, 'incoming');
  assert.equal(create.received_at, t0.toISOString());
  assert.equal(edit.text, 'Встреча перенесена на завтра');
  assert.equal(edit.event_at, new Date(t0.getTime() + 60_000).toISOString());
  assert.equal(edit.message_at, create.message_at);
  assert.equal(edit.source_message_id, create.source_message_id);
  assert.notEqual(edit.event_id, create.event_id);
  assert.equal(outgoing.direction, 'outgoing');
  assert.equal(deletion.text, edit.text);
  assert.equal(deletion.deletion_content_known, true);
  assert.equal(deletion.event_time_basis, 'observed');
  assert.equal(deletion.event_at, deletedAt.toISOString());
  assert.equal(unknown.text, null);
  assert.equal(unknown.direction, 'unknown');
  assert.equal(unknown.message_at, null);
  assert.equal(unknown.deletion_content_known, false);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 104);
});

test('configured owner filter discards foreign bodies and unknown connections block the whole batch', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  const foreign = { id: 'foreign', user: { id: 888888 }, is_enabled: true };
  // Even malformed foreign content is neither interpreted nor retained.
  await fixture.store.ingestBatch([{ update_id: 2, business_connection: foreign },
    { update_id: 3, business_message: { business_connection_id: foreign.id, text: 'FOREIGN_SECRET', from: 'malformed' } },
    { update_id: 4, message: { text: 'ORDINARY_SECRET' } }], [], t0);
  assert.equal((await fixture.store.readEvents(window)).events.length, 0);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 5);
  const status = await fixture.store.readStatus();
  assert.deepEqual(status.connections, []);
  const connectionRows = (await fixture.query('SELECT * FROM telegram_collector.connections')).rows;
  assert.ok(!JSON.stringify(connectionRows).includes('FOREIGN_SECRET'));
  assert.equal(await fixture.store.getConnection(foreign.id).then(value => value?.ownerId), '888888');
  await assert.rejects(fixture.store.ingestBatch([message(5), message(6, { connection: 'unresolved', text: 'must rollback' })], [connection], t0),
    { code: 'TELEGRAM_CONNECTION_UNKNOWN' });
  assert.equal((await fixture.store.readEvents(window)).events.length, 0);
  assert.equal(await fixture.store.getConnection(connection.id), null);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 5);
  assert.equal(((await fixture.query('SELECT count(*)::int AS count FROM telegram_collector.updates WHERE update_id IN (5, 6)')).rows[0] as { count: number }).count, 0);
});

test('database failure and malformed relevant update leave the checkpoint and all event writes unchanged', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  await fixture.store.ingestBatch([message(10)], [connection], t0);
  fixture.failInserts(true);
  await assert.rejects(fixture.store.ingestBatch([message(11, { id: 11 })], [], t0), /INJECTED_DB_FAILURE/);
  fixture.failInserts(false);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 11);
  assert.equal((await fixture.store.readEvents(window)).events.length, 1);
  await assert.rejects(fixture.store.ingestBatch([message(11, { id: 11 }), { update_id: 12, business_message: {
    business_connection_id: connection.id, message_id: Number.MAX_SAFE_INTEGER + 1,
  } }], [], t0), { code: 'TELEGRAM_EVENT_INVALID' });
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 11);
  assert.equal((await fixture.store.readEvents(window)).events.length, 1);
  await fixture.store.ingestBatch([message(11, { id: 11 })], [], t0);
  assert.equal((await fixture.store.readEvents(window)).events.length, 2);
  // A new Telegram epoch may start below the old highest ID; checkpoint is based on this batch.
  await fixture.store.ingestBatch([message(2, { id: 12 })], [], t0);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 3);
});

test('bounded keyset snapshot excludes later edits and includes late arrivals using receive time', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  await fixture.store.ingestBatch([message(1), message(2, { id: 11, text: 'old message received today', date: timestamp - 172800 })], [connection], t0);
  const first = await fixture.store.readEvents({ ...window, limit: 1 });
  assert.equal(first.events.length, 1); assert.equal(first.has_more, true);
  await fixture.store.ingestBatch([message(3, { edit: true, text: 'new edit after snapshot' })], [], t0);
  const next = await fixture.store.readEvents({ ...window, afterSeq: first.next_after_seq!, maxSeq: first.snapshot_max_seq, limit: 1 });
  assert.equal(next.events.length, 1); assert.equal(next.has_more, false);
  assert.equal(next.events[0].text, 'old message received today');
  assert.equal(next.snapshot_max_seq, first.snapshot_max_seq);
  assert.equal(first.events[0].text, 'Клиент подтвердил встречу');
  const newSnapshot = await fixture.store.readEvents(window);
  assert.equal(newSnapshot.events.length, 3);
  assert.equal(newSnapshot.events[2].text, 'new edit after snapshot');
  await assert.rejects(fixture.store.readEvents({ ...window, maxSeq: '0;DROP TABLE events' }), { code: 'TELEGRAM_READ_INPUT_INVALID' });
});

test('canonical replay hash survives key reordering while same update ID with new content remains observable', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  const first = message(500, { text: 'before idle week' });
  await fixture.store.ingestBatch([first], [connection], t0);
  const payload = first.business_message as Record<string, unknown>;
  const reordered = { business_message: Object.fromEntries(Object.entries(payload).reverse()), update_id: 500 };
  await fixture.store.ingestBatch([reordered], [], new Date(t0.getTime() + 60_000));
  assert.equal((await fixture.store.readEvents(window)).events.length, 1);
  const weekLater = new Date(t0.getTime() + 8 * 86_400_000);
  await fixture.store.ingestBatch([message(500, { id: 20, text: 'new Telegram epoch', date: Math.floor(weekLater.getTime() / 1000) })], [], weekLater);
  const all = (await fixture.query('SELECT event_id, update_fingerprint FROM telegram_collector.events ORDER BY seq')).rows as Array<{ event_id: string; update_fingerprint: string }>;
  assert.equal(all.length, 2);
  assert.notEqual(all[0].event_id, all[1].event_id);
  assert.notEqual(all[0].update_fingerprint, all[1].update_fingerprint);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 501);
});

test('media metadata and absent sender remain bounded without retaining contacts, filenames, or raw payload', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  await fixture.store.ingestBatch([{ update_id: 1, business_message: { business_connection_id: connection.id,
    chat: { id: -123456789, type: 'private', title: 'PRIVATE_TITLE' }, message_id: 1, date: timestamp, caption: 'file caption',
    document: { file_id: 'PRIVATE_DOWNLOAD_ID', file_unique_id: 'stable-file', file_name: 'PRIVATE_FILENAME' } } }], [connection], t0);
  const result = await fixture.store.readEvents(window);
  assert.equal(result.events[0].direction, 'unknown');
  assert.equal(result.events[0].media_kind, 'document');
  assert.equal(result.events[0].media_file_unique_id, 'stable-file');
  assert.equal(result.events[0].text, 'file caption');
  assert.equal(result.events[0].chat_id, '-123456789');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('last successful poll survives errors and recovered downtime remains visible in the relevant window', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  await fixture.store.markPoll(null, t0);
  await fixture.store.markResponse(new Date(t0.getTime() + 10_000));
  await fixture.store.markPoll('TELEGRAM_UNAVAILABLE', new Date(t0.getTime() + 50_000));
  let status = await fixture.store.readStatus();
  assert.equal(status.last_poll_at, t0.toISOString());
  assert.equal(status.last_response_at, new Date(t0.getTime() + 10_000).toISOString());
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, null);
  assert.equal(status.last_error_code, 'TELEGRAM_UNAVAILABLE');
  assert.deepEqual(status.polling_gaps, []);
  await assert.rejects(fixture.store.markPoll('request contained SECRET'), { code: 'TELEGRAM_ERROR_CODE_INVALID' });
  const recoveredAt = new Date(t0.getTime() + 86_400_000);
  await fixture.store.markPoll(null, recoveredAt);
  await fixture.store.markPoll(null, new Date(recoveredAt.getTime() + 25_000));
  status = await fixture.store.readStatus(window.from, window.to);
  assert.equal(status.last_error_code, null);
  assert.deepEqual(status.polling_gaps, [{ started_at: t0.toISOString(), ended_at: recoveredAt.toISOString(), retention_risk: true }]);
  assert.equal(status.gaps_has_more, false);
  assert.deepEqual((await fixture.store.readStatus('2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z')).polling_gaps, []);
  await fixture.store.markPoll(null, new Date(recoveredAt.getTime() + 125_000));
  const all = await fixture.store.readStatus();
  assert.equal((all.polling_gaps as Array<{ retention_risk: boolean }>)[0].retention_risk, false);
});

test('business bot sends count as outgoing while a chat sender remains unknown', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  const base = { business_connection_id: connection.id, chat: { id: 987654321, type: 'private' }, date: timestamp,
    from: { id: 999999 }, text: 'reply' };
  await fixture.store.ingestBatch([
    { update_id: 1, business_message: { ...base, message_id: 1, sender_business_bot: { id: 777777, is_bot: true, first_name: 'Other bot' } } },
    { update_id: 2, business_message: { ...base, message_id: 2, sender_chat: { id: -777777 } } },
  ], [connection], t0);
  const result = await fixture.store.readEvents(window);
  assert.equal(result.events[0].direction, 'outgoing');
  assert.equal(result.events[0].sender_business_bot_id, '777777');
  assert.equal(result.events[1].direction, 'unknown');
  assert.equal(result.events[1].sender_business_bot_id, null);
  await assert.rejects(fixture.store.ingestBatch([{ update_id: 3, business_message: {
    ...base, message_id: 3, sender_business_bot: { id: 777777, is_bot: false },
  } }], [], t0), { code: 'TELEGRAM_EVENT_INVALID' });
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 3);
});

test('private scope skips group bodies, fails closed on unknown chat type, and labels unavailable rich media', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  await fixture.store.ingestBatch([{ update_id: 1, business_message: { business_connection_id: connection.id,
    chat: { id: -12345, type: 'supergroup' }, text: 'GROUP_PRIVATE_BODY', from: 'malformed' } }], [connection], t0);
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 2);
  assert.equal((await fixture.store.readEvents(window)).events.length, 0);
  await assert.rejects(fixture.store.ingestBatch([{ update_id: 2, business_message: { business_connection_id: connection.id,
    chat: { id: 12345, type: 'future_chat' }, text: 'unknown' } }], [], t0), { code: 'TELEGRAM_EVENT_INVALID' });
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 2);
  await fixture.store.ingestBatch([
    { update_id: 2, business_message: { business_connection_id: connection.id, chat: { id: 12345, type: 'private' },
      message_id: 2, date: timestamp, rich_message: { text: 'UNAVAILABLE_RICH_BODY' } } },
    { update_id: 3, business_message: { business_connection_id: connection.id, chat: { id: 12345, type: 'private' },
      message_id: 3, date: timestamp, live_photo: { photo: 'UNAVAILABLE_PHOTO_BODY' } } },
  ], [], t0);
  const events = (await fixture.store.readEvents(window)).events;
  assert.deepEqual(events.map(event => event.media_kind), ['rich_message', 'live_photo']);
  assert.deepEqual(events.map(event => event.text), [null, null]);
  assert.ok(!JSON.stringify(events).includes('UNAVAILABLE_'));
  await assert.rejects(fixture.store.ingestBatch([message(4, { text: 'a'.repeat(32769) })], [], t0), { code: 'TELEGRAM_EVENT_INVALID' });
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 4);
});

test('optional edit_date keeps the original message date and labels edit time as observed', async t => {
  const fixture = createDatabase(); t.after(() => fixture.db.close());
  await fixture.store.migrate();
  const receivedAt = new Date(t0.getTime() + 60_000);
  await fixture.store.ingestBatch([{ update_id: 1, edited_business_message: {
    business_connection_id: connection.id, chat: { id: 987654321, type: 'private' },
    message_id: 10, from: { id: 987654321 }, date: timestamp, text: 'Edit without Telegram edit timestamp',
  } }], [connection], receivedAt);
  const event = (await fixture.store.readEvents(window)).events[0];
  assert.equal(event.event_kind, 'edited');
  assert.equal(event.message_at, t0.toISOString());
  assert.equal(event.edit_at, null);
  assert.equal(event.event_at, receivedAt.toISOString());
  assert.equal(event.event_time_basis, 'observed');
  assert.equal((await fixture.store.getCheckpoint()).nextOffset, 2);
});

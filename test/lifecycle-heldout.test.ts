import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Publisher } from '../src/publisher.ts';
import { ReadinessGate } from '../src/lifecycle.ts';
import type { TelegramReadiness } from '../src/telegram.ts';
import { startLocalCheckedPublisher } from '../src/integrated-server.ts';

// Independent acceptance oracle: only synthetic data and loopback network requests.
const channelId = '-10088112';
const bot = { id: 88112, is_bot: true };
const chat = { id: Number(channelId), type: 'channel', title: 'QA 🐻 e\u0301', username: 'qa_fixture' };
const member = { status: 'administrator', can_post_messages: true, user: bot };
const ready: TelegramReadiness = { ready: true, channel_title: chat.title, channel_username: chat.username };
const unavailable = { ready: false, code: 'TELEGRAM_NOT_READY' };
const accessToken = 'heldout_lifecycle_local_access_token_88112';
const botToken = '88112:heldout_lifecycle_synthetic';
const text = 'А'.repeat(4096) + 'Б'.repeat(4096) + '🐻 конец';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function input(instanceId: string, story = randomUUID()) { return { story_id: story, attempt_id: randomUUID(), expected_instance_id: instanceId, text }; }

test('held-out lifecycle: preflight owns attempt and channel before awaiting, including failed-check replay', { timeout: 5000 }, async () => {
  const rights = deferred<boolean>(); let checks = 0; let sends = 0;
  const publisher = new Publisher({ channelId, sender: { async send() { sends++; return { kind: 'confirmed', message_id: 55 }; } },
    readiness: () => ({ publishEnabled: true, telegramReady: false }), preflight: () => { checks++; return rights.promise; } });
  const original = input(publisher.instanceId); const first = publisher.publish(original);
  assert.equal(checks, 1);
  const registered = publisher.getAttemptStatus({ attempt_id: original.attempt_id, expected_instance_id: publisher.instanceId });
  assert.equal(registered.status, 'IN_PROGRESS'); assert.equal(registered.remaining_parts, 3);
  assert.deepEqual(await publisher.publish(original), registered);
  assert.deepEqual(await publisher.publish({ ...original, attempt_id: randomUUID() }), registered);
  assert.equal((await publisher.publish({ ...original, text: 'changed' })).code, 'ATTEMPT_CONFLICT');
  assert.equal((await publisher.publish({ ...original, attempt_id: randomUUID(), text: 'changed' })).code, 'STORY_CONFLICT');
  assert.equal((await publisher.publish(input(publisher.instanceId))).code, 'BUSY');
  assert.equal(checks, 1); assert.equal(sends, 0);
  rights.resolve(false); const rejected = await first;
  assert.equal(rejected.code, 'TELEGRAM_NOT_READY'); assert.equal(rejected.status, 'REJECTED');
  assert.deepEqual(await publisher.publish(original), rejected); assert.equal(checks, 1); assert.equal(sends, 0);
  await publisher.stop(); assert.deepEqual(await publisher.publish(original), rejected);
});

test('held-out lifecycle: stop during rights check drains it and freezes registration without any send', { timeout: 5000 }, async () => {
  const rights = deferred<boolean>(); let sends = 0; let settled = false;
  const publisher = new Publisher({ channelId, sender: { async send() { sends++; return { kind: 'confirmed', message_id: 1 }; } },
    readiness: () => ({ publishEnabled: true, telegramReady: true }), preflight: () => rights.promise });
  const original = input(publisher.instanceId); const operation = publisher.publish(original);
  const stopping = publisher.stop().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal((await publisher.publish(input(publisher.instanceId))).code, 'SHUTTING_DOWN');
  assert.equal((await publisher.publish(original)).status, 'IN_PROGRESS');
  rights.resolve(true); const result = await operation; await stopping;
  assert.equal(result.code, 'SHUTTING_DOWN'); assert.equal(result.status, 'REJECTED'); assert.equal(sends, 0);
  assert.deepEqual(await publisher.publish(original), result);
  assert.deepEqual(publisher.getAttemptStatus({ attempt_id: original.attempt_id, expected_instance_id: publisher.instanceId }), result);
});

test('held-out lifecycle: mutable enable flag is rechecked after rights success', async () => {
  const rights = deferred<boolean>(); let enabled = true; let sends = 0;
  const publisher = new Publisher({ channelId, sender: { async send() { sends++; return { kind: 'unknown' }; } },
    readiness: () => ({ publishEnabled: enabled, telegramReady: false }), preflight: () => rights.promise });
  const operation = publisher.publish(input(publisher.instanceId)); enabled = false; rights.resolve(true);
  const result = await operation; assert.equal(result.status, 'REJECTED'); assert.equal(result.code, 'PUBLISH_DISABLED'); assert.equal(sends, 0);
});

test('held-out lifecycle: stopped multi-part send preserves confirmed prefix and unknown second part', { timeout: 5000 }, async () => {
  const inflight = deferred<unknown>(); const entered = deferred<void>(); const sent: string[] = [];
  const publisher = new Publisher({ channelId, readiness: () => ({ publishEnabled: true, telegramReady: true }),
    sender: { async send(channel, part) { assert.equal(channel, channelId); sent.push(part); if (sent.length === 1) return { kind: 'confirmed', message_id: 812 }; entered.resolve(); return inflight.promise; } } });
  const original = input(publisher.instanceId); const operation = publisher.publish(original); await entered.promise;
  const stopping = publisher.stop(); inflight.resolve({ kind: 'unknown' }); const result = await operation; await stopping;
  assert.deepEqual(sent, ['А'.repeat(4096), 'Б'.repeat(4096)]);
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.code, 'DELIVERY_UNKNOWN'); assert.equal(result.uncertain_part_index, 2);
  assert.equal(result.remaining_parts, 1); assert.equal(result.manual_check_required, true); assert.equal(result.automatic_retry_allowed, false);
  assert.deepEqual(result.confirmed_messages, [{ part_index: 1, message_id: 812, message_url: null }]);
  assert.deepEqual(await publisher.publish({ ...original, attempt_id: randomUUID() }), result);
  const copy = publisher.getAttemptStatus({ attempt_id: original.attempt_id, expected_instance_id: publisher.instanceId }); copy.confirmed_messages[0].message_id = 99;
  assert.deepEqual(await publisher.publish(original), result); assert.equal(sent.length, 2);
});

test('held-out lifecycle: readiness coalesces only pending work, copies results, and fences invalidated or stopped reads', async () => {
  const work = [deferred<TelegramReadiness>(), deferred<TelegramReadiness>(), deferred<TelegramReadiness>()]; let checks = 0;
  const gate = new ReadinessGate(() => work[checks++].promise);
  const first = gate.refresh(); const also = gate.refresh(); await Promise.resolve(); assert.equal(checks, 1);
  work[0].resolve(ready); const [a, b] = await Promise.all([first, also]); assert.deepEqual(a, ready); assert.deepEqual(b, ready);
  if (a.ready) a.channel_title = 'mutated'; assert.deepEqual(b, ready); assert.deepEqual(gate.snapshot, ready);
  const next = gate.refresh(); await Promise.resolve(); assert.equal(checks, 2); gate.invalidate(); work[1].resolve(ready);
  assert.deepEqual(await next, unavailable); assert.deepEqual(gate.snapshot, unavailable);
  const final = gate.refresh(); await Promise.resolve(); assert.equal(checks, 3); gate.stop(); work[2].resolve(ready);
  assert.deepEqual(await final, unavailable); assert.deepEqual(await gate.refresh(), unavailable); assert.equal(checks, 3);
});

type Call = { method: string; body: Record<string, unknown>; response: ServerResponse };
function ok(res: ServerResponse, result: unknown) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); }
async function fixture(reply: (call: Call, calls: Call[]) => void, publishEnabled = true, timeoutMs = 2000) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk.toString();
    assert.equal(req.method, 'POST');
    assert.ok(req.url?.startsWith(`/bot${botToken}/`));
    const call = { method: req.url!.split('/').at(-1)!, body: JSON.parse(bytes), response: res }; calls.push(call); reply(call, calls);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  const app = await startLocalCheckedPublisher({ accessToken, botToken, channelId, publishEnabled, telegramApiRoot: `http://127.0.0.1:${address.port}/`, telegramTimeoutMs: timeoutMs });
  const client = new Client({ name: 'independent-lifecycle', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.url), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }); assert.notEqual(response.isError, true);
    assert.ok(response.structuredContent); return response.structuredContent as Record<string, any>;
  };
  return { app, calls, tool, async close() { await client.close(); await app.close(); const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}
function goodRead(call: Call) {
  if (call.method === 'getMe') { assert.deepEqual(call.body, {}); ok(call.response, bot); }
  else if (call.method === 'getChat') { assert.deepEqual(call.body, { chat_id: channelId }); ok(call.response, chat); }
  else if (call.method === 'getChatMember') { assert.deepEqual(call.body, { chat_id: channelId, user_id: bot.id }); ok(call.response, member); }
  else assert.fail(`unexpected write ${call.method}`);
}

test('held-out lifecycle: SDK status checks revoked/restored rights afresh and never writes', { timeout: 8000 }, async () => {
  let allowed = true;
  const f = await fixture(call => call.method === 'getChatMember' ? ok(call.response, { ...member, can_post_messages: allowed }) : goodRead(call));
  try {
    assert.equal(f.calls.length, 0, 'constructor must not contact Telegram');
    const status = await f.tool('get_publisher_status'); assert.equal(status.telegram_ready, true); assert.equal(status.channel_title, chat.title);
    allowed = false; const denied = await f.tool('get_publisher_status'); assert.equal(denied.telegram_ready, false); assert.equal(denied.reason_code, 'TELEGRAM_NOT_READY'); assert.equal(denied.channel_title, null);
    allowed = true; assert.equal((await f.tool('get_publisher_status')).telegram_ready, true);
    assert.deepEqual(f.calls.map(c => c.method), Array(3).fill(['getMe', 'getChat', 'getChatMember']).flat());
    assert.ok(!JSON.stringify([status, denied]).includes(botToken));
  } finally { await f.close(); }
});

test('held-out lifecycle: preflight denial is registered once across SDK replay and fails before send', { timeout: 8000 }, async () => {
  const f = await fixture(call => call.method === 'getChatMember' ? ok(call.response, { ...member, can_post_messages: false }) : goodRead(call));
  try {
    const original = input(f.app.instanceId); const denied = await f.tool('publish_story', original);
    assert.equal(denied.status, 'REJECTED'); assert.equal(denied.code, 'TELEGRAM_NOT_READY');
    assert.deepEqual(await f.tool('publish_story', original), denied);
    assert.deepEqual(await f.tool('get_publish_attempt', { attempt_id: original.attempt_id, expected_instance_id: f.app.instanceId }), denied);
    assert.deepEqual(f.calls.map(c => c.method), ['getMe', 'getChat', 'getChatMember']);
  } finally { await f.close(); }
});

test('held-out lifecycle: send failure invalidates an earlier concurrent status result without erasing attempt', { timeout: 8000 }, async () => {
  const sendEntered = deferred<ServerResponse>(); const readEntered = deferred<ServerResponse>(); let holdRead = false;
  const f = await fixture(call => {
    if (call.method === 'sendMessage') sendEntered.resolve(call.response);
    else if (call.method === 'getChatMember' && holdRead) readEntered.resolve(call.response);
    else goodRead(call);
  });
  try {
    const original = input(f.app.instanceId); const publishing = f.tool('publish_story', original); const send = await sendEntered.promise;
    holdRead = true; const status = f.tool('get_publisher_status'); const reading = await readEntered.promise;
    send.writeHead(403, { 'content-type': 'application/json' }); send.end(JSON.stringify({ ok: false, error_code: 403 }));
    const failed = await publishing; assert.equal(failed.status, 'REJECTED'); assert.equal(failed.code, 'BOT_FORBIDDEN');
    ok(reading, member); const stale = await status; assert.equal(stale.telegram_ready, false); assert.equal(stale.channel_title, null);
    assert.deepEqual(await f.tool('publish_story', original), failed);
    holdRead = false; assert.equal((await f.tool('get_publisher_status')).telegram_ready, true, 'next explicit read may revalidate');
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  } finally { await f.close(); }
});

test('held-out lifecycle: stop drains one SDK send, retains PARTIAL IDs, and permits read/replay before close', { timeout: 8000 }, async () => {
  const sendEntered = deferred<ServerResponse>();
  const f = await fixture(call => call.method === 'sendMessage' ? sendEntered.resolve(call.response) : goodRead(call));
  try {
    const original = input(f.app.instanceId); const publishing = f.tool('publish_story', original); const send = await sendEntered.promise;
    let drained = false; const stopping = f.app.stop().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
    const status = await f.tool('get_publisher_status'); assert.equal(status.reason_code, 'SHUTTING_DOWN'); assert.equal(status.telegram_ready, false);
    assert.equal((await f.tool('publish_story', input(f.app.instanceId))).code, 'SHUTTING_DOWN');
    assert.equal((await f.tool('publish_story', original)).status, 'IN_PROGRESS');
    ok(send, { message_id: 733 }); const partial = await publishing; await stopping;
    assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.code, 'SHUTTING_DOWN'); assert.equal(partial.remaining_parts, 2);
    assert.equal(partial.manual_check_required, true); assert.equal(partial.automatic_retry_allowed, false);
    assert.deepEqual(partial.confirmed_messages, [{ part_index: 1, message_id: 733, message_url: null }]);
    assert.deepEqual(await f.tool('get_publish_attempt', { attempt_id: original.attempt_id, expected_instance_id: f.app.instanceId }), partial);
    assert.deepEqual(await f.tool('publish_story', original), partial);
    assert.deepEqual(f.calls.map(c => c.method), ['getMe', 'getChat', 'getChatMember', 'sendMessage']);
    assert.deepEqual(f.calls.at(-1)!.body, { chat_id: channelId, text: 'А'.repeat(4096) });
  } finally { await f.close(); }
});

test('held-out lifecycle: disabled/stale/invalid invocations and forbidden roots cannot contact Telegram', { timeout: 8000 }, async () => {
  const f = await fixture(goodRead, false);
  try {
    assert.equal((await f.tool('publish_story', input(f.app.instanceId))).code, 'PUBLISH_DISABLED');
    assert.equal((await f.tool('publish_story', input(randomUUID()))).code, 'INSTANCE_CHANGED');
    assert.equal(f.calls.length, 0);
    const options = { accessToken, botToken, channelId, publishEnabled: true };
    for (const root of ['https://api.telegram.org/', 'http://localhost:3000/', 'http://192.0.2.1:3000/', 'https://127.0.0.1:3000/']) {
      await assert.rejects(startLocalCheckedPublisher({ ...options, telegramApiRoot: root }));
    }
    await assert.rejects(startLocalCheckedPublisher({ ...options, telegramApiRoot: 'http://127.0.0.1:1/', telegramReady: true } as any));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

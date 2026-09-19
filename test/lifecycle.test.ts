import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalCheckedPublisher } from '../src/integrated-server.ts';
import { ReadinessGate } from '../src/lifecycle.ts';

const accessToken = randomBytes(32).toString('base64url');
const botToken = ['12345', 'synthetic_lifecycle_fixture'].join(':');
const bot = { id: 12345, is_bot: true };
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function fixture(hook?: (method: string, response: http.ServerResponse) => Promise<boolean>, enabled = true) {
  let permission = true;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const method = req.url!.split('/').pop()!; calls.push({ method, body: JSON.parse(body) });
    if (hook && await hook(method, res)) return;
    const result = method === 'getMe' ? bot : method === 'getChat' ? { id: -100123, type: 'channel', title: 'Сказки', username: 'synthetic' }
      : method === 'getChatMember' ? { user: bot, status: 'administrator', can_post_messages: permission } : { message_id: calls.filter(x => x.method === 'sendMessage').length };
    res.end(JSON.stringify({ ok: true, result }));
  });
  telegram.listen(0, '127.0.0.1'); await once(telegram, 'listening');
  const address = telegram.address(); assert.ok(address && typeof address === 'object');
  const app = await startLocalCheckedPublisher({ accessToken, botToken, channelId: '-100123', telegramApiRoot: `http://127.0.0.1:${address.port}/`, publishEnabled: enabled });
  const clients: Client[] = [];
  async function client() {
    const c = new Client({ name: 'lifecycle-author', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(app.url), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    clients.push(c); return c;
  }
  return { app, calls, client, permission: (value: boolean) => { permission = value; },
    input: (text = 'Сказка', story_id = randomUUID()) => ({ text, story_id, attempt_id: randomUUID(), expected_instance_id: app.instanceId }),
    close: async () => { for (const c of clients) await c.close(); await app.close(); telegram.closeAllConnections(); telegram.close(); await once(telegram, 'close'); },
  };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined);
  return result.structuredContent as Record<string, unknown>;
}

test('checked MCP refreshes rights per read/new attempt, retains rejected attempt and permits later independent story', { timeout: 5000 }, async () => {
  const f = await fixture(); const c = await f.client();
  try {
    assert.equal((await call(c, 'get_publisher_status')).telegram_ready, true);
    f.permission(false);
    const input = f.input(); const denied = await call(c, 'publish_story', input);
    assert.equal(denied.status, 'REJECTED'); assert.equal(denied.code, 'TELEGRAM_NOT_READY');
    assert.equal(f.calls.length, 6); assert.ok(!f.calls.some(x => x.method === 'sendMessage'));
    f.permission(true);
    assert.deepEqual(await call(c, 'publish_story', input), denied); assert.equal(f.calls.length, 6);
    assert.equal((await call(c, 'publish_story', f.input())).status, 'PUBLISHED');
    assert.deepEqual(f.calls.slice(6).map(x => x.method), ['getMe', 'getChat', 'getChatMember', 'sendMessage']);
    f.permission(false);
    const unavailable = await call(c, 'get_publisher_status');
    assert.equal(unavailable.telegram_ready, false); assert.equal(unavailable.channel_title, null);
  } finally { await f.close(); }
});

test('checked preflight owns attempt lock: coalesced status, canonical replay, BUSY and zero premature sends', { timeout: 5000 }, async () => {
  const entered = latch(); const release = latch();
  const f = await fixture(async method => { if (method === 'getMe') { entered.release(); await release.promise; } return false; });
  const c = await f.client(); const other = await f.client(); const input = f.input();
  try {
    const pending = call(c, 'publish_story', input); await entered.promise;
    const status = call(other, 'get_publisher_status');
    assert.equal((await call(other, 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: input.expected_instance_id })).status, 'IN_PROGRESS');
    const replay = await call(other, 'publish_story', { ...input, attempt_id: randomUUID() });
    assert.equal(replay.status, 'IN_PROGRESS'); assert.equal(replay.attempt_id, input.attempt_id);
    assert.equal((await call(other, 'publish_story', f.input())).code, 'BUSY');
    assert.deepEqual(f.calls.map(x => x.method), ['getMe']);
    release.release(); assert.equal((await pending).status, 'PUBLISHED'); assert.equal((await status).telegram_ready, true);
    assert.deepEqual(f.calls.map(x => x.method), ['getMe', 'getChat', 'getChatMember', 'sendMessage']);
  } finally { release.release(); await f.close(); }
});

test('checked stop waits for current send, retains confirmation and blocks remaining parts/new stories', { timeout: 5000 }, async () => {
  const entered = latch(); const release = latch();
  const f = await fixture(async method => { if (method === 'sendMessage') { entered.release(); await release.promise; } return false; });
  const c = await f.client(); const other = await f.client(); const input = f.input('А'.repeat(4096) + 'Б');
  try {
    const pending = call(c, 'publish_story', input); await entered.promise;
    let stopped = false; const stop = f.app.stop().then(() => { stopped = true; });
    assert.equal((await call(other, 'publish_story', f.input())).code, 'SHUTTING_DOWN');
    const status = await call(other, 'get_publisher_status');
    assert.equal(status.reason_code, 'SHUTTING_DOWN'); assert.equal(status.telegram_ready, false); assert.equal(stopped, false);
    release.release(); const result = await pending; await stop;
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.code, 'SHUTTING_DOWN'); assert.equal(result.remaining_parts, 1);
    assert.deepEqual(result.confirmed_messages, [{ part_index: 1, message_id: 1, message_url: null }]);
    assert.equal(result.uncertain_part_index, null); assert.equal(result.manual_check_required, true);
    assert.equal(f.calls.filter(x => x.method === 'sendMessage').length, 1);
    assert.deepEqual(await call(other, 'publish_story', input), result);
  } finally { release.release(); await f.close(); }
});

test('checked stop during preflight records rejection and cannot be undone by a late successful check', { timeout: 5000 }, async () => {
  const entered = latch(); const release = latch();
  const f = await fixture(async method => { if (method === 'getMe') { entered.release(); await release.promise; } return false; });
  const c = await f.client(); const input = f.input();
  try {
    const pending = call(c, 'publish_story', input); await entered.promise; const stop = f.app.stop();
    release.release(); const result = await pending; await stop;
    assert.equal(result.status, 'REJECTED'); assert.equal(result.code, 'SHUTTING_DOWN');
    assert.ok(!f.calls.some(x => x.method === 'sendMessage'));
    assert.equal((await call(c, 'get_publisher_status')).telegram_ready, false);
    const count = f.calls.length; assert.deepEqual(await call(c, 'publish_story', input), result); assert.equal(f.calls.length, count);
  } finally { release.release(); await f.close(); }
});

test('disabled checked publisher never preflights publication; health and attempt lookup never query Telegram', { timeout: 5000 }, async () => {
  const f = await fixture(undefined, false); const c = await f.client();
  try {
    const input = f.input(); assert.equal((await call(c, 'publish_story', input)).code, 'PUBLISH_DISABLED');
    assert.equal((await call(c, 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: f.app.instanceId })).status, 'UNKNOWN');
    assert.equal((await fetch(new URL('/healthz', f.app.url))).status, 200); assert.equal(f.calls.length, 0);
    const status = await call(c, 'get_publisher_status'); assert.equal(status.publish_enabled, false); assert.equal(status.telegram_ready, true);
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('readiness invalidation discards late success, shares one flight and protects snapshot ownership', async () => {
  const release = latch(); let count = 0;
  const gate = new ReadinessGate(async () => { count++; await release.promise; return { ready: true, channel_title: 'Channel', channel_username: null }; });
  const first = gate.refresh(); const second = gate.refresh(); await Promise.resolve(); assert.equal(count, 1);
  gate.invalidate(); release.release(); assert.equal((await first).ready, false); assert.equal((await second).ready, false);
  assert.equal(gate.snapshot.ready, false);
  const good = await gate.refresh(); assert.equal(good.ready, true); if (good.ready) good.channel_title = 'mutated';
  assert.deepEqual(gate.snapshot, { ready: true, channel_title: 'Channel', channel_username: null });
  gate.stop(); assert.equal((await gate.refresh()).ready, false); assert.equal(count, 2);
});

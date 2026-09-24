import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readProductionConfig } from '../src/production-config.ts';
import { ConfigError } from '../src/config-error.ts';
import { startLocalPublicPublisher } from '../src/secret-server.ts';

const botToken = '31579:synthetic_routing_fixture';
const routes = 'bear=-100101,fox=-100202';
const config = { MCP_AUTH_MODE: 'public', MCP_PROFILE: 'publisher', PUBLISH_ENABLED: 'false', TELEGRAM_BOT_TOKEN: botToken };

test('config requires a valid, unambiguous server-owned task mapping', () => {
  const parsed = readProductionConfig({ ...config, TELEGRAM_TASK_CHANNELS: routes });
  assert.deepEqual({ ...parsed.taskChannels }, { bear: '-100101', fox: '-100202' });
  assert.equal(readProductionConfig({ ...config, TELEGRAM_TASK_CHANNELS: 'bear=@talyutinstories' }).taskChannels?.bear, '@talyutinstories');
  for (const bad of ['', 'bear=-100101,bear=-100202', 'bear=@bad', 'bear=-100101,', 'bear=-100101=other', '__proto__=-100101', 'bear=-100101,fox=-0']) {
    assert.throws(() => readProductionConfig({ ...config, TELEGRAM_TASK_CHANNELS: bad }), error => error instanceof ConfigError);
  }
  assert.throws(() => readProductionConfig({ ...config, TELEGRAM_TASK_CHANNELS: routes, TELEGRAM_CHANNEL_ID: '-100101' }));
  assert.throws(() => readProductionConfig({ TELEGRAM_TASK_CHANNELS: routes }));
});

test('public channel username resolves to a verified numeric destination before sending', async () => {
  const calls: Array<{ method: string; body: any }> = [];
  const bot = { id: 31579, is_bot: true };
  let actualId = -100101;
  const telegram = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const method = req.url!.split('/').at(-1)!;
    const body = JSON.parse(raw); calls.push({ method, body });
    const result = method === 'getMe' ? bot : method === 'getChat'
      ? { id: actualId, username: 'talyutinstories', type: 'channel', title: 'Stories' }
      : method === 'getChatMember' ? { user: bot, status: 'administrator', can_post_messages: true }
      : { message_id: 17 };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  telegram.listen(0, '127.0.0.1'); await once(telegram, 'listening');
  const address = telegram.address(); assert.ok(address && typeof address !== 'string');
  const app = await startLocalPublicPublisher({ profile: 'publisher', publishEnabled: true, botToken,
    taskChannels: { bear: '@talyutinstories' }, publicOrigin: 'http://127.0.0.1:34876',
    telegramApiRoot: `http://127.0.0.1:${address.port}/` });
  const client = new Client({ name: 'alias-verification', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url)));
    const before = (await client.callTool({ name: 'get_publisher_status', arguments: {} })).structuredContent as any;
    assert.equal(before.task_status[0].resolved_channel_id, '-100101');
    assert.equal(before.task_status[0].check_code, null);
    actualId = -100303;
    const movedBeforeSend = (await client.callTool({ name: 'get_publisher_status', arguments: {} })).structuredContent as any;
    assert.equal(movedBeforeSend.task_status[0].telegram_ready, false);
    assert.equal(movedBeforeSend.task_status[0].check_code, 'CHANNEL_ID_CHANGED');
    const denied = (await client.callTool({ name: 'publish_story', arguments: {
      task_id: 'bear', story_id: 'moved-alias', attempt_id: randomUUID(), expected_instance_id: app.instanceId, text: 'Не отправлять',
    } })).structuredContent as any;
    assert.equal(denied.status, 'REJECTED');
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 0);
    actualId = -100101;
    const published = (await client.callTool({ name: 'publish_story', arguments: {
      task_id: 'bear', story_id: 'alias-story', attempt_id: randomUUID(), expected_instance_id: app.instanceId, text: 'Проверка маршрута',
    } })).structuredContent as any;
    assert.equal(published.status, 'PUBLISHED'); assert.equal(published.channel_id, '-100101');
    assert.deepEqual(calls.filter(call => call.method === 'sendMessage').map(call => call.body.chat_id), ['-100101']);
    assert.ok(calls.some(call => call.method === 'getChat' && call.body.chat_id === '@talyutinstories'));
    assert.ok(calls.some(call => call.method === 'getChatMember' && call.body.chat_id === '-100101'));
    actualId = -100303;
    const changed = (await client.callTool({ name: 'get_publisher_status', arguments: {} })).structuredContent as any;
    assert.equal(changed.task_status[0].telegram_ready, false);
    assert.equal(changed.task_status[0].resolved_channel_id, null);
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 1);
  } finally {
    await client.close(); await app.close(); const closed = once(telegram, 'close'); telegram.close(); telegram.closeAllConnections(); await closed;
  }
});

test('MCP routes two tasks to distinct chats, rejects an unmapped task and isolates bad channel rights', async () => {
  const calls: Array<{ method: string; body: any }> = [];
  const bot = { id: 31579, is_bot: true };
  const telegram = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const method = req.url!.split('/').at(-1)!;
    const body = JSON.parse(raw);
    calls.push({ method, body });
    const result = method === 'getMe' ? bot : method === 'getChat'
      ? { id: Number(body.chat_id), type: 'channel', title: String(body.chat_id) }
      : method === 'getChatMember' ? { user: bot, status: 'administrator', can_post_messages: body.chat_id !== '-100202' }
      : { message_id: calls.length };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  telegram.listen(0, '127.0.0.1'); await once(telegram, 'listening');
  const address = telegram.address(); assert.ok(address && typeof address !== 'string');
  const app = await startLocalPublicPublisher({ profile: 'publisher', publishEnabled: true, botToken,
    taskChannels: { bear: '-100101', fox: '-100202' }, publicOrigin: 'http://127.0.0.1:34876',
    telegramApiRoot: `http://127.0.0.1:${address.port}/` });
  const client = new Client({ name: 'routing-verification', version: '1' });
  const request = (task_id: string) => ({ task_id, story_id: 'same-episode', attempt_id: randomUUID(),
    expected_instance_id: app.instanceId, text: `Post for ${task_id}` });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url)));
    const status = (await client.callTool({ name: 'get_publisher_status', arguments: {} })).structuredContent as any;
    assert.equal(status.telegram_ready, false);
    assert.deepEqual(status.task_status.map((item: any) => [item.task_id, item.telegram_ready]), [['bear', true], ['fox', false]]);
    assert.deepEqual(status.task_status.map((item: any) => item.check_code), [null, 'POST_PERMISSION_MISSING']);
    const unknown = (await client.callTool({ name: 'publish_story', arguments: request('other') })).structuredContent as any;
    assert.equal(unknown.code, 'TASK_NOT_CONFIGURED');
    const fox = (await client.callTool({ name: 'publish_story', arguments: request('fox') })).structuredContent as any;
    assert.equal(fox.code, 'TELEGRAM_NOT_READY');
    const bearInput = request('bear');
    const bear = (await client.callTool({ name: 'publish_story', arguments: bearInput })).structuredContent as any;
    assert.equal(bear.status, 'PUBLISHED'); assert.equal(bear.channel_id, '-100101');
    const replay = (await client.callTool({ name: 'publish_story', arguments: { ...bearInput, attempt_id: randomUUID() } })).structuredContent;
    assert.deepEqual(replay, bear);
    assert.deepEqual(calls.filter(call => call.method === 'sendMessage').map(call => call.body.chat_id), ['-100101']);
    await assert.rejects(client.callTool({ name: 'publish_story', arguments: { ...request('bear'), chat_id: '-100202' } }));
  } finally {
    await client.close(); await app.close(); const closed = once(telegram, 'close'); telegram.close(); telegram.closeAllConnections(); await closed;
  }
});

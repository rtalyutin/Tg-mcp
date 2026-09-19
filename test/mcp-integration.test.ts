import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalIntegratedPublisher } from '../src/integrated-server.ts';

type Reply = { status?: number; body?: unknown };
const accessToken = randomBytes(32).toString('base64url');
const botToken = ['123456789', 'synthetic_mcp_integration_token_123456789'].join(':');

async function telegramMock(replies: Reply[]) {
  const requests: Array<{ url: string; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
    const reply = replies.shift() ?? { status: 500, body: { ok: false } };
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? { ok: true, result: { message_id: requests.length } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { server, requests, root: `http://127.0.0.1:${address.port}/` };
}

async function closeHttp(server: http.Server) {
  server.closeAllConnections(); server.close(); await once(server, 'close');
}

async function clientFor(url: string) {
  const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

test('MCP exposes strict honest annotations and one shared publisher across calls', async () => {
  const tg = await telegramMock([{ body: { ok: true, result: { message_id: 41 } } }]);
  const app = await startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-1001234', telegramApiRoot: tg.root, publishEnabled: true, telegramReady: true });
  const client = await clientFor(app.url);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(x => x.name), ['get_publisher_status', 'publish_story', 'get_publish_attempt']);
    const publishTool = listed.tools.find(x => x.name === 'publish_story'); assert.ok(publishTool);
    assert.equal(publishTool.annotations?.readOnlyHint, false);
    assert.equal(publishTool.annotations?.idempotentHint, false);
    assert.equal(publishTool.annotations?.openWorldHint, true);
    assert.equal(publishTool.inputSchema.additionalProperties, false);

    const status = await client.callTool({ name: 'get_publisher_status', arguments: {} });
    assert.deepEqual(status.structuredContent, {
      service_version: '0.5.0', instance_id: app.instanceId,
      publish_enabled: true, telegram_ready: true,
      channel_title: null, channel_username: null,
      format_policy: 'sequential_text_posts', reason_code: null,
    });
    const input = { story_id: 'story-one', attempt_id: randomUUID(), expected_instance_id: app.instanceId, text: 'Сказка <&> 🐻' };
    const published = await client.callTool({ name: 'publish_story', arguments: input });
    assert.equal((published.structuredContent as Record<string, unknown>).status, 'PUBLISHED');
    assert.equal(tg.requests.length, 1);
    assert.deepEqual(JSON.parse(tg.requests[0].body), { chat_id: '-1001234', text: input.text });

    const read = await client.callTool({ name: 'get_publish_attempt', arguments: { attempt_id: input.attempt_id, expected_instance_id: app.instanceId } });
    assert.deepEqual(read.structuredContent, published.structuredContent);
    const replay = await client.callTool({ name: 'publish_story', arguments: input });
    assert.deepEqual(replay.structuredContent, published.structuredContent);
    const sameStory = await client.callTool({ name: 'publish_story', arguments: { ...input, attempt_id: randomUUID() } });
    assert.equal((sameStory.structuredContent as Record<string, unknown>).attempt_id, input.attempt_id);
    assert.equal(tg.requests.length, 1);
    assert.equal(JSON.stringify([listed, status, published, read]).includes(botToken), false);
    assert.equal(JSON.stringify([listed, status, published, read]).includes(accessToken), false);
  } finally { await client.close(); await app.close(); await closeHttp(tg.server); }
});

test('MCP preserves UNKNOWN across a new client and sends no remaining or replay parts', async () => {
  const tg = await telegramMock([{ body: { ok: true, result: { message_id: 7 } } }, { status: 500, body: { ok: false } }]);
  const app = await startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-1001234', telegramApiRoot: tg.root, publishEnabled: true, telegramReady: true });
  let first = await clientFor(app.url);
  const input = { story_id: 'long-story', attempt_id: randomUUID(), expected_instance_id: app.instanceId, text: 'А'.repeat(4096) + 'Б'.repeat(10) };
  try {
    const result = await first.callTool({ name: 'publish_story', arguments: input });
    const state = result.structuredContent as Record<string, unknown>;
    assert.equal(state.status, 'UNKNOWN'); assert.equal(state.uncertain_part_index, 2);
    assert.equal(state.manual_check_required, true); assert.equal(state.automatic_retry_allowed, false);
    assert.equal(tg.requests.length, 2);
    await first.close();
    first = await clientFor(app.url);
    const read = await first.callTool({ name: 'get_publish_attempt', arguments: { attempt_id: input.attempt_id, expected_instance_id: app.instanceId } });
    assert.equal((read.structuredContent as Record<string, unknown>).status, 'UNKNOWN');
    await first.callTool({ name: 'publish_story', arguments: input });
    await first.callTool({ name: 'publish_story', arguments: { ...input, attempt_id: randomUUID() } });
    assert.equal(tg.requests.length, 2);
  } finally { await first.close(); await app.close(); await closeHttp(tg.server); }
});

test('MCP validation and stale instance fail before Telegram; local harness rejects real API roots', async () => {
  const tg = await telegramMock([]);
  const app = await startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-1001234', telegramApiRoot: tg.root, publishEnabled: true, telegramReady: true });
  const client = await clientFor(app.url);
  try {
    const bad = await client.callTool({ name: 'publish_story', arguments: { story_id: 'x', attempt_id: randomUUID(), expected_instance_id: app.instanceId, text: 'x', chat_id: '-999' } });
    assert.equal(bad.isError, true);
    const stale = await client.callTool({ name: 'publish_story', arguments: { story_id: 'x', attempt_id: randomUUID(), expected_instance_id: randomUUID(), text: 'x' } });
    assert.equal((stale.structuredContent as Record<string, unknown>).status, 'UNKNOWN');
    assert.equal((stale.structuredContent as Record<string, unknown>).code, 'INSTANCE_CHANGED');
    assert.equal(tg.requests.length, 0);
  } finally { await client.close(); await app.close(); await closeHttp(tg.server); }
  await assert.rejects(startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-1001234', telegramApiRoot: 'https://api.telegram.org/', publishEnabled: true, telegramReady: true }));
});

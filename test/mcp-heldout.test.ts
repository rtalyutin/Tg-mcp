import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { startLocalIntegratedPublisher } from '../src/integrated-server.ts';

const accessToken = randomBytes(32).toString('base64url');
const botToken = '1234:qa_heldout_synthetic_token';
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(reply: (n: number, response: ServerResponse) => void) {
  const calls: Array<{ chat_id: string; text: string }> = [];
  const tg = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    calls.push(JSON.parse(body)); reply(calls.length, res);
  });
  tg.listen(0, '127.0.0.1'); await once(tg, 'listening');
  const address = tg.address(); assert.ok(address && typeof address === 'object');
  const app = await startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-10012345', telegramApiRoot: `http://127.0.0.1:${address.port}`, publishEnabled: true, telegramReady: true, telegramTimeoutMs: 3000 });
  return { app, calls, async close() { await app.close(); const closed = once(tg, 'close'); tg.close(); tg.closeAllConnections(); await closed; } };
}
const success = (res: ServerResponse, id: number) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: id } })); };
// Raw HTTP oracle: each request is a separate connection, no SDK client/session cache.
function rpc(url: string, method: string, params: object = {}, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}`, ...headers } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.setTimeout(5000, () => req.destroy(Error('held-out request timeout'))); req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }));
  });
}
const call = async (url: string, name: string, args: object = {}) => (await rpc(url, 'tools/call', { name, arguments: args })).body.result;
const input = (instance: string, text = 'Привет, Медведь 🐻') => ({ story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: instance, text });

test('held-out MCP: inventory and shared in-flight state across independent HTTP connections', async () => {
  const received = latch(); let held!: ServerResponse;
  const f = await fixture((n, res) => { if (n === 1) { held = res; received.release(); } else success(res, n); });
  try {
    const list = (await rpc(f.app.url, 'tools/list')).body.result.tools;
    assert.deepEqual(list.map((x: any) => x.name), ['get_publisher_status', 'publish_story', 'get_publish_attempt']);
    for (const t of list) { assert.equal(t.inputSchema.additionalProperties, false); assert.equal(t.outputSchema.additionalProperties, false); }
    assert.equal(list[1].annotations.readOnlyHint, false); assert.equal(list[1].annotations.idempotentHint, false); assert.equal(list[1].annotations.openWorldHint, true);
    assert.equal(list[0].annotations.readOnlyHint, true); assert.equal(list[2].annotations.readOnlyHint, true);
    const data = input(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'В');
    const sending = call(f.app.url, 'publish_story', data); await received.promise;
    const read = await call(f.app.url, 'get_publish_attempt', { attempt_id: data.attempt_id, expected_instance_id: f.app.instanceId });
    assert.equal(read.structuredContent.status, 'IN_PROGRESS'); assert.equal(read.structuredContent.remaining_parts, 2);
    const replay = await call(f.app.url, 'publish_story', { ...data, attempt_id: randomUUID() });
    assert.equal(replay.structuredContent.attempt_id, data.attempt_id); assert.equal(replay.structuredContent.status, 'IN_PROGRESS');
    const busy = await call(f.app.url, 'publish_story', input(f.app.instanceId)); assert.equal(busy.structuredContent.code, 'BUSY');
    assert.equal(f.calls.length, 1); success(held, 1);
    const completed = await sending; assert.equal(completed.structuredContent.status, 'PUBLISHED');
    assert.deepEqual(completed.structuredContent.confirmed_messages.map((x: any) => x.message_id), [1, 2, 3]);
    assert.equal(f.calls.map(x => x.text).join(''), data.text); assert.ok(f.calls.every(x => x.chat_id === '-10012345'));
    const state = await call(f.app.url, 'get_publisher_status'); assert.equal(state.structuredContent.instance_id, data.expected_instance_id);
    assert.deepEqual((await call(f.app.url, 'publish_story', data)).structuredContent, completed.structuredContent);
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('held-out MCP: PARTIAL and UNKNOWN persist across connections, no third part or retries', async () => {
  for (const status of [429, 500]) {
    const f = await fixture((n, res) => { if (n === 1) success(res, 10); else { res.statusCode = status; res.end(JSON.stringify({ ok: false, error_code: status })); } });
    try {
      const data = input(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'В');
      const result = (await call(f.app.url, 'publish_story', data)).structuredContent;
      assert.equal(result.status, status === 429 ? 'PARTIAL' : 'UNKNOWN'); assert.equal(result.remaining_parts, 1);
      assert.equal(result.uncertain_part_index, status === 429 ? null : 2);
      assert.equal(result.automatic_retry_allowed, false); assert.equal(result.manual_check_required, true);
      assert.deepEqual((await call(f.app.url, 'get_publish_attempt', { attempt_id: data.attempt_id, expected_instance_id: f.app.instanceId })).structuredContent, result);
      assert.deepEqual((await call(f.app.url, 'publish_story', { ...data, attempt_id: randomUUID() })).structuredContent, result);
      await call(f.app.url, 'publish_story', data); assert.equal(f.calls.length, 2);
    } finally { await f.close(); }
  }
});

test('held-out MCP: authentication, malformed tool arguments and stale identity cannot send', async () => {
  const f = await fixture((n, res) => success(res, n));
  try {
    const data = input(f.app.instanceId);
    assert.equal((await rpc(f.app.url, 'tools/call', { name: 'publish_story', arguments: data }, { authorization: 'Bearer wrong' })).status, 401);
    for (const patch of [{ chat_id: '-1009999' }, { text: '' }, { expected_instance_id: 'bad' }, { force: true }]) {
      assert.equal((await call(f.app.url, 'publish_story', { ...data, ...patch })).isError, true);
    }
    assert.equal((await call(f.app.url, 'get_publish_attempt', { attempt_id: data.attempt_id, expected_instance_id: f.app.instanceId, chat_id: '-1' })).isError, true);
    const stale = (await call(f.app.url, 'publish_story', { ...data, expected_instance_id: randomUUID() })).structuredContent;
    assert.equal(stale.status, 'UNKNOWN'); assert.equal(stale.code, 'INSTANCE_CHANGED'); assert.equal(stale.remaining_parts, null);
    assert.equal((await call(f.app.url, 'get_publish_attempt', { attempt_id: data.attempt_id, expected_instance_id: f.app.instanceId })).structuredContent.code, 'ATTEMPT_NOT_KNOWN');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('held-out MCP: real/external API roots fail synchronously before any server startup', async () => {
  for (const telegramApiRoot of ['https://api.telegram.org/', 'https://127.0.0.1:444/', 'http://example.com:80/', 'http://localhost:333/', 'http://127.0.0.1:333/?next=https://api.telegram.org', 'http://user:pass@127.0.0.1:333/']) {
    await assert.rejects(startLocalIntegratedPublisher({ accessToken, botToken, channelId: '-10012345', telegramApiRoot, publishEnabled: true, telegramReady: true }));
  }
});

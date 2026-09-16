import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalProbe, MAX_BODY_BYTES } from '../src/server.ts';

const token = randomBytes(32).toString('base64url');
const rpc = (method: string, params: object = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('official MCP client: initialize, list, read twice; one readonly tool, stable instance', async () => {
  const probe = await startLocalProbe(token);
  const client = new Client({ name: 'acceptance-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(probe.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['get_publisher_status']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    const first = await client.callTool({ name: 'get_publisher_status', arguments: {} });
    const second = await client.callTool({ name: 'get_publisher_status', arguments: {} });
    assert.deepEqual(first.structuredContent, second.structuredContent);
    const state = first.structuredContent as Record<string, unknown>;
    assert.equal(state.publish_enabled, false);
    assert.equal(state.telegram_ready, false);
    assert.equal(state.reason_code, 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED');
    assert.equal(JSON.stringify(first).includes(token), false);
    const unknown = await client.callTool({ name: 'get_publisher_status', arguments: { chat_id: '-1001' } });
    assert.equal(unknown.isError, true);
    const write = await client.callTool({ name: 'publish_story', arguments: { text: 'do not send' } });
    assert.equal(write.isError, true);
  } finally { await client.close(); await probe.close(); }
});

test('HTTP boundary rejects unauthorized calls, hostile origins, malformed and oversized input', async () => {
  const probe = await startLocalProbe(token);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const post = (body: string, extra = {}) => fetch(probe.url, { method: 'POST', headers: { ...headers, ...extra }, body });
  try {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      for (const Authorization of ['', 'Bearer wrong']) assert.equal((await post(JSON.stringify(rpc(method)), { Authorization })).status, 401);
    }
    assert.equal((await post('{}', { Origin: 'https://evil.example' })).status, 403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(probe.url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', reject); req.end('{}');
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
    assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(probe.url, { headers })).status, 405);
    assert.equal((await fetch(probe.url + '?token=secret', { headers })).status, 404);
    const health = await fetch(probe.url.replace('/mcp', '/healthz'));
    assert.deepEqual(await health.json(), { status: 'ok' });
  } finally { await probe.close(); }
});

test('new server lifetime produces a new instance ID; invalid config never starts', async () => {
  const read = async () => {
    const probe = await startLocalProbe(token);
    const client = new Client({ name: 'restart-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(probe.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const result = await client.callTool({ name: 'get_publisher_status', arguments: {} });
      return (result.structuredContent as Record<string, unknown>).instance_id;
    } finally { await client.close(); await probe.close(); }
  };
  const first = await read();
  assert.match(String(first), /^[0-9a-f-]{36}$/);
  assert.notEqual(first, await read());
  await assert.rejects(startLocalProbe(''));
  await assert.rejects(startLocalProbe(token, -1));
});

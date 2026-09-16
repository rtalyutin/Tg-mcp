import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startLocalProbe, MAX_BODY_BYTES } from '../src/server.ts';

// Independent acceptance: raw node:http requests, no SDK client or author's helpers.
const token = randomBytes(32).toString('base64url');
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
function raw(url: string, body: string, override: Record<string, string> = {}, method = 'POST', chunked = false) {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request(url, { method, headers: { ...headers, ...override } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => {
        let body: unknown = null; try { body = JSON.parse(text); } catch { /* record text */ }
        resolve({ status: res.statusCode!, body, text });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('acceptance request timeout')));
    req.on('error', reject);
    if (chunked) { req.write(body.slice(0, 1024)); req.end(body.slice(1024)); }
    else req.end(body);
  });
}
const call = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'get_publisher_status', arguments: {} } });

test('independent raw MCP: handshake, one tool, concurrent stable state, restarted state differs', async () => {
  const first = await startLocalProbe(token);
  let firstId: string;
  try {
    const init = await raw(first.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-raw', version: '1' } } }));
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'story-publisher-local-probe');
    const listing = await raw(first.url, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    assert.deepEqual(listing.body.result.tools.map((t: any) => t.name), ['get_publisher_status']);
    const results = await Promise.all(Array.from({ length: 12 }, () => raw(first.url, call)));
    const states = results.map(r => { assert.equal(r.status, 200); return r.body.result.structuredContent; });
    firstId = states[0].instance_id;
    for (const state of states) {
      assert.deepEqual(state, states[0]);
      assert.equal(state.publish_enabled, false); assert.equal(state.telegram_ready, false);
      assert.equal(state.channel_title, null); assert.equal(state.channel_username, null);
      assert.equal(state.reason_code, 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED');
    }
    assert.equal(JSON.stringify(results).includes(token), false);
  } finally { await first.close(); }
  const restarted = await startLocalProbe(token);
  try { assert.notEqual((await raw(restarted.url, call)).body.result.structuredContent.instance_id, firstId); }
  finally { await restarted.close(); }
});

test('independent raw HTTP: authentication covers all methods and hostile Host/Origin rejected', async () => {
  const probe = await startLocalProbe(token);
  try {
    for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS', 'HEAD']) {
      assert.equal((await raw(probe.url, '', { Authorization: '' }, method)).status, 401, method);
      assert.equal((await raw(probe.url, '', { Authorization: 'Bearer not-the-token' }, method)).status, 401, method);
    }
    for (const value of [`http://127.0.0.1:${new URL(probe.url).port}`, 'null', 'https://attacker.invalid']) {
      assert.equal((await raw(probe.url, call, { Origin: value })).status, 403);
    }
    for (const value of ['localhost', 'attacker.invalid', '127.0.0.1:1']) {
      assert.equal((await raw(probe.url, call, { Host: value })).status, 403);
    }
    assert.equal((await raw(probe.url, call, { Authorization: `Basic ${token}` })).status, 401);
    assert.equal((await raw(probe.url, call, { Authorization: `Bearer ${token}x` })).status, 401);
    assert.equal((await raw(probe.url, call)).status, 200);
  } finally { await probe.close(); }
});

test('independent raw HTTP: invalid JSON, RPC shape, extra tool arguments and chunked oversize rejected', async () => {
  const probe = await startLocalProbe(token);
  try {
    for (const malformed of ['{', 'null', '123', '{}']) {
      const result = await raw(probe.url, malformed);
      assert.ok(result.status >= 400, `${malformed}: ${result.status}`);
    }
    for (const args of [{ extra: true }, { __proto__: null, text: 'write attempted' }]) {
      const result = await raw(probe.url, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_publisher_status', arguments: args } }));
      assert.equal(result.body.result.isError, true);
    }
    const unknown = await raw(probe.url, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'publish_story', arguments: { text: 'synthetic no-send' } } }));
    assert.equal(unknown.body.result.isError, true);
    const oversized = await raw(probe.url, ' '.repeat(MAX_BODY_BYTES + 1), { 'Transfer-Encoding': 'chunked' }, 'POST', true);
    assert.equal(oversized.status, 413);
    assert.equal((await raw(probe.url, call)).status, 200, 'still healthy after rejected input');
    assert.ok((await raw(probe.url, '[]')).status >= 400, 'empty JSON-RPC batch must not be accepted');
  } finally { await probe.close(); }
});

test('independent CLI guards refuse production, external HOST and publishing enabled', () => {
  for (const patch of [{ NODE_ENV: 'production' }, { HOST: '0.0.0.0' }, { PUBLISH_ENABLED: 'true' }]) {
    const result = spawnSync(process.execPath, ['src/main.ts'], {
      cwd: new URL('..', import.meta.url), timeout: 3000,
      env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PUBLISH_ENABLED: 'false', LOCAL_PROBE_TOKEN: token, ...patch }, encoding: 'utf8',
    });
    assert.equal(result.status, 1, JSON.stringify(patch));
    assert.equal(result.stdout.includes('Local read-only probe'), false);
    assert.equal(result.stderr.includes(token), false);
  }
});

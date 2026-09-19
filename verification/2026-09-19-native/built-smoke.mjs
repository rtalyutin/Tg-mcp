import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startLocalIntegratedPublisher } from '../../dist/integrated-server.js';

const token = 'heldout_synthetic_probe_abcdefghijklmnopqrstuvwxyz';
const cleanEnv = { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PUBLISH_ENABLED: 'false', PORT: '0', LOCAL_PROBE_TOKEN: token };
async function call(url, name, args = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200); return (await response.json()).result.structuredContent;
}
const child = spawn(process.execPath, ['dist/main.js'], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('error', reject);
    child.once('exit', code => { if (!output.includes('/mcp')) { clearTimeout(timer); reject(new Error(`early exit ${code}`)); } });
  });
  const health = await fetch(new URL('/healthz', url));
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const status = await call(url, 'get_publisher_status');
  assert.equal(status.publish_enabled, false); assert.equal(status.telegram_ready, false);
  assert.equal(status.reason_code, 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED');
  console.log('PASS built main: loopback startup, health, unauthenticated 401, authenticated disabled status');
} finally {
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
for (const [name, patch, message] of [
  ['production', { NODE_ENV: 'production' }, 'production OAuth and remote binding are not implemented'],
  ['external host', { HOST: '0.0.0.0' }, 'production OAuth and remote binding are not implemented'],
  ['publish flag', { PUBLISH_ENABLED: 'true' }, 'This build cannot enable publishing'],
]) {
  const result = spawnSync(process.execPath, ['dist/main.js'], { env: { ...cleanEnv, ...patch }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.ok(result.stderr.includes(message));
  assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes(token));
  console.log(`PASS built startup guard: ${name}`);
}
for (const uncertain of [false, true]) {
  const texts = [];
  const telegram = createServer(async (req, res) => {
    assert.ok(req.url.endsWith('/sendMessage'));
    let body = ''; for await (const bytes of req) body += bytes.toString();
    const data = JSON.parse(body); assert.equal(data.chat_id, '-1007788'); texts.push(data.text);
    res.setHeader('content-type', 'application/json');
    if (uncertain && texts.length === 2) { res.statusCode = 500; res.end('{"ok":false}'); }
    else res.end(JSON.stringify({ ok: true, result: { message_id: texts.length } }));
  });
  telegram.listen(0, '127.0.0.1'); await once(telegram, 'listening');
  const app = await startLocalIntegratedPublisher({ accessToken: token, botToken: '7788:heldout_synthetic_only', channelId: '-1007788', telegramApiRoot: `http://127.0.0.1:${telegram.address().port}/`, publishEnabled: true, telegramReady: true });
  try {
    const text = ('Заголовок 🐻\n\nе\u0301 👨‍👩‍👧‍👦 東京\r\n').repeat(400);
    const input = { story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: app.instanceId, text };
    const result = await call(app.url, 'publish_story', input);
    assert.equal(result.status, uncertain ? 'UNKNOWN' : 'PUBLISHED');
    assert.equal(result.automatic_retry_allowed, false);
    if (uncertain) {
      assert.equal(texts.length, 2); assert.equal(result.uncertain_part_index, 2);
      assert.deepEqual(await call(app.url, 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: app.instanceId }), result);
      assert.deepEqual(await call(app.url, 'publish_story', { ...input, attempt_id: randomUUID() }), result);
      assert.equal(texts.length, 2);
    } else {
      assert.equal(texts.join(''), text); assert.ok(texts.length > 2);
      assert.ok(texts.every(part => part.isWellFormed() && part.length <= 4096));
      assert.deepEqual(result.confirmed_messages.map(message => message.message_id), texts.map((_text, index) => index + 1));
    }
    console.log(uncertain ? 'PASS built MCP integration: UNKNOWN; exactly 2 send requests; lookup and replay add zero sends' : `PASS built MCP integration: PUBLISHED; ${texts.length} send requests; complete Unicode matches; ordered message IDs`);
  } finally {
    await app.close(); const closed = once(telegram, 'close'); telegram.close(); telegram.closeAllConnections(); await closed;
  }
}

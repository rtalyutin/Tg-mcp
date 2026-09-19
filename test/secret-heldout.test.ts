import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalSecretPublisher, startSecretPublisher } from '../src/secret-server.ts';
import { readProductionConfig } from '../src/production-config.ts';

// Independent acceptance: synthetic capability/token, loopback Telegram only.
const secret = 'abcde019'.repeat(8);
const token = '78543:secret_heldout_SYNTHETIC';
const channelId = '-10078543';
type Reply = { status: number; headers: IncomingHttpHeaders; raw: string; body: any };
const envelope = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
function http(url: string, options: { path?: string; method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    // Explicit raw path avoids URL normalization hiding alias/encoding bypasses.
    const req = request({ hostname: target.hostname, port: target.port, path: options.path ?? target.pathname,
      method: options.method ?? 'POST', agent: false,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...options.headers } }, res => {
      let raw = ''; res.on('data', part => { raw += part; }); res.on('error', reject);
      res.on('end', () => { let body: any; try { body = JSON.parse(raw); } catch { body = raw; } resolve({ status: res.statusCode!, headers: res.headers, raw, body }); });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('held-out HTTP deadline'))); req.end(options.body);
  });
}
const rpc = (url: string, method: string, params: object = {}) => http(url, { body: envelope(method, params) });
const tool = (url: string, name: string, args: object = {}) => rpc(url, 'tools/call', { name, arguments: args });
const input = (instanceId: string, text = 'Синтетическая сказка 🐻') => ({ story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: instanceId, text });
function json(res: ServerResponse, result: unknown, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
async function fixture(profile: 'readonly' | 'publisher' = 'publisher', enabled = profile === 'publisher') {
  const calls: Array<{ method: string; body: any }> = [];
  let sendNumber = 0; let unknownAt = 0; let holdAt = 0;
  let notifySend!: () => void; const entered = new Promise<void>(resolve => { notifySend = resolve; });
  let releaseSend!: () => void; const released = new Promise<void>(resolve => { releaseSend = resolve; });
  const bot = { id: 78543, is_bot: true };
  const tg = createServer(async (req, res) => {
    assert.ok(req.url?.startsWith(`/bot${token}/`));
    const method = req.url!.split('/').at(-1)!;
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ method, body: JSON.parse(raw) });
    if (method === 'getMe') json(res, { ok: true, result: bot });
    else if (method === 'getChat') json(res, { ok: true, result: { id: Number(channelId), type: 'channel', title: 'Synthetic secret QA' } });
    else if (method === 'getChatMember') json(res, { ok: true, result: { user: bot, status: 'administrator', can_post_messages: true } });
    else {
      assert.equal(method, 'sendMessage'); sendNumber++;
      if (sendNumber === holdAt) { notifySend(); await released; }
      if (sendNumber === unknownAt) { req.socket.destroy(); return; }
      json(res, { ok: true, result: { message_id: 800 + sendNumber } });
    }
  });
  tg.listen(0, '127.0.0.1'); await once(tg, 'listening'); const addr = tg.address(); assert.ok(addr && typeof addr !== 'string');
  const app = await startLocalSecretPublisher({ profile, publishEnabled: enabled, secret: { publicOrigin: 'http://127.0.0.1:34999', pathSecret: secret },
    botToken: token, channelId, telegramApiRoot: `http://127.0.0.1:${addr.port}/`, minPublishIntervalMs: 0 });
  return { app, calls, entered, releaseSend,
    failAt(index: number) { unknownAt = index; }, holdAt(index: number) { holdAt = index; },
    async close() { releaseSend(); await app.close(); const closed = once(tg, 'close'); tg.close(); tg.closeAllConnections(); await closed; } };
}

test('held-out secret: minimal readonly config has no OAuth/Telegram prerequisites; invalid settings fail closed without values', async () => {
  const env: NodeJS.ProcessEnv = { MCP_AUTH_MODE: 'secret_path', MCP_PUBLIC_ORIGIN: 'https://publisher.example/', MCP_PATH_SECRET: secret };
  const config = readProductionConfig(env); assert.equal(config.authMode, 'secret_path'); assert.equal(config.profile, 'readonly');
  assert.equal(config.publishEnabled, false); assert.equal(config.port, 8080);
  assert.equal('oauth' in config, false); assert.equal(config.botToken, undefined);
  for (const patch of [
    { MCP_PUBLIC_ORIGIN: 'http://publisher.example' }, { MCP_PUBLIC_ORIGIN: 'https://publisher.example/mcp' },
    { MCP_PUBLIC_ORIGIN: 'https://user:synthetic-password@publisher.example/' }, { MCP_PUBLIC_ORIGIN: 'https://publisher.example/?token=synthetic-password' },
    { MCP_PUBLIC_ORIGIN: 'https://127.0.0.1' }, { MCP_PUBLIC_ORIGIN: 'https://localhost' }, { MCP_PUBLIC_ORIGIN: 'https://[::1]' },
    { MCP_PATH_SECRET: '' }, { MCP_PATH_SECRET: secret.toUpperCase() }, { MCP_PATH_SECRET: `${secret}a` },
    { MCP_PROFILE: 'publisher' }, { PUBLISH_ENABLED: 'true' }, { MCP_AUTH_MODE: 'none' },
    { HOST: '127.0.0.1' }, { TELEGRAM_API_ROOT: 'https://api.telegram.org/' }, { MOCK_TELEGRAM_ROOT: '' },
  ]) {
    assert.throws(() => readProductionConfig({ ...env, ...patch }), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes('synthetic-password')); return true;
    });
  }
  assert.throws(() => startLocalSecretPublisher({ profile: 'publisher', publishEnabled: true, secret: { publicOrigin: 'http://127.0.0.1:34999', pathSecret: secret }, botToken: token, channelId }));
  assert.throws(() => startLocalSecretPublisher({ profile: 'publisher', publishEnabled: true, secret: { publicOrigin: 'http://127.0.0.1:34999', pathSecret: secret }, botToken: token, channelId, telegramApiRoot: 'https://api.telegram.org/' }));
});

test('held-out secret: no-auth SDK connects, readonly advertises exactly one safe tool, secret absent from responses', async () => {
  const f = await fixture('readonly'); const client = new Client({ name: 'independent-secret-qa', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(f.app.url)));
    const listing = await client.listTools(); assert.deepEqual(listing.tools.map(t => t.name), ['get_publisher_status']);
    assert.deepEqual(listing.tools[0]._meta?.securitySchemes, [{ type: 'noauth' }]);
    const status = await client.callTool({ name: 'get_publisher_status', arguments: {} });
    assert.equal((status.structuredContent as any).publish_enabled, false); assert.equal((status.structuredContent as any).telegram_ready, false);
    await assert.rejects(client.callTool({ name: 'publish_story', arguments: input(f.app.instanceId) }));
    assert.equal(f.calls.length, 0);
    const serialized = JSON.stringify({ listing, status }); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(token));
  } finally { await client.close(); await f.close(); }
});

test('held-out secret: raw path aliases, encoding, query, wrong secret and OAuth routes never disclose tools or invoke Telegram', async () => {
  const f = await fixture();
  try {
    const paths = ['/mcp', '/', `/mcp/${'0'.repeat(64)}`, `/mcp/${secret}/`, `/mcp/${secret}?x=1`, `/mcp/${secret}#fragment`,
      `/mcp/%61${secret.slice(1)}`, `/mcp/${secret.toUpperCase()}`, `/mcp//${secret}`, `/junk/../mcp/${secret}`, `//mcp/${secret}`,
      '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
    for (const path of paths) {
      const response = await http(f.app.url, { path, body: envelope('tools/call', { name: 'publish_story', arguments: input(f.app.instanceId) }) });
      assert.equal(response.status, 404, path); assert.deepEqual(response.body, { error: 'NOT_FOUND' });
      assert.ok(!response.raw.includes(secret)); assert.equal(response.headers.location, undefined);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('held-out secret: wrong Host and browser Origin denied; internal-host health is minimal GET/HEAD only', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { origin: 'null' }] as Record<string, string>[]) {
      const response = await http(f.app.url, { headers, body: envelope('tools/list') }); assert.equal(response.status, 403);
    }
    for (const method of ['GET', 'HEAD']) {
      const response = await http(f.app.url, { method, path: '/healthz', headers: { host: 'internal-container:8080' } });
      assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      if (method === 'GET') assert.deepEqual(response.body, { status: 'ok' }); else assert.equal(response.raw, '');
    }
    assert.equal((await http(f.app.url, { path: '/healthz', headers: { host: 'internal-container:8080' }, body: '{}' })).status, 403);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('held-out secret: rejected HTTP methods, malformed UTF8, body shape and excess input cannot execute side effects', async () => {
  const f = await fixture();
  try {
    assert.equal((await http(f.app.url, { method: 'GET' })).status, 405);
    assert.equal((await http(f.app.url, { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    for (const body of ['{broken', Buffer.from([0xff, 0xfe]), 'null', '[]']) {
      assert.equal((await http(f.app.url, { body })).status, 400);
    }
    const injected = await tool(f.app.url, 'publish_story', { ...input(f.app.instanceId), channel_id: '-10000001' });
    assert.equal(injected.body.error.code, -32602);
    const invalid = await tool(f.app.url, 'get_publisher_status', { arbitrary: true }); assert.equal(invalid.body.error.code, -32602);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
  const readonly = await fixture('readonly');
  try { assert.equal((await http(readonly.app.url, { body: ' '.repeat(16385) })).status, 413); assert.equal(readonly.calls.length, 0); }
  finally { await readonly.close(); }
});

test('held-out secret: full Unicode/paragraph text remains exact, ordered and in the configured channel', async () => {
  const f = await fixture();
  try {
    const listing = (await rpc(f.app.url, 'tools/list')).body.result.tools;
    assert.deepEqual(listing.map((t: any) => t.name), ['get_publisher_status', 'publish_story', 'get_publish_attempt']);
    assert.ok(listing.every((t: any) => JSON.stringify(t.securitySchemes) === '[{"type":"noauth"}]'));
    assert.equal(listing[1].annotations.readOnlyHint, false); assert.equal(listing[1].annotations.idempotentHint, false);
    const text = 'Медведь и семья 👩🏽‍👩🏻‍👦🏿: е\u0301, 🏳️‍🌈, 🇷🇺.\n\n'.repeat(240); const story = input(f.app.instanceId, text);
    const response = await tool(f.app.url, 'publish_story', story); const result = response.body.result.structuredContent;
    assert.equal(result.status, 'PUBLISHED'); assert.equal(result.remaining_parts, 0);
    const sends = f.calls.filter(c => c.method === 'sendMessage'); assert.ok(sends.length > 1);
    assert.equal(sends.map(c => c.body.text).join(''), text);
    assert.ok(sends.every(c => c.body.chat_id === channelId && c.body.text.length <= 4096 && !('parse_mode' in c.body)));
    assert.deepEqual(result.confirmed_messages.map((m: any) => m.message_id), sends.map((_, i) => 801 + i));
    const boundaries = new Set(Array.from(new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(text), s => s.index));
    let offset = 0; for (const send of sends) { assert.ok(boundaries.has(offset)); offset += send.body.text.length; }
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.ok(!response.raw.includes(secret)); assert.ok(!response.raw.includes(token));
  } finally { await f.close(); }
});

test('held-out secret: new-story throttle cannot be disabled by caller; known replay and lookup remain available without sends', async () => {
  const f = await fixture();
  try {
    const story = input(f.app.instanceId); const result = (await tool(f.app.url, 'publish_story', story)).body.result.structuredContent;
    assert.equal(result.status, 'PUBLISHED'); const count = f.calls.length;
    const different = input(f.app.instanceId, 'Другая сказка');
    assert.equal((await tool(f.app.url, 'publish_story', different)).body.result.structuredContent.code, 'PUBLISH_RATE_LIMITED');
    assert.equal((await tool(f.app.url, 'get_publish_attempt', { attempt_id: different.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent.code, 'ATTEMPT_NOT_KNOWN');
    assert.deepEqual((await tool(f.app.url, 'publish_story', { ...story, attempt_id: randomUUID() })).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, 'get_publish_attempt', { attempt_id: story.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent, result);
    assert.equal((await tool(f.app.url, 'publish_story', { ...story, text: `${story.text}!` })).body.result.structuredContent.code, 'ATTEMPT_CONFLICT');
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});

test('held-out secret: dropped second send yields UNKNOWN and a new request/attempt cannot resend any part', async () => {
  const f = await fixture();
  try {
    f.failAt(2); const story = input(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'Последняя часть');
    const result = (await tool(f.app.url, 'publish_story', story)).body.result.structuredContent;
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.uncertain_part_index, 2); assert.equal(result.remaining_parts, 1);
    assert.equal(result.automatic_retry_allowed, false); assert.equal(result.manual_check_required, true);
    assert.deepEqual(result.confirmed_messages, [{ part_index: 1, message_id: 801, message_url: null }]);
    const calls = f.calls.length;
    assert.deepEqual((await tool(f.app.url, 'publish_story', story)).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, 'publish_story', { ...story, attempt_id: randomUUID() })).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, 'get_publish_attempt', { attempt_id: story.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent, result);
    assert.equal(f.calls.length, calls); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 2);
  } finally { await f.close(); }
});

test('held-out secret: disabled publication and permanent stop cannot be bypassed by possession of endpoint', async () => {
  const f = await fixture('publisher', false);
  try {
    assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'PUBLISH_DISABLED');
    await f.app.stop(); assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'SHUTTING_DOWN');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('held-out secret: in-flight duplicate reports IN_PROGRESS, second story is BUSY and shutdown waits for only current part', async () => {
  const f = await fixture();
  try {
    f.holdAt(1); const story = input(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'Конец');
    const sending = tool(f.app.url, 'publish_story', story); await f.entered;
    assert.equal((await tool(f.app.url, 'publish_story', story)).body.result.structuredContent.status, 'IN_PROGRESS');
    assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'BUSY');
    let stopped = false; const stopping = f.app.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    f.releaseSend(); const result = (await sending).body.result.structuredContent; await stopping;
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.code, 'SHUTTING_DOWN'); assert.equal(result.remaining_parts, 2);
    assert.equal(result.manual_check_required, true); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
    assert.deepEqual((await tool(f.app.url, 'publish_story', story)).body.result.structuredContent, result);
  } finally { await f.close(); }
});

test('held-out secret: restart/stale instance returns UNKNOWN without claiming persisted deduplication', async () => {
  const first = await fixture(); let original: ReturnType<typeof input>;
  try { original = input(first.app.instanceId); assert.equal((await tool(first.app.url, 'publish_story', original)).body.result.structuredContent.status, 'PUBLISHED'); }
  finally { await first.close(); }
  const second = await fixture();
  try {
    const result = (await tool(second.app.url, 'publish_story', original!)).body.result.structuredContent;
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.code, 'INSTANCE_CHANGED'); assert.equal(result.automatic_retry_allowed, false);
    assert.equal(second.calls.length, 0);
    assert.equal((await tool(second.app.url, 'get_publish_attempt', { attempt_id: original!.attempt_id, expected_instance_id: second.app.instanceId })).body.result.structuredContent.code, 'ATTEMPT_NOT_KNOWN');
  } finally { await second.close(); }
});

test('held-out secret: production proxy controls enforce configured host and explicit HTTPS scheme without external requests', async () => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const addr = reservation.address(); assert.ok(addr && typeof addr !== 'string'); const port = addr.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const app = await startSecretPublisher({ profile: 'readonly', publishEnabled: false, port, secret: { publicOrigin: 'https://publisher.example', pathSecret: secret } });
  const url = `http://127.0.0.1:${port}/mcp/${secret}`;
  try {
    const allowed = { host: 'publisher.example', 'x-forwarded-proto': 'https' };
    assert.equal((await http(url, { headers: allowed, body: envelope('tools/list') })).status, 200);
    for (const proto of ['http', 'https,http', 'HTTPS']) assert.equal((await http(url, { headers: { ...allowed, 'x-forwarded-proto': proto }, body: envelope('tools/list') })).status, 403);
    assert.equal((await http(url, { headers: { ...allowed, host: 'wrong.example', 'x-forwarded-host': 'publisher.example' }, body: envelope('tools/list') })).status, 403);
    assert.equal((await http(url, { path: '/healthz', method: 'GET', headers: { host: `internal:${port}` } })).status, 200);
  } finally { await app.close(); }
});

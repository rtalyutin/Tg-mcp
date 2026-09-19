import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalPublicPublisher, startLocalSecretPublisher } from '../src/secret-server.ts';
import { startLocalOAuthPublisher } from '../src/oauth-server.ts';
import { readProductionConfig } from '../src/production-config.ts';

// Independent regression for the public profile. All data synthetic; HTTP only loopback.
const token = '63071:public_heldout_SYNTHETIC'; const channelId = '-10063071';
const localOrigin = 'http://127.0.0.1:34876';
function http(url: string, body?: string, path?: string, headers: Record<string, string> = {}) {
  const target = new URL(url);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: path ?? target.pathname,
      method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers } }, res => {
      let raw = ''; res.on('data', part => { raw += part; }); res.on('error', reject);
      res.on('end', () => { let value: any; try { value = JSON.parse(raw); } catch { value = raw; } resolve({ status: res.statusCode!, body: value }); });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('public held-out deadline'))); req.end(body);
  });
}
const rpc = (url: string, method: string, params: object = {}) => http(url, JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }));
const tool = (url: string, name: string, args: object = {}) => rpc(url, 'tools/call', { name, arguments: args });
const input = (instanceId: string, text = 'Синтетическая сказка 🐻') => ({ story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: instanceId, text });
async function fixture(profile: 'readonly' | 'publisher' = 'readonly', enabled = profile === 'publisher', failSecond = false) {
  const calls: Array<{ method: string; body: any }> = []; let sends = 0;
  const bot = { id: 63071, is_bot: true };
  const tg = createServer(async (req, res) => {
    assert.ok(req.url?.startsWith(`/bot${token}/`)); const method = req.url!.split('/').at(-1)!;
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ method, body: JSON.parse(raw) });
    if (method === 'sendMessage' && ++sends === 2 && failSecond) { req.socket.destroy(); return; }
    const result = method === 'getMe' ? bot : method === 'getChat' ? { id: Number(channelId), type: 'channel', title: 'Synthetic public QA' }
      : method === 'getChatMember' ? { user: bot, status: 'administrator', can_post_messages: true } : { message_id: 910 + sends };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  tg.listen(0, '127.0.0.1'); await once(tg, 'listening'); const a = tg.address(); assert.ok(a && typeof a !== 'string');
  const app = await startLocalPublicPublisher({ profile, publishEnabled: enabled, publicOrigin: localOrigin,
    botToken: token, channelId, telegramApiRoot: `http://127.0.0.1:${a.port}/`, minPublishIntervalMs: 0 });
  return { app, calls, async close() { await app.close(); const closed = once(tg, 'close'); tg.close(); tg.closeAllConnections(); await closed; } };
}

test('held-out public: empty config is readonly; implicit publisher and incomplete authentication never silently become public', () => {
  const config = readProductionConfig({}); assert.ok(config.authMode === 'public'); assert.equal(config.profile, 'readonly');
  assert.equal(config.publishEnabled, false); assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, 'https://rtalyutin-tg-mcp-fb9b.twc1.net');
  for (const patch of [
    { MCP_AUTH_MODE: 'oauth' }, { MCP_AUTH_MODE: 'secret_path' }, { MCP_AUTH_MODE: 'invalid' },
    { MCP_PATH_SECRET: '0123'.repeat(16) }, { MCP_RESOURCE_URL: 'https://publisher.example/mcp' },
    { OAUTH_ISSUER: '' }, { MCP_PATH_SECRET: '' }, { OAUTH_ISSUER: 'https://issuer.example' }, { OAUTH_JWKS_URI: 'https://issuer.example/keys' }, { OAUTH_ALLOWED_SUBJECT: 'synthetic-owner' },
    { MCP_PROFILE: 'publisher', TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHANNEL_ID: channelId, PUBLISH_ENABLED: 'true' },
    { MCP_PROFILE: 'publisher', TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHANNEL_ID: channelId, PUBLISH_ENABLED: 'false' },
    { PUBLISH_ENABLED: 'true' }, { MCP_PUBLIC_ORIGIN: 'http://publisher.example' },
  ]) assert.throws(() => readProductionConfig(patch), JSON.stringify(patch));
  const explicit = readProductionConfig({ MCP_AUTH_MODE: 'public', MCP_PROFILE: 'publisher', PUBLISH_ENABLED: 'true', TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHANNEL_ID: channelId });
  assert.equal(explicit.authMode, 'public'); assert.equal(explicit.profile, 'publisher'); assert.equal(explicit.publishEnabled, true);
});

test('held-out public: unauthenticated SDK readonly exposes only state, has no publishing side effects', async () => {
  const f = await fixture(); const client = new Client({ name: 'public-independent-qa', version: '1' });
  try {
    assert.equal(new URL(f.app.url).pathname, '/mcp');
    await client.connect(new StreamableHTTPClientTransport(new URL(f.app.url)));
    const list = await client.listTools(); assert.deepEqual(list.tools.map(t => t.name), ['get_publisher_status']);
    assert.deepEqual(list.tools[0]._meta?.securitySchemes, [{ type: 'noauth' }]);
    const status = (await client.callTool({ name: 'get_publisher_status', arguments: {} })).structuredContent as any;
    assert.equal(status.publish_enabled, false); assert.equal(status.telegram_ready, false); assert.equal(status.channel_title, null);
    await assert.rejects(client.callTool({ name: 'publish_story', arguments: input(f.app.instanceId) }));
    assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(status).includes(token));
  } finally { await client.close(); await f.close(); }
});

test('held-out public: exact route and Host/Origin preserved; secret/OAuth profiles have no anonymous fallback', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const path of ['/mcp/', '/mcp?x=1', '/%6dcp', `/mcp/${'a'.repeat(64)}`, '/.well-known/oauth-protected-resource']) {
      assert.equal((await http(f.app.url, body, path)).status, 404, path);
    }
    assert.equal((await http(f.app.url, body, '/mcp', { host: 'attacker.invalid' })).status, 403);
    assert.equal((await http(f.app.url, body, '/mcp', { origin: 'https://attacker.invalid' })).status, 403);
    assert.deepEqual(await http(f.app.url, undefined, '/healthz', { host: 'internal:8080' }), { status: 200, body: { status: 'ok' } });
  } finally { await f.close(); }
  const secret = await startLocalSecretPublisher({ profile: 'readonly', publishEnabled: false, secret: { publicOrigin: localOrigin, pathSecret: '0123'.repeat(16) } });
  try { assert.equal((await http(secret.url, '{}', '/mcp')).status, 404); } finally { await secret.close(); }
  const oauth = await startLocalOAuthPublisher({ profile: 'readonly', publishEnabled: false,
    oauth: { resource: `${localOrigin}/mcp`, issuer: `${localOrigin}/`, jwksUri: `${localOrigin}/keys`, allowedSubject: 'synthetic-owner' } });
  try { assert.equal((await rpc(oauth.url, 'tools/list')).status, 401); } finally { await oauth.close(); }
});

test('held-out public: explicit publisher keeps honest metadata, exact ordered Unicode, fixed channel, throttle and replay', async () => {
  const f = await fixture('publisher');
  try {
    const listing = (await rpc(f.app.url, 'tools/list')).body.result.tools; assert.equal(listing.length, 3);
    const write = listing.find((t: any) => t.name === 'publish_story'); assert.equal(write.annotations.readOnlyHint, false); assert.equal(write.annotations.idempotentHint, false);
    assert.deepEqual(write.securitySchemes, [{ type: 'noauth' }]);
    const text = 'Семья 👩🏽‍👩🏻‍👦🏿 и Медведь 🐻, е\u0301.\n\n'.repeat(310); const story = input(f.app.instanceId, text);
    const result = (await tool(f.app.url, 'publish_story', story)).body.result.structuredContent; assert.equal(result.status, 'PUBLISHED');
    const sends = f.calls.filter(c => c.method === 'sendMessage'); assert.ok(sends.length > 1); assert.equal(sends.map(c => c.body.text).join(''), text);
    assert.ok(sends.every(c => c.body.chat_id === channelId && c.body.text.length <= 4096));
    assert.deepEqual(result.confirmed_messages.map((m: any) => m.message_id), sends.map((_, i) => 911 + i));
    const count = f.calls.length;
    assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'PUBLISH_RATE_LIMITED');
    assert.deepEqual((await tool(f.app.url, 'publish_story', { ...story, attempt_id: randomUUID() })).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, 'get_publish_attempt', { attempt_id: story.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent, result);
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});

test('held-out public: uncertain second send stops sequence and public retries cannot resend story', async () => {
  const f = await fixture('publisher', true, true);
  try {
    const story = input(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'Конец');
    const result = (await tool(f.app.url, 'publish_story', story)).body.result.structuredContent;
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.uncertain_part_index, 2); assert.equal(result.remaining_parts, 1);
    assert.equal(result.automatic_retry_allowed, false); assert.equal(result.manual_check_required, true); assert.equal(result.confirmed_messages.length, 1);
    const count = f.calls.length;
    assert.deepEqual((await tool(f.app.url, 'publish_story', story)).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, 'publish_story', { ...story, attempt_id: randomUUID() })).body.result.structuredContent, result);
    assert.equal(f.calls.length, count); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 2);
  } finally { await f.close(); }
});

test('held-out public: disabled and stopped profiles cannot send; local publisher requires a loopback Telegram mock', async () => {
  assert.throws(() => startLocalPublicPublisher({ profile: 'publisher', publishEnabled: true, publicOrigin: localOrigin, botToken: token, channelId }));
  assert.throws(() => startLocalPublicPublisher({ profile: 'publisher', publishEnabled: true, publicOrigin: localOrigin, botToken: token, channelId, telegramApiRoot: 'https://api.telegram.org/' }));
  const f = await fixture('publisher', false);
  try {
    assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'PUBLISH_DISABLED');
    await f.app.stop(); assert.equal((await tool(f.app.url, 'publish_story', input(f.app.instanceId))).body.result.structuredContent.code, 'SHUTTING_DOWN');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

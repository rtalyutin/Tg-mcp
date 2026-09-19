import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { JWTPayload, JWSHeaderParameters } from 'jose';
import { startLocalOAuthPublisher, startProductionPublisher } from '../src/oauth-server.ts';
import { readProductionConfig } from '../src/production-config.ts';

// Independent QA oracle: raw HTTP, ephemeral signing keys and loopback services.
// No real IdP, account, credential, Telegram channel, or platform is involved.
const resource = 'http://127.0.0.1:38123/mcp';
const owner = 'synthetic-owner-heldout';
const botToken = '90231:heldout_oauth_synthetic_bot';
const channelId = '-10090231';
const readScope = 'stories:read';
const allScopes = 'stories:read stories:write';
type Reply = { status: number; headers: IncomingHttpHeaders; body: any; raw: string };
function http(url: string, options: { method?: string; token?: string; headers?: Record<string, string | string[]>; body?: string | Buffer; delayEnd?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'POST', agent: false,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('error', reject);
      res.on('end', () => { let body: any; try { body = JSON.parse(raw); } catch { body = raw; } resolve({ status: res.statusCode!, headers: res.headers, raw, body }); });
    });
    req.setTimeout(9000, () => req.destroy(new Error('held-out HTTP deadline'))); req.on('error', reject);
    if (options.delayEnd) { req.write(options.body?.slice(0, 1) ?? '{'); setTimeout(() => req.end(options.body?.slice(1) ?? '}'), options.delayEnd); }
    else req.end(options.body);
  });
}
const rpcBody = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
const rpc = (url: string, token: string, method: string, params: object = {}) => http(url, { token, body: rpcBody(method, params) });
const tool = (url: string, token: string, name: string, args: object = {}) => rpc(url, token, 'tools/call', { name, arguments: args });
const story = (instanceId: string, text = 'Проверочная сказка 🐻') => ({ story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: instanceId, text });
function json(res: ServerResponse, body: unknown, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

async function fixture(profile: 'readonly' | 'publisher' = 'publisher', keyMode = 'normal', publishEnabled = profile === 'publisher', algorithm: 'ES256' | 'RS256' = 'ES256') {
  const key = await generateKeyPair(algorithm);
  const publicKey = { ...await exportJWK(key.publicKey), kid: 'heldout-key-1', alg: algorithm, use: 'sig' };
  const keyPaths: string[] = []; const tgCalls: Array<{ method: string; body: any }> = [];
  let sends = 0; let failAt = 0; let mode = keyMode;
  const service = createServer(async (req, res) => {
    const path = req.url!;
    if (path.startsWith('/keys') || path === '/attacker') {
      keyPaths.push(path);
      if (path === '/attacker') { json(res, { keys: [publicKey] }); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: '/attacker' }); res.end(); return; }
      if (mode === 'oversize') { json(res, { padding: 'x'.repeat(131073), keys: [publicKey] }); return; }
      if (mode === 'broken') { res.end('{invalid'); return; }
      if (mode === 'utf8') { res.end(Buffer.from([0xff, 0xfe, 0xfd])); return; }
      if (mode === 'error') { json(res, { keys: [publicKey] }, 503); return; }
      if (mode === 'stall') { res.writeHead(200); res.write('{'); return; }
      json(res, { keys: [publicKey] }); return;
    }
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    assert.ok(path.startsWith(`/bot${botToken}/`), 'only synthetic Telegram path is expected');
    const method = path.split('/').at(-1)!; const body = JSON.parse(bytes); tgCalls.push({ method, body });
    const bot = { id: 90231, is_bot: true };
    if (method === 'getMe') json(res, { ok: true, result: bot });
    else if (method === 'getChat') json(res, { ok: true, result: { id: Number(channelId), type: 'channel', title: 'Synthetic QA channel' } });
    else if (method === 'getChatMember') json(res, { ok: true, result: { user: bot, status: 'administrator', can_post_messages: true } });
    else if (method === 'sendMessage') { sends++; if (sends === failAt) json(res, { ok: false, error_code: 500 }, 500); else json(res, { ok: true, result: { message_id: 700 + sends } }); }
    else assert.fail(`unexpected synthetic method ${method}`);
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  const address = service.address(); assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}`;
  const oauth = { resource, issuer: `${root}/issuer`, jwksUri: `${root}/keys`, allowedSubject: owner };
  const app = await startLocalOAuthPublisher({ oauth, profile, publishEnabled,
    ...(profile === 'publisher' ? { botToken, channelId, telegramApiRoot: root, telegramTimeoutMs: 2000 } : {}) });
  const token = async (patch: JWTPayload = {}, header: Partial<JWSHeaderParameters> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: oauth.issuer, aud: resource, sub: owner, iat: now, exp: now + 120, scope: allScopes, ...patch })
      .setProtectedHeader({ alg: algorithm, kid: publicKey.kid, ...header }).sign(key.privateKey);
  };
  return { app, oauth, root, keyPaths, tgCalls, token, key, setMode(value: string) { mode = value; }, failSendAt(value: number) { failAt = value; },
    async close() { await app.close(); const closed = once(service, 'close'); service.close(); service.closeAllConnections(); await closed; } };
}

test('held-out OAuth: fixed metadata, minimal health and advertised auth are independent of forwarded headers', async () => {
  const f = await fixture();
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await http(new URL(path, f.app.url).href, { method: 'GET', headers: { forwarded: 'host=attacker.invalid;proto=http', 'x-forwarded-host': 'attacker.invalid' } });
      assert.equal(response.status, 200); assert.deepEqual(response.body, { resource, authorization_servers: [f.oauth.issuer], scopes_supported: [readScope, 'stories:write'], bearer_methods_supported: ['header'] });
      assert.equal(response.headers['cache-control'], 'no-store'); assert.ok(!response.raw.includes(owner));
    }
    assert.deepEqual((await http(new URL('/healthz', f.app.url).href, { method: 'GET' })).body, { status: 'ok' });
    const unauthorized = await rpc(f.app.url, '', 'tools/list'); assert.equal(unauthorized.status, 401);
    assert.ok(unauthorized.headers['www-authenticate']?.includes(`${resource.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp`));
    assert.ok(!unauthorized.raw.includes(owner)); assert.equal(f.tgCalls.length, 0); assert.deepEqual(f.keyPaths, []);
    const tools = (await rpc(f.app.url, await f.token(), 'tools/list')).body.result.tools;
    assert.equal(tools.find((t: any) => t.name === 'publish_story').annotations.readOnlyHint, false);
    assert.deepEqual(tools.find((t: any) => t.name === 'publish_story').securitySchemes, [{ type: 'oauth2', scopes: [readScope, 'stories:write'] }]);
    assert.equal(f.tgCalls.length, 0);
  } finally { await f.close(); }
});

test('held-out OAuth: signature, issuer, audience, subject and time claims fail before tool execution', async () => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const badClaims: JWTPayload[] = [
      { iss: `${f.oauth.issuer}/other` }, { aud: `${resource}/other` }, { aud: ['different-resource'] }, { sub: `${owner}-intruder` },
      { exp: now - 2 }, { exp: undefined }, { iat: undefined }, { nbf: now + 100 }, { iat: now + 100, exp: now + 200 },
      { iat: now, exp: now }, { scope: [readScope] }, { sub: undefined }, { iss: undefined }, { aud: undefined },
    ];
    const input = story(f.app.instanceId);
    for (const claims of badClaims) {
      const response = await tool(f.app.url, await f.token(claims), 'publish_story', input);
      assert.equal(response.status, 401, `claims ${JSON.stringify(claims)}`); assert.deepEqual(response.body, { error: 'invalid_token' });
    }
    const forged = await generateKeyPair('ES256');
    const token = await new SignJWT({ iss: f.oauth.issuer, aud: resource, sub: owner, iat: now, exp: now + 100, scope: allScopes }).setProtectedHeader({ alg: 'ES256', kid: 'heldout-key-1' }).sign(forged.privateKey);
    assert.equal((await tool(f.app.url, token, 'publish_story', input)).status, 401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`;
    assert.equal((await tool(f.app.url, none, 'publish_story', input)).status, 401);
    assert.equal(f.tgCalls.length, 0);
    const lookup = await tool(f.app.url, await f.token(), 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: f.app.instanceId });
    assert.equal(lookup.body.result.structuredContent.code, 'ATTEMPT_NOT_KNOWN');
  } finally { await f.close(); }
});

test('held-out OAuth: read scope permits reads; exact write permission is enforced before registration', async () => {
  const f = await fixture();
  try {
    const input = story(f.app.instanceId);
    for (const scope of [readScope, `${readScope} stories:writer`, `${readScope} prefixstories:write`, `${readScope} stories:write:all`]) {
      const response = await tool(f.app.url, await f.token({ scope }), 'publish_story', input);
      assert.equal(response.status, 200); assert.equal(response.body.result.isError, true);
      assert.match(response.body.result._meta['mcp/www_authenticate'][0], /insufficient_scope/);
    }
    for (const scope of ['stories:write', 'prefixstories:read', 'stories:read:all', '']) assert.equal((await rpc(f.app.url, await f.token({ scope }), 'tools/list')).status, 403);
    assert.equal(f.tgCalls.length, 0);
    assert.equal((await tool(f.app.url, await f.token({ scope: readScope }), 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent.code, 'ATTEMPT_NOT_KNOWN');
    const status = await tool(f.app.url, await f.token({ scope: readScope }), 'get_publisher_status');
    assert.equal(status.body.result.structuredContent.telegram_ready, true);
    assert.deepEqual(f.tgCalls.map(c => c.method), ['getMe', 'getChat', 'getChatMember']);
    const result = await tool(f.app.url, await f.token(), 'publish_story', input);
    assert.equal(result.body.result.structuredContent.status, 'PUBLISHED');
    assert.equal(f.tgCalls.filter(c => c.method === 'sendMessage').length, 1);
  } finally { await f.close(); }
});

test('held-out OAuth: readonly inventory and dispatch remain readonly even with valid write scope', async () => {
  const f = await fixture('readonly');
  try {
    const token = await f.token();
    assert.deepEqual((await rpc(f.app.url, token, 'tools/list')).body.result.tools.map((t: any) => t.name), ['get_publisher_status']);
    const state = (await tool(f.app.url, token, 'get_publisher_status')).body.result.structuredContent;
    assert.equal(state.publish_enabled, false); assert.equal(state.telegram_ready, false); assert.equal(state.channel_title, null);
    for (const name of ['publish_story', 'get_publish_attempt']) assert.equal((await tool(f.app.url, token, name, story(f.app.instanceId))).body.error.code, -32602);
    const meta = await http(new URL('/.well-known/oauth-protected-resource/mcp', f.app.url).href, { method: 'GET' });
    assert.deepEqual(meta.body.scopes_supported, [readScope]); assert.equal(f.tgCalls.length, 0);
  } finally { await f.close(); }
});

test('held-out OAuth: malformed envelopes, extra recipient controls, host and origin are denied without writes', async () => {
  const f = await fixture();
  try {
    const token = await f.token(); const input = story(f.app.instanceId);
    for (const headers of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }] as Record<string, string>[]) assert.equal((await http(f.app.url, { token, headers, body: rpcBody('tools/list') })).status, 403);
    const duplicate = await http(f.app.url, { headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] }, body: rpcBody('tools/list') }); assert.equal(duplicate.status, 401);
    for (const body of ['[]', 'null', '{bad', Buffer.from([0xff])]) assert.equal((await http(f.app.url, { token, body })).status, 400);
    assert.equal((await http(f.app.url, { token, body: rpcBody('tools/list'), headers: { 'content-type': 'text/plain' } })).status, 415);
    for (const patch of [{ channel_id: '-199' }, { chat_id: '-199' }, { telegram_ready: true }, { force: true }]) {
      const response = await tool(f.app.url, token, 'publish_story', { ...input, ...patch }); assert.equal(response.body.error.code, -32602);
    }
    assert.equal(f.tgCalls.length, 0);
  } finally { await f.close(); }
});

test('held-out OAuth: JWT jku/x5u cannot redirect key retrieval and unknown kid fails closed', async () => {
  const f = await fixture();
  try {
    const header = { jku: `${f.root}/attacker`, x5u: `${f.root}/attacker` };
    assert.equal((await rpc(f.app.url, await f.token({}, header), 'tools/list')).status, 200);
    assert.deepEqual(f.keyPaths, ['/keys']);
    assert.equal((await rpc(f.app.url, await f.token({}, { ...header, kid: 'unknown-kid' }), 'tools/list')).status, 401);
    assert.deepEqual(f.keyPaths, ['/keys']); assert.equal(f.tgCalls.length, 0);
  } finally { await f.close(); }
});

test('held-out OAuth: bounded malformed/oversize/error/redirect JWKS fails closed with no redirected request', async () => {
  for (const mode of ['broken', 'oversize', 'utf8', 'error', 'redirect']) {
    const f = await fixture('publisher', mode);
    try {
      const response = await tool(f.app.url, await f.token(), 'publish_story', story(f.app.instanceId));
      assert.equal(response.status, 401, mode); assert.deepEqual(response.body, { error: 'invalid_token' });
      assert.equal(f.tgCalls.length, 0); assert.deepEqual(f.keyPaths, ['/keys']);
    } finally { await f.close(); }
  }
});

test('held-out OAuth: stalled JWKS body reaches bounded failure and never executes Telegram', { timeout: 8500 }, async () => {
  const f = await fixture('publisher', 'stall');
  try {
    const started = Date.now(); const response = await tool(f.app.url, await f.token(), 'publish_story', story(f.app.instanceId));
    assert.equal(response.status, 401); assert.ok(Date.now() - started < 7500); assert.equal(f.tgCalls.length, 0); assert.deepEqual(f.keyPaths, ['/keys']);
  } finally { await f.close(); }
});

test('held-out OAuth: token expiry during body upload is rechecked before tool dispatch', { timeout: 6000 }, async () => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000); const token = await f.token({ iat: now - 1, exp: now + 2 });
    const input = story(f.app.instanceId); const response = await http(f.app.url, { token, body: rpcBody('tools/call', { name: 'publish_story', arguments: input }), delayEnd: 2100 });
    assert.equal(response.status, 401); assert.equal(f.tgCalls.length, 0);
    assert.equal((await tool(f.app.url, await f.token(), 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent.code, 'ATTEMPT_NOT_KNOWN');
  } finally { await f.close(); }
});

test('held-out OAuth: confirmed ordered parts and UNKNOWN survive new connections without duplicate sends', async () => {
  const f = await fixture();
  try {
    f.failSendAt(2); const token = await f.token(); const input = story(f.app.instanceId, 'А'.repeat(4096) + 'Б'.repeat(4096) + 'Конец 🐻');
    const result = (await tool(f.app.url, token, 'publish_story', input)).body.result.structuredContent;
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.uncertain_part_index, 2); assert.equal(result.remaining_parts, 1);
    assert.equal(result.automatic_retry_allowed, false); assert.equal(result.manual_check_required, true);
    assert.deepEqual(result.confirmed_messages, [{ part_index: 1, message_id: 701, message_url: null }]);
    const sends = f.tgCalls.filter(c => c.method === 'sendMessage');
    assert.deepEqual(sends.map(c => c.body), [{ chat_id: channelId, text: 'А'.repeat(4096) }, { chat_id: channelId, text: 'Б'.repeat(4096) }]);
    assert.deepEqual((await tool(f.app.url, token, 'publish_story', { ...input, attempt_id: randomUUID() })).body.result.structuredContent, result);
    assert.deepEqual((await tool(f.app.url, await f.token({ scope: readScope }), 'get_publish_attempt', { attempt_id: input.attempt_id, expected_instance_id: f.app.instanceId })).body.result.structuredContent, result);
    assert.equal(f.tgCalls.filter(c => c.method === 'sendMessage').length, 2);
    assert.ok(!JSON.stringify(result).includes(botToken)); assert.ok(!JSON.stringify(result).includes(token));
  } finally { await f.close(); }
});

test('held-out OAuth: valid authorization cannot bypass publish disabled or stopped state', async () => {
  const f = await fixture('publisher', 'normal', false);
  try {
    const response = (await tool(f.app.url, await f.token(), 'publish_story', story(f.app.instanceId))).body.result.structuredContent;
    assert.equal(response.code, 'PUBLISH_DISABLED'); assert.equal(f.tgCalls.length, 0);
    await f.app.stop(); const stopped = (await tool(f.app.url, await f.token(), 'publish_story', story(f.app.instanceId))).body.result.structuredContent;
    assert.equal(stopped.code, 'SHUTTING_DOWN'); assert.equal(f.tgCalls.length, 0);
  } finally { await f.close(); }
});

test('held-out OAuth: standard RS256 access token publishes full Unicode story sequentially and exactly once', async () => {
  const f = await fixture('publisher', 'normal', true, 'RS256');
  try {
    const token = await f.token(); const text = 'Абзац с семьёй 👨‍👩‍👧‍👦 и ударением е\u0301.\n\n'.repeat(250);
    const input = story(f.app.instanceId, text);
    const result = (await tool(f.app.url, token, 'publish_story', input)).body.result.structuredContent;
    assert.equal(result.status, 'PUBLISHED'); assert.equal(result.remaining_parts, 0);
    const sends = f.tgCalls.filter(c => c.method === 'sendMessage');
    assert.ok(sends.length > 1); assert.equal(sends.map(c => c.body.text).join(''), text);
    assert.ok(sends.every(c => c.body.chat_id === channelId && c.body.text.length <= 4096));
    assert.deepEqual(result.confirmed_messages.map((m: any) => m.message_id), sends.map((_, i) => 701 + i));
    const before = f.tgCalls.length;
    assert.deepEqual((await tool(f.app.url, token, 'publish_story', input)).body.result.structuredContent, result);
    assert.equal(f.tgCalls.length, before);
  } finally { await f.close(); }
});

test('held-out OAuth: production configuration defaults readonly and rejects local auth/test switches before startup', async () => {
  const env: NodeJS.ProcessEnv = { MCP_RESOURCE_URL: 'https://publisher.example/mcp', OAUTH_ISSUER: 'https://identity.example/issuer', OAUTH_JWKS_URI: 'https://identity.example/keys', OAUTH_ALLOWED_SUBJECT: owner };
  const config = readProductionConfig(env); assert.ok(config.authMode === 'oauth'); assert.equal(config.profile, 'readonly'); assert.equal(config.publishEnabled, false);
  for (const patch of [
    { PUBLISH_ENABLED: 'true' }, { PUBLISH_ENABLED: '1' }, { MCP_PROFILE: 'invalid' }, { OAUTH_ALLOWED_SUBJECT: '' },
    { MCP_RESOURCE_URL: 'http://127.0.0.1:8080/mcp' }, { OAUTH_ISSUER: 'https://127.0.0.1/issuer', OAUTH_JWKS_URI: 'https://127.0.0.1/keys' },
    { OAUTH_JWKS_URI: 'https://different.example/keys' }, { MCP_RESOURCE_URL: 'https://publisher.example/mcp?token=x' },
    { OAUTH_JWKS_URI: 'https://user:password@identity.example/keys' }, { LOCAL_PROBE_TOKEN: 'synthetic' },
    { OAUTH_ALLOW_INSECURE: 'false' }, { TELEGRAM_API_ROOT: 'https://api.telegram.org/' }, { HOST: '127.0.0.1' }, { PORT: '0' },
  ]) assert.throws(() => readProductionConfig({ ...env, ...patch }), JSON.stringify(patch));
  await assert.rejects(startProductionPublisher({ ...config, oauth: { ...config.oauth, resource } }));
  await assert.rejects(startLocalOAuthPublisher({ ...config, oauth: { ...config.oauth, resource } }));
});

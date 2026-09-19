import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocalOAuthPublisher } from '../src/oauth-server.ts';
import { readProductionConfig } from '../src/production-config.ts';

async function fixture(profile: 'readonly' | 'publisher', unknown = false) {
  const pair = await generateKeyPair('RS256'); const key = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' };
  const calls: { method: string; text?: string }[] = [];
  const bot = { id: 12345, is_bot: true };
  const network = http.createServer(async (req, res) => {
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [key] })); return; }
    let body = ''; for await (const part of req) body += part.toString();
    const method = req.url!.split('/').pop()!; calls.push({ method, text: JSON.parse(body).text });
    if (unknown && method === 'sendMessage') { res.statusCode = 500; res.end('{}'); return; }
    const result = method === 'getMe' ? bot : method === 'getChat' ? { id: -100123, type: 'channel', title: 'Mock story' }
      : method === 'getChatMember' ? { user: bot, status: 'administrator', can_post_messages: true }
        : { message_id: calls.filter(c => c.method === 'sendMessage').length };
    res.end(JSON.stringify({ ok: true, result }));
  });
  network.listen(0, '127.0.0.1'); await once(network, 'listening');
  const addr = network.address(); assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;
  const oauth = { resource: `${origin}/mcp`, issuer: `${origin}/`, jwksUri: `${origin}/jwks`, allowedSubject: 'synthetic-owner' };
  const app = await startLocalOAuthPublisher({ profile, publishEnabled: profile === 'publisher', oauth,
    botToken: '12345:synthetic_oauth_fixture', channelId: '-100123', telegramApiRoot: `${origin}/` });
  const clients: Client[] = [];
  async function token(scope = 'stories:read stories:write') {
    return new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(oauth.allowedSubject)
      .setIssuer(oauth.issuer).setAudience(oauth.resource).setIssuedAt().setExpirationTime('10m').sign(pair.privateKey);
  }
  async function client(scope?: string) {
    const c = new Client({ name: 'oauth-author-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(app.url), { requestInit: { headers: { Authorization: `Bearer ${await token(scope)}` } } })); clients.push(c); return c;
  }
  return { app, client, calls, token, oauth,
    input: (text: string) => ({ text, story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: app.instanceId }),
    close: async () => { for (const c of clients) await c.close(); await app.close(); network.closeAllConnections(); network.close(); await once(network, 'close'); } };
}

test('OAuth full SDK connection publishes complete Unicode story and replays known attempt across clients', async () => {
  const f = await fixture('publisher');
  try {
    const c = await f.client(); const other = await f.client();
    const tools = await c.listTools(); assert.equal(tools.tools.length, 3);
    const publish = tools.tools.find(t => t.name === 'publish_story')!;
    assert.deepEqual(publish._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['stories:read', 'stories:write'] }]);
    const text = 'Медведь 🐻 и семья 👨‍👩‍👧‍👦.\n\n'.repeat(450); const input = f.input(text);
    const first = await c.callTool({ name: 'publish_story', arguments: input });
    assert.equal((first.structuredContent as Record<string, unknown>)?.status, 'PUBLISHED');
    const sends = f.calls.filter(c => c.method === 'sendMessage'); assert.ok(sends.length > 1); assert.equal(sends.map(c => c.text).join(''), text);
    assert.deepEqual((await other.callTool({ name: 'publish_story', arguments: input })).structuredContent, first.structuredContent);
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, sends.length);
  } finally { await f.close(); }
});

test('read scope cannot publish or register an attempt; step-up error advertises OAuth', async () => {
  const f = await fixture('publisher');
  try {
    const c = await f.client('stories:read'); const input = f.input('Текст');
    const denied = await c.callTool({ name: 'publish_story', arguments: input }); assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied._meta), /insufficient_scope/); assert.equal(f.calls.length, 0);
    const status = await c.callTool({ name: 'get_publish_attempt', arguments: { attempt_id: input.attempt_id, expected_instance_id: input.expected_instance_id } });
    assert.equal((status.structuredContent as Record<string, unknown>)?.code, 'ATTEMPT_NOT_KNOWN'); assert.equal(f.calls.length, 0);
    const writer = await f.client(); assert.equal(((await writer.callTool({ name: 'publish_story', arguments: input })).structuredContent as Record<string, unknown>)?.status, 'PUBLISHED');
  } finally { await f.close(); }
});

test('OAuth read-only profile has a single tool and never contacts Telegram even with write scope', async () => {
  const f = await fixture('readonly');
  try {
    const c = await f.client(); assert.deepEqual((await c.listTools()).tools.map(t => t.name), ['get_publisher_status']);
    const status = await c.callTool({ name: 'get_publisher_status', arguments: {} });
    assert.equal((status.structuredContent as Record<string, unknown>)?.publish_enabled, false); assert.equal((status.structuredContent as Record<string, unknown>)?.telegram_ready, false);
    await assert.rejects(c.callTool({ name: 'publish_story', arguments: f.input('Текст') })); assert.equal(f.calls.length, 0);
    const unauth = await fetch(f.app.url, { method: 'POST' }); assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate')!, /resource_metadata/);
    const metadata = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', f.app.url))).json();
    assert.equal(metadata.resource, f.oauth.resource); assert.deepEqual(metadata.scopes_supported, ['stories:read']);
  } finally { await f.close(); }
});

test('OAuth UNKNOWN stops after one send and repeat/new-attempt same story cannot send again', async () => {
  const f = await fixture('publisher', true);
  try {
    const c = await f.client(); const input = f.input('Я'.repeat(8500));
    const result = await c.callTool({ name: 'publish_story', arguments: input }); assert.equal((result.structuredContent as Record<string, unknown>)?.status, 'UNKNOWN');
    const next = await c.callTool({ name: 'publish_story', arguments: { ...input, attempt_id: randomUUID() } });
    assert.deepEqual(next.structuredContent, result.structuredContent); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  } finally { await f.close(); }
});

test('production config defaults to readonly and fails closed on unsafe or incomplete config', () => {
  const env = { MCP_RESOURCE_URL: 'https://story.example/mcp', OAUTH_ISSUER: 'https://tenant.example/', OAUTH_JWKS_URI: 'https://tenant.example/.well-known/jwks.json', OAUTH_ALLOWED_SUBJECT: 'owner' };
  assert.equal(readProductionConfig(env).profile, 'readonly'); assert.equal(readProductionConfig(env).publishEnabled, false);
  for (const patch of [{ PUBLISH_ENABLED: 'true' }, { PUBLISH_ENABLED: '1' }, { MCP_PROFILE: 'publisher' }, { OAUTH_ALLOWED_SUBJECT: '' },
    { OAUTH_ISSUER: 'http://127.0.0.1:8080/' }, { OAUTH_JWKS_URI: 'https://other.example/keys' }, { MCP_RESOURCE_URL: 'https://localhost/mcp' },
    { PORT: '8oops' }, { TELEGRAM_API_ROOT: 'http://127.0.0.1:8080/' }, { LOCAL_PROBE_TOKEN: 'secret' }]) {
    assert.throws(() => readProductionConfig({ ...env, ...patch }));
  }
});

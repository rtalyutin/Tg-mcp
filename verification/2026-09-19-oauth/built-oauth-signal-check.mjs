import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const key = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(key.publicKey), kid: 'heldout-built-key', alg: 'ES256', use: 'sig' };
const resource = 'http://127.0.0.1:39021/mcp';
let token;
const bot = { id: 88112, is_bot: true };
const channelId = '-10088112';
const storyText = 'А'.repeat(4096) + 'Б'.repeat(4096) + '🐻 конец';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function ok(response, result) { response.end(JSON.stringify({ ok: true, result })); }
async function clientFor(url) {
  const client = new Client({ name: 'heldout-built-signal', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

test('built OAuth JS: native entrypoint validates configuration without service startup or secret output', { timeout: 5000 }, async () => {
  async function run(args, env) {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const [code, signal] = await once(child, 'exit'); return { code, signal, stdout, stderr };
  }
  const config = { MCP_RESOURCE_URL: 'https://publisher.example/mcp', OAUTH_ISSUER: 'https://identity.example/',
    OAUTH_JWKS_URI: 'https://identity.example/keys', OAUTH_ALLOWED_SUBJECT: 'synthetic-owner-built',
    MCP_PROFILE: 'publisher', PUBLISH_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '9912:synthetic_private_fixture', TELEGRAM_CHANNEL_ID: '-1009912' };
  const valid = await run(['app.js', '--check-config'], config);
  assert.deepEqual(valid, { code: 0, signal: null, stdout: 'CONFIG_VALID\n', stderr: '' });
  const invalid = await run(['app.js', '--check-config'], { ...config, OAUTH_ALLOWED_SUBJECT: '' });
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /^STARTUP_FAILED: check required configuration using OAUTH-SETUP\.md\n$/);
  for (const value of Object.values(config)) if (value.length > 8) assert.ok(!invalid.stderr.includes(value));
});
const childSource = `
import { startLocalOAuthPublisher } from './dist/oauth-server.js';
import { installShutdownHandlers } from './dist/lifecycle.js';
const app = await startLocalOAuthPublisher({
  oauth: JSON.parse(process.env.QA_OAUTH), profile: 'publisher', botToken: '88112:heldout_built_synthetic', channelId: '${channelId}',
  telegramApiRoot: process.env.QA_MOCK_ROOT, publishEnabled: true, telegramTimeoutMs: Number(process.env.QA_TIMEOUT),
});
let closes = 0;
const uninstall = installShutdownHandlers(async () => {
  closes++;
  const closing = app.close();
  process.send({ kind: 'stopping', closes });
  await closing;
  process.send({ kind: 'closed', closes });
  uninstall(); process.disconnect();
});
process.send({ kind: 'ready', url: app.url, instanceId: app.instanceId });
`;

for (const scenario of [
  { signal: 'SIGTERM', outcome: 'confirmed', timeoutMs: 2000 },
  { signal: 'SIGINT', outcome: 'timeout', timeoutMs: 400 },
]) {
  test(`built OAuth JS: actual ${scenario.signal} drains active send as ${scenario.outcome}, delivers MCP response, then exits`, { timeout: 8000 }, async () => {
    const sent = deferred(); const calls = [];
    const keyPaths = [];
    const mock = createServer(async (request, response) => {
      if (request.url === '/jwks') { keyPaths.push(request.url); response.end(JSON.stringify({ keys: [jwk] })); return; }
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const method = request.url.split('/').at(-1); calls.push({ method, body: JSON.parse(body) });
      if (method === 'getMe') ok(response, bot);
      else if (method === 'getChat') ok(response, { id: Number(channelId), type: 'channel', title: 'Built QA' });
      else if (method === 'getChatMember') ok(response, { status: 'administrator', can_post_messages: true, user: bot });
      else if (method === 'sendMessage') sent.resolve(response);
      else assert.fail(`unexpected method ${method}`);
    });
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const root = `http://127.0.0.1:${mock.address().port}`;
    const oauth = { resource, issuer: `${root}/issuer`, jwksUri: `${root}/jwks`, allowedSubject: 'heldout-built-owner' };
    token = await new SignJWT({ scope: 'stories:read stories:write' }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(oauth.issuer).setAudience(resource).setSubject(oauth.allowedSubject).setIssuedAt().setExpirationTime('2m').sign(key.privateKey);
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd, env: { ...process.env, QA_OAUTH: JSON.stringify(oauth), QA_MOCK_ROOT: `http://127.0.0.1:${mock.address().port}/`, QA_TIMEOUT: String(scenario.timeoutMs) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    const ready = deferred(); const stopping = deferred(); const closed = deferred();
    child.on('message', message => ({ ready, stopping, closed })[message.kind]?.resolve(message));
    const exited = once(child, 'exit'); let client;
    try {
      const details = await ready.promise; client = await clientFor(details.url);
      const input = { story_id: `signal-${scenario.signal}`, attempt_id: randomUUID(), expected_instance_id: details.instanceId, text: storyText };
      const pending = client.callTool({ name: 'publish_story', arguments: input });
      const current = await sent.promise;
      assert.equal(child.kill(scenario.signal), true); assert.equal((await stopping.promise).closes, 1);
      // A repeated signal while draining must not start a second close or abort the request.
      assert.equal(child.kill(scenario.signal), true);
      if (scenario.outcome === 'confirmed') ok(current, { message_id: 614 });
      const result = await pending; assert.notEqual(result.isError, true); const state = result.structuredContent;
      assert.equal(state.automatic_retry_allowed, false); assert.equal(state.manual_check_required, true);
      if (scenario.outcome === 'confirmed') {
        assert.equal(state.status, 'PARTIAL'); assert.equal(state.code, 'SHUTTING_DOWN');
        assert.deepEqual(state.confirmed_messages, [{ part_index: 1, message_id: 614, message_url: null }]);
        assert.equal(state.uncertain_part_index, null);
      } else {
        assert.equal(state.status, 'UNKNOWN'); assert.equal(state.code, 'DELIVERY_UNKNOWN');
        assert.deepEqual(state.confirmed_messages, []); assert.equal(state.uncertain_part_index, 1);
      }
      assert.equal(state.remaining_parts, 2);
      assert.equal((await closed.promise).closes, 1);
      const [code, signal] = await exited; assert.equal(code, 0, stderr); assert.equal(signal, null);
      assert.deepEqual(keyPaths, ['/jwks']);
      assert.deepEqual(calls.map(c => c.method), ['getMe', 'getChat', 'getChatMember', 'sendMessage']);
      assert.deepEqual(calls.at(-1).body, { chat_id: channelId, text: 'А'.repeat(4096) });
    } finally {
      await client?.close(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      const closedMock = once(mock, 'close'); mock.close(); mock.closeAllConnections(); await closedMock;
    }
  });
}

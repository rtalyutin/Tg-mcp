import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Publisher } from '../src/publisher.ts';
import { readProductionConfig } from '../src/production-config.ts';
import { ConfigError } from '../src/config-error.ts';
import { acceptsSecretPath } from '../src/secret-auth.ts';

test('secret config requires explicit mode, HTTPS origin and a 32-byte secret, with safe errors', () => {
  const secret = randomBytes(32).toString('hex');
  const env = { MCP_AUTH_MODE: 'secret_path', MCP_PUBLIC_ORIGIN: 'https://story.example/', MCP_PATH_SECRET: secret };
  const config = readProductionConfig(env);
  assert.ok(config.authMode === 'secret_path'); assert.equal(config.profile, 'readonly'); assert.equal(config.publishEnabled, false);
  assert.equal(config.secret.publicOrigin, 'https://story.example');
  for (const patch of [{ MCP_AUTH_MODE: '' }, { MCP_AUTH_MODE: 'oauth' }, { MCP_PATH_SECRET: '' }, { MCP_PATH_SECRET: 'short' },
    { MCP_PUBLIC_ORIGIN: 'http://story.example' }, { MCP_PUBLIC_ORIGIN: 'https://story.example/path' }, { MCP_PUBLIC_ORIGIN: 'https://localhost' },
    { MCP_PUBLIC_ORIGIN: 'https://127.0.0.1' }, { MCP_PUBLIC_ORIGIN: 'https://[::1]' }, { MCP_PUBLIC_ORIGIN: 'https://user:pass@story.example' },
    { PUBLISH_ENABLED: 'true' }, { MCP_PROFILE: 'publisher' }, { PORT: 'oops' }, { HOST: '127.0.0.1' }]) {
    assert.throws(() => readProductionConfig({ ...env, ...patch }), e => e instanceof ConfigError && !e.message.includes(secret) && !e.message.includes('user:pass'));
  }
  assert.throws(() => readProductionConfig({ MCP_AUTH_MODE: 'oauth' }), /Missing setting: MCP_RESOURCE_URL/);
});

test('secret matcher accepts exactly one raw route and never URL-decodes aliases', () => {
  const secret = randomBytes(32).toString('hex'); const path = `/mcp/${secret}`;
  assert.equal(acceptsSecretPath(path, secret), true);
  for (const raw of [undefined, '/mcp', path + '/', path + '?x=1', path + '#x', path.replace('/mcp/', '/mcp/%'), path.toUpperCase(), '/mcp/' + '0'.repeat(64)]) assert.equal(acceptsSecretPath(raw, secret), false);
});

test('new-story cooldown preserves known results, rejects before send and expires monotonically', async () => {
  let sends = 0;
  const p = new Publisher({ channelId: '-100123', sender: { async send() { return { kind: 'confirmed', message_id: ++sends }; } },
    readiness: () => ({ publishEnabled: true, telegramReady: true }), minPublishIntervalMs: 100 });
  const input = { attempt_id: randomUUID(), story_id: 'one', expected_instance_id: p.instanceId, text: 'Медведь 🐻' };
  const first = await p.publish(input); assert.equal(first.status, 'PUBLISHED');
  const next = { ...input, attempt_id: randomUUID(), story_id: 'two' };
  const limited = await p.publish(next); assert.equal(limited.code, 'PUBLISH_RATE_LIMITED'); assert.equal(limited.automatic_retry_allowed, false);
  assert.deepEqual(await p.publish(input), first); assert.equal(sends, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  // Explicit caller action on a known rejection, not an implementation retry.
  assert.equal((await p.publish(next)).status, 'PUBLISHED'); assert.equal(sends, 2);
});

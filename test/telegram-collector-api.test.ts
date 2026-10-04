import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramCollectorApi } from '../src/telegram-collector/api.ts';
import { readTelegramCollectorConfig } from '../src/telegram-collector/config.ts';

const token = '123456:synthetic_token_for_local_tests_only';
const credential = '409b9404-4b1c-46fe-9bb1-42d62c5b1cbd';

test('collector is off by default and enabled config fails closed without echoing secrets', () => {
  assert.equal(readTelegramCollectorConfig({}), null);
  assert.equal(readTelegramCollectorConfig({ TELEGRAM_COLLECTOR_ENABLED: 'false', TELEGRAM_COLLECTOR_BOT_TOKEN: 'bad' }), null);
  const env = { OUTREACH_ENABLED: 'true', TELEGRAM_COLLECTOR_ENABLED: 'true', TELEGRAM_COLLECTOR_BOT_TOKEN: token,
    TELEGRAM_COLLECTOR_OWNER_ID: '111', DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID: credential };
  assert.deepEqual(readTelegramCollectorConfig(env), { botToken: token, ownerTelegramId: '111', credentialId: credential, expectedUsername: 'RevitOpenClawBot' });
  for (const change of [{ TELEGRAM_COLLECTOR_OWNER_ID: '' }, { TELEGRAM_COLLECTOR_OWNER_ID: '9007199254740992' },
    { OUTREACH_ENABLED: 'false' }, { TELEGRAM_COLLECTOR_BOT_TOKEN: 'credential-would-leak-in-a-naive-error' },
    { DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID: '' }]) {
    assert.throws(() => readTelegramCollectorConfig({ ...env, ...change }), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes('credential-would-leak')); return true;
    });
  }
});

test('API only invokes read methods and subscribes explicitly to Business updates', async () => {
  const calls: { method: string; input: Record<string, unknown>; redirect: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    calls.push({ method, input: JSON.parse(String(init?.body)), redirect: init?.redirect });
    return Response.json({ ok: true, result: method === 'getUpdates' ? [] : {} });
  }) as typeof fetch;
  const api = new TelegramCollectorApi(token, fetcher);
  await api.getMe(); await api.getWebhookInfo(); await api.getBusinessConnection('connection-a');
  await api.getUpdates(17); await api.getUpdates(null);
  assert.deepEqual(calls.map(call => call.method), ['getMe', 'getWebhookInfo', 'getBusinessConnection', 'getUpdates', 'getUpdates']);
  assert.deepEqual(calls[3].input, { offset: 17, timeout: 25, limit: 100,
    allowed_updates: ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'] });
  assert.ok(!('offset' in calls[4].input));
  assert.ok(calls.every(call => call.redirect === 'error'));
});

test('API errors and oversized streaming replies stay bounded and never reveal token URLs', async () => {
  const failing = new TelegramCollectorApi(token, (async () => { throw new Error(`fetch failed https://api.telegram.org/bot${token}/getMe`); }) as typeof fetch);
  await assert.rejects(failing.getMe(), { message: 'TGC_NETWORK_UNAVAILABLE' });
  const conflict = new TelegramCollectorApi(token, (async () => Response.json({ ok: false, error_code: 409,
    description: 'could contain private information' }, { status: 409 })) as typeof fetch);
  await assert.rejects(conflict.getUpdates(null), { message: 'TGC_CONFLICT' });
  const limited = new TelegramCollectorApi(token, (async () => Response.json({ ok: false, error_code: 429,
    parameters: { retry_after: 9999 } }, { status: 429 })) as typeof fetch);
  await assert.rejects(limited.getMe(), error => {
    assert.ok(error instanceof Error && 'retryAfter' in error); assert.equal(error.retryAfter, 300); return true;
  });
  let canceled = false;
  const huge = new TelegramCollectorApi(token, (async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; },
  }))) as typeof fetch);
  await assert.rejects(huge.getUpdates(null), { message: 'TGC_RESPONSE_TOO_LARGE' });
  assert.equal(canceled, true);
});

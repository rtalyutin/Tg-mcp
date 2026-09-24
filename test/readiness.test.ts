import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { TelegramReadinessChecker } from '../src/telegram.ts';
import { createPublisherRuntime } from '../src/publisher-runtime.ts';

const token = ['12345', 'synthetic_local_fixture'].join(':');
const unavailable = (check_code: string) => ({ ready: false, code: 'TELEGRAM_NOT_READY', check_code });
const bot = { id: 12345, is_bot: true };
const chat = { id: -100123, type: 'channel', title: 'Mock channel', username: 'mock_channel' };
const member = { status: 'administrator', can_post_messages: true, user: bot };
type Reply = { result?: unknown; status?: number; raw?: string; delay?: number; destroy?: boolean; headers?: Record<string, string> };
async function mock(replies: Reply[]) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const reply = replies.shift() ?? { status: 500 };
    if (reply.destroy) { req.socket.destroy(); return; }
    if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
    if (!res.destroyed) {
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.raw ?? JSON.stringify({ ok: true, result: reply.result }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  return { requests, root: `http://127.0.0.1:${addr.port}/`, close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

test('readiness validates exact bot, channel and posting permission with read-only calls', async () => {
  const m = await mock([{ result: bot }, { result: chat }, { result: member }]);
  try {
    const checker = new TelegramReadinessChecker({ botToken: token, apiRoot: m.root });
    assert.deepEqual(await checker.check('-100123'), { ready: true, channel_title: chat.title, channel_username: chat.username });
    assert.deepEqual(m.requests, [
      { path: `/bot${token}/getMe`, body: {} },
      { path: `/bot${token}/getChat`, body: { chat_id: '-100123' } },
      { path: `/bot${token}/getChatMember`, body: { chat_id: '-100123', user_id: 12345 } },
    ]);
  } finally { await m.close(); }
});

test('readiness verifies public username and resolves it to the numeric channel', async () => {
  const m = await mock([{ result: bot }, { result: { ...chat, username: 'talyutinstories' } }, { result: member }]);
  try {
    const checker = new TelegramReadinessChecker({ botToken: token, apiRoot: m.root });
    assert.deepEqual(await checker.check('@talyutinstories'), {
      ready: true, channel_title: chat.title, channel_username: 'talyutinstories', resolved_channel_id: '-100123',
    });
    assert.deepEqual(m.requests.map(request => (request.body as any).chat_id), [undefined, '@talyutinstories', '-100123']);
  } finally { await m.close(); }
  const wrong = await mock([{ result: bot }, { result: { ...chat, username: 'anotherstories' } }]);
  try {
    assert.deepEqual(await new TelegramReadinessChecker({ botToken: token, apiRoot: wrong.root }).check('@talyutinstories', true), unavailable('CHANNEL_MISMATCH'));
    assert.equal(wrong.requests.length, 2);
  } finally { await wrong.close(); }
});

test('readiness rejects wrong identity, channel, rights and malformed envelopes early', async () => {
  const cases: Array<{ replies: Reply[]; code: string }> = [
    { replies: [{ result: { ...bot, is_bot: false } }], code: 'BOT_IDENTITY_INVALID' },
    { replies: [{ result: { ...bot, id: 0 } }], code: 'BOT_IDENTITY_INVALID' },
    { replies: [{ raw: '{' }], code: 'BOT_RESPONSE_INVALID' },
    { replies: [{ raw: '{"ok":false,"description":"private response"}' }], code: 'BOT_RESPONSE_INVALID' },
    { replies: [{ result: bot }, { result: { ...chat, id: -100456 } }], code: 'CHANNEL_MISMATCH' },
    { replies: [{ result: bot }, { result: { ...chat, type: 'supergroup' } }], code: 'CHANNEL_INVALID' },
    { replies: [{ result: bot }, { result: { ...chat, id: '-100123' } }], code: 'CHANNEL_INVALID' },
    { replies: [{ result: bot }, { result: chat }, { result: { ...member, can_post_messages: false } }], code: 'POST_PERMISSION_MISSING' },
    { replies: [{ result: bot }, { result: chat }, { result: { ...member, status: 'member' } }], code: 'BOT_NOT_ADMIN' },
    { replies: [{ result: bot }, { result: chat }, { result: { ...member, user: { ...bot, id: 54321 } } }], code: 'BOT_IDENTITY_MISMATCH' },
  ];
  for (const { replies, code } of cases) {
    const expected = replies.length; const m = await mock(replies);
    try {
      assert.deepEqual(await new TelegramReadinessChecker({ botToken: token, apiRoot: m.root }).check('-100123', true), unavailable(code));
      assert.equal(m.requests.length, expected);
    } finally { await m.close(); }
  }
});

test('readiness rejects HTTP errors, disconnect, timeout, oversize and redirects without retry', async () => {
  for (const { reply, code } of [
    { reply: { status: 201 }, code: 'BOT_HTTP_ERROR' },
    { reply: { status: 401 }, code: 'BOT_TOKEN_REJECTED' },
    { reply: { status: 404 }, code: 'BOT_TOKEN_REJECTED' },
    { reply: { status: 429 }, code: 'BOT_HTTP_ERROR' },
    { reply: { status: 500 }, code: 'BOT_HTTP_ERROR' },
    { reply: { destroy: true }, code: 'BOT_TRANSPORT_FAILED' },
    { reply: { delay: 150 }, code: 'BOT_TRANSPORT_FAILED' },
    { reply: { raw: 'x'.repeat(70_000) }, code: 'BOT_RESPONSE_INVALID' },
    { reply: { status: 307, headers: { location: '/unwanted' } }, code: 'BOT_TRANSPORT_FAILED' },
  ]) {
    const m = await mock([reply]);
    try {
      const result = await new TelegramReadinessChecker({ botToken: token, apiRoot: m.root, timeoutMs: 70 }).check('-100123', true);
      assert.deepEqual(result, unavailable(code)); assert.equal(m.requests.length, 1);
      assert.ok(!JSON.stringify(result).includes(token));
    } finally { await m.close(); }
  }
});

test('readiness supports private channel without username and never caches a prior success', async () => {
  const privateChat = { id: chat.id, type: chat.type, title: chat.title };
  const m = await mock([{ result: bot }, { result: privateChat }, { result: member }, { status: 403 }]);
  try {
    const checker = new TelegramReadinessChecker({ botToken: token, apiRoot: m.root });
    assert.deepEqual(await checker.check('-100123'), { ready: true, channel_title: chat.title, channel_username: null });
    assert.deepEqual(await checker.check('-100123', true), unavailable('BOT_HTTP_ERROR')); assert.equal(m.requests.length, 4);
  } finally { await m.close(); }
});

test('readiness rejects invalid configuration and channel before network', async () => {
  const m = await mock([]);
  try {
    for (const options of [{ botToken: 'bad' }, { botToken: token, timeoutMs: 0 }, { botToken: token, apiRoot: 'https://example.com/' }]) {
      assert.throws(() => new TelegramReadinessChecker(options));
    }
    const checker = new TelegramReadinessChecker({ botToken: token, apiRoot: m.root });
    for (const id of ['@bad', '@mock/other', '100123', '-0', '-100123/other']) assert.deepEqual(await checker.check(id, true), unavailable('CHANNEL_INVALID'));
    assert.equal(m.requests.length, 0);
  } finally { await m.close(); }
});

test('disabled publisher still reports the failed Telegram check for its task', async () => {
  const m = await mock([{ result: bot }, { result: chat }, { result: { ...member, can_post_messages: false } }]);
  const runtime = createPublisherRuntime({ profile: 'publisher', publishEnabled: false, botToken: token,
    taskChannels: { bear: '@mock_channel' } }, m.root);
  try {
    const status = await runtime.status();
    assert.equal(status.publish_enabled, false);
    assert.equal(status.reason_code, 'PUBLISH_DISABLED');
    assert.deepEqual(status.task_status?.[0], { task_id: 'bear', telegram_ready: false, channel_title: null,
      channel_username: null, resolved_channel_id: null, check_code: 'POST_PERMISSION_MISSING' });
    assert.equal(m.requests.length, 3);
  } finally { await runtime.stop(); await m.close(); }
});

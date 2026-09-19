import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { TelegramReadinessChecker } from '../src/telegram.ts';

const token = ['12345', 'synthetic_local_fixture'].join(':');
const unavailable = { ready: false, code: 'TELEGRAM_NOT_READY' };
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

test('readiness rejects wrong identity, channel, rights and malformed envelopes early', async () => {
  const cases: Reply[][] = [
    [{ result: { ...bot, is_bot: false } }], [{ result: { ...bot, id: 0 } }], [{ raw: '{' }], [{ raw: '{"ok":false,"description":"private response"}' }],
    [{ result: bot }, { result: { ...chat, id: -100456 } }],
    [{ result: bot }, { result: { ...chat, type: 'supergroup' } }],
    [{ result: bot }, { result: { ...chat, id: '-100123' } }],
    [{ result: bot }, { result: chat }, { result: { ...member, can_post_messages: false } }],
    [{ result: bot }, { result: chat }, { result: { ...member, status: 'member' } }],
    [{ result: bot }, { result: chat }, { result: { ...member, user: { ...bot, id: 54321 } } }],
  ];
  for (const replies of cases) {
    const expected = replies.length; const m = await mock(replies);
    try {
      assert.deepEqual(await new TelegramReadinessChecker({ botToken: token, apiRoot: m.root }).check('-100123'), unavailable);
      assert.equal(m.requests.length, expected);
    } finally { await m.close(); }
  }
});

test('readiness rejects HTTP errors, disconnect, timeout, oversize and redirects without retry', async () => {
  for (const reply of [
    { status: 201 }, { status: 401 }, { status: 429 }, { status: 500 }, { destroy: true },
    { delay: 150 }, { raw: 'x'.repeat(70_000) },
    { status: 307, headers: { location: '/unwanted' } },
  ]) {
    const m = await mock([reply]);
    try {
      const result = await new TelegramReadinessChecker({ botToken: token, apiRoot: m.root, timeoutMs: 70 }).check('-100123');
      assert.deepEqual(result, unavailable); assert.equal(m.requests.length, 1);
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
    assert.deepEqual(await checker.check('-100123'), unavailable); assert.equal(m.requests.length, 4);
  } finally { await m.close(); }
});

test('readiness rejects invalid configuration and channel before network', async () => {
  const m = await mock([]);
  try {
    for (const options of [{ botToken: 'bad' }, { botToken: token, timeoutMs: 0 }, { botToken: token, apiRoot: 'https://example.com/' }]) {
      assert.throws(() => new TelegramReadinessChecker(options));
    }
    const checker = new TelegramReadinessChecker({ botToken: token, apiRoot: m.root });
    for (const id of ['@mock_channel', '100123', '-0', '-100123/other']) assert.deepEqual(await checker.check(id), unavailable);
    assert.equal(m.requests.length, 0);
  } finally { await m.close(); }
});

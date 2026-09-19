import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { TelegramReadinessChecker } from '../src/telegram.ts';

// Independent network oracle: synthetic fixtures only, bound to loopback.
const botToken = '7788:heldout_synthetic_not_a_secret';
const bot = { id: 7788, is_bot: true };
const chat = { id: -1007788, type: 'channel', title: 'Медведь 🐻 e\u0301 家族 👨‍👩‍👧‍👦' };
const member = { status: 'administrator', can_post_messages: true, user: bot };
const denied = { ready: false, code: 'TELEGRAM_NOT_READY' };
const json = (res: ServerResponse, result: unknown) => res.end(JSON.stringify({ ok: true, result }));
async function fixture(reply: (index: number, res: ServerResponse) => void) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const bytes of req) body += bytes.toString();
    calls.push({ method: req.method!, path: req.url!, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json'); reply(calls.length, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { calls, checker: (timeoutMs = 1500) => new TelegramReadinessChecker({ botToken, timeoutMs, apiRoot: `http://127.0.0.1:${address.port}/` }),
    async close() { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}

test('held-out readiness: Unicode metadata survives and only three exact read methods run', async () => {
  const f = await fixture((n, res) => json(res, [bot, chat, member][n - 1]));
  try {
    assert.deepEqual(await f.checker().check(String(chat.id)), { ready: true, channel_title: chat.title, channel_username: null });
    assert.deepEqual(f.calls, [
      { method: 'POST', path: `/bot${botToken}/getMe`, body: {} },
      { method: 'POST', path: `/bot${botToken}/getChat`, body: { chat_id: String(chat.id) } },
      { method: 'POST', path: `/bot${botToken}/getChatMember`, body: { chat_id: String(chat.id), user_id: bot.id } },
    ]);
  } finally { await f.close(); }
});

test('held-out readiness: strict identity and rights reject eight ambiguous member responses', async () => {
  for (const invalid of [
    { ...member, user: { ...bot, id: String(bot.id) } },
    { ...member, user: { ...bot, is_bot: 'true' } },
    { ...member, user: null }, { ...member, user: [] },
    { ...member, status: 'creator' }, { ...member, status: 'restricted' },
    { ...member, can_post_messages: 1 }, { ...member, can_post_messages: 'true' },
  ]) {
    const f = await fixture((n, res) => json(res, [bot, chat, invalid][n - 1]));
    try { assert.deepEqual(await f.checker().check(String(chat.id)), denied); assert.equal(f.calls.length, 3); }
    finally { await f.close(); }
  }
});

test('held-out readiness: malformed envelopes, fractional IDs and invalid UTF-8 fail closed', async () => {
  const replies = ['null', '[]', '{"ok":1,"result":{}}', '{"ok":true,"result":[]}',
    '{"ok":true,"result":{"id":7788.5,"is_bot":true}}', '{"ok":true,"result":{"id":9007199254740992,"is_bot":true}}',
    Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
    JSON.stringify({ ok: false, description: `DO_NOT_LEAK ${botToken}` })];
  for (const payload of replies) {
    const f = await fixture((_n, res) => res.end(payload));
    try { assert.deepEqual(await f.checker().check(String(chat.id)), denied); assert.equal(f.calls.length, 1); }
    finally { await f.close(); }
  }
});

test('held-out readiness: one deadline covers all requests, not three separate timeouts', async () => {
  const f = await fixture((n, res) => {
    const timer = setTimeout(() => json(res, [bot, chat, member][n - 1]), 200);
    res.on('close', () => clearTimeout(timer));
  });
  try {
    const start = performance.now();
    assert.deepEqual(await f.checker(500).check(String(chat.id)), denied);
    assert.ok(performance.now() - start < 1100, 'aggregate deadline must terminate the sequence');
    assert.equal(f.calls.length, 3, 'deadline should expire during the third response');
  } finally { await f.close(); }
});

test('held-out readiness: unfinished streamed body times out without retries or later methods', async () => {
  const f = await fixture((_n, res) => { res.write('{"ok":true,"result":'); });
  try {
    const start = performance.now();
    assert.deepEqual(await f.checker(120).check(String(chat.id)), denied);
    assert.ok(performance.now() - start < 1000);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('held-out readiness: oversized chunked body is cancelled before server ends it', async () => {
  const f = await fixture((_n, res) => { res.write(' '.repeat(32768)); res.write(' '.repeat(32769)); });
  try {
    const start = performance.now();
    assert.deepEqual(await f.checker(2000).check(String(chat.id)), denied);
    assert.ok(performance.now() - start < 1000, 'must reject the size limit without waiting for timeout');
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('held-out readiness: each check revalidates privileges and exposes no error details', async () => {
  const sequence = [bot, chat, member, bot, chat, { ...member, can_post_messages: false }, bot, chat, member];
  const f = await fixture((n, res) => json(res, { ...sequence[n - 1], description: `DO_NOT_LEAK ${botToken}` }));
  try {
    const checker = f.checker();
    const results = [await checker.check(String(chat.id)), await checker.check(String(chat.id)), await checker.check(String(chat.id))];
    assert.deepEqual(results.map(result => result.ready), [true, false, true]);
    assert.deepEqual(results[1], denied);
    assert.equal(f.calls.length, 9);
    assert.ok(!JSON.stringify(results).includes('DO_NOT_LEAK'));
    assert.ok(!JSON.stringify(results).includes(botToken));
  } finally { await f.close(); }
});

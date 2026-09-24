import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TelegramSender } from '../src/telegram.ts';
import { Publisher } from '../src/publisher.ts';

type Reply = { status?: number; body?: unknown; raw?: string; delay?: number; destroy?: boolean; headers?: Record<string, string> };
async function mock(replies: Reply[]) {
  const requests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const reply = replies.shift() ?? { status: 500, body: { ok: false } };
    if (reply.destroy) { req.socket.destroy(); return; }
    if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
    if (res.destroyed) return;
    const data = reply.raw ?? JSON.stringify(reply.body ?? { ok: true, result: { message_id: requests.length } });
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(data);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, requests, root: `http://127.0.0.1:${address.port}/` };
}
async function close(server: http.Server) { server.closeAllConnections(); server.close(); await once(server, 'close'); }
const token = ['123456789', 'synthetic_token_not_a_secret_123456789'].join(':');

test('Telegram adapter sends a square cover as multipart photo and confirms its message id', async () => {
  const m = await mock([{ body: { ok:true, result:{ message_id:91 } } }]);
  try {
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=', 'base64');
    const sender = new TelegramSender({ botToken:token, apiRoot:m.root });
    assert.deepEqual(await sender.sendPhoto('-1001234',photo,'Начало 🐻\n\nНовый абзац'),{kind:'confirmed',message_id:91});
    assert.equal(m.requests[0].url,`/bot${token}/sendPhoto`);
    assert.match(String(m.requests[0].headers['content-type']),/^multipart\/form-data; boundary=/);
    assert.match(m.requests[0].body,/name="photo"; filename="cover.png"/);
    assert.match(m.requests[0].body,/name="chat_id"/);
    assert.match(m.requests[0].body,/-1001234/);
    assert.match(m.requests[0].body,/name="caption"/);
    assert.match(m.requests[0].body,/Начало 🐻\r\n\r\nНовый абзац/);
    assert.doesNotMatch(m.requests[0].body,/name="parse_mode"/);
    assert.deepEqual(await sender.sendPhoto('-1001234',photo,'а'.repeat(1025)),{kind:'rejected',code:'SEND_REJECTED'});
    assert.equal(m.requests.length,1);
  } finally { await close(m.server); }
});

test('Telegram adapter sends a photo without caption', async () => {
  const m = await mock([{ body: { ok:true, result:{ message_id:92 } } }]);
  try {
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=', 'base64');
    const sender = new TelegramSender({ botToken:token, apiRoot:m.root });
    assert.deepEqual(await sender.sendPhoto('-1001234',photo),{kind:'confirmed',message_id:92});
    assert.equal(m.requests.length,1);
    assert.equal(m.requests[0].url,`/bot${token}/sendPhoto`);
    assert.match(m.requests[0].body,/name="photo"; filename="cover.png"/);
    assert.doesNotMatch(m.requests[0].body,/name="caption"/);
  } finally { await close(m.server); }
});

test('Telegram adapter sends one exact JSON request and confirms only a positive safe message_id', async () => {
  const m = await mock([{ body: { ok: true, result: { message_id: 42, text: 'ignored' } } }]);
  try {
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root });
    assert.deepEqual(await sender.send('-1001234', 'Сказка <&> 🐻'), { kind: 'confirmed', message_id: 42 });
    assert.equal(m.requests.length, 1);
    assert.equal(m.requests[0].method, 'POST');
    assert.equal(m.requests[0].url, `/bot${token}/sendMessage`);
    assert.match(m.requests[0].headers['content-type'] ?? '', /^application\/json/u);
    assert.deepEqual(JSON.parse(m.requests[0].body), { chat_id: '-1001234', text: 'Сказка <&> 🐻' });
    assert.equal('parse_mode' in JSON.parse(m.requests[0].body), false);
  } finally { await close(m.server); }
});

test('Telegram adapter classifies definitive 4xx without parsing bodies and never retries', async () => {
  const cases = [[400, 'SEND_REJECTED'], [401, 'BOT_FORBIDDEN'], [403, 'BOT_FORBIDDEN'], [404, 'SEND_REJECTED'], [429, 'RATE_LIMITED']] as const;
  const m = await mock(cases.map(([status]) => ({ status, raw: 'not-json' })));
  try {
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root });
    for (const [, code] of cases) assert.deepEqual(await sender.send('-1001234', 'text'), { kind: 'rejected', code });
    assert.equal(m.requests.length, cases.length);
  } finally { await close(m.server); }
});

test('Telegram adapter maps timeout, disconnect, 408, 5xx and malformed success to unknown with one request each', async () => {
  const replies: Reply[] = [
    { delay: 80 }, { destroy: true }, { status: 201 }, { status: 408 }, { status: 500 }, { status: 502 },
    { raw: '{' }, { body: { ok: true, result: { message_id: 0 } } }, { body: { ok: false, error_code: 500 } },
  ];
  const expectedRequests = replies.length;
  const m = await mock(replies);
  try {
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root, timeoutMs: 20 });
    for (let i = 0; i < expectedRequests; i++) assert.deepEqual(await sender.send('-1001234', 'text'), { kind: 'unknown' });
    assert.equal(m.requests.length, expectedRequests);
  } finally { await close(m.server); }
});

test('Telegram adapter refuses redirects and oversized bodies without following or confirming', async () => {
  let redirected = 0;
  const target = http.createServer((_req, res) => { redirected++; res.end(JSON.stringify({ ok: true, result: { message_id: 99 } })); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress === 'object');
  const m = await mock([
    { status: 307, headers: { location: `http://127.0.0.1:${targetAddress.port}/stolen` } },
    { raw: JSON.stringify({ ok: true, result: { message_id: 1 }, padding: 'x'.repeat(70_000) }) },
  ]);
  try {
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root });
    assert.deepEqual(await sender.send('-1001234', 'first'), { kind: 'unknown' });
    assert.deepEqual(await sender.send('-1001234', 'second'), { kind: 'unknown' });
    assert.equal(redirected, 0); assert.equal(m.requests.length, 2);
  } finally { await close(m.server); await close(target); }
});

test('Telegram adapter rejects unsafe configuration and invalid direct inputs before HTTP', async () => {
  const m = await mock([]);
  try {
    assert.throws(() => new TelegramSender({ botToken: 'bad', apiRoot: m.root }));
    assert.throws(() => new TelegramSender({ botToken: token, apiRoot: 'https://example.com/' }));
    assert.throws(() => new TelegramSender({ botToken: token, apiRoot: m.root, timeoutMs: 0 }));
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root });
    for (const [channel, text] of [['@other', 'text'], ['-1001234', ''], ['-1001234', '\ud800'], ['-1001234', 'x'.repeat(4097)]]) {
      assert.deepEqual(await sender.send(channel, text), { kind: 'rejected', code: 'SEND_REJECTED' });
    }
    assert.equal(m.requests.length, 0);
  } finally { await close(m.server); }
});

test('Publisher + real HTTP adapter stops after unknown second part and replays no side effects', async () => {
  const m = await mock([{ body: { ok: true, result: { message_id: 7 } } }, { status: 500 }]);
  try {
    const sender = new TelegramSender({ botToken: token, apiRoot: m.root });
    const publisher = new Publisher({ channelId: '-1001234', sender, readiness: () => ({ publishEnabled: true, telegramReady: true }), format: () => ['А', 'Б', 'В'] });
    const input = { story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: publisher.instanceId, text: 'АБВ' };
    const result = await publisher.publish(input);
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.uncertain_part_index, 2);
    assert.deepEqual(result.confirmed_messages.map(x => x.message_id), [7]);
    assert.equal(result.remaining_parts, 1); assert.equal(result.manual_check_required, true);
    assert.equal(result.automatic_retry_allowed, false); assert.equal(m.requests.length, 2);
    await publisher.publish(input); await publisher.publish({ ...input, attempt_id: randomUUID() });
    assert.equal(m.requests.length, 2);
  } finally { await close(m.server); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { TelegramSender } from '../src/telegram.ts';
import { Publisher } from '../src/publisher.ts';

const TOKEN = '23456789:INDEPENDENT_mock_TOKEN-123';
type Seen = { method?: string; url?: string; body: string };
type Route = (res: http.ServerResponse, req: http.IncomingMessage) => void;
async function fixture(routes: Route[]) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const route = routes[seen.length];
    seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    if (route) route(res, req); else { res.writeHead(500); res.end('Unexpected request'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}/`;
  return { seen, root, async close() { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } };
}
function json(status: number, body: unknown): Route { return res => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }; }
const good = (message_id: unknown = 42) => ({ ok: true, result: { message_id } });
const unknown = { kind: 'unknown' };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('QA HTTP: exact endpoint/body with Unicode and safe prefix, no token in result/body', async () => {
  const m = await fixture([json(200, good())]);
  try {
    const text = '  Сказка\r\n🐻 e\u0301 <b>& "/ \\';
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root + 'test-prefix/' });
    const result = await sender.send('-1002345', text);
    assert.deepEqual(result, { kind: 'confirmed', message_id: 42 });
    assert.deepEqual(m.seen, [{ method: 'POST', url: `/test-prefix/bot${TOKEN}/sendMessage`, body: JSON.stringify({ chat_id: '-1002345', text }) }]);
    assert.equal(m.seen[0].body.includes(TOKEN), false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  } finally { await m.close(); }
});

test('QA HTTP: independent status/body matrix, one POST per invocation', async () => {
  const cases: Array<{ status: number; body: unknown; expected: unknown }> = [];
  for (const [status, code] of [[400, 'SEND_REJECTED'], [401, 'BOT_FORBIDDEN'], [403, 'BOT_FORBIDDEN'], [404, 'SEND_REJECTED'], [409, 'SEND_REJECTED'], [422, 'SEND_REJECTED'], [429, 'RATE_LIMITED']] as const) {
    cases.push({ status, body: good(), expected: { kind: 'rejected', code } });
    cases.push({ status: 200, body: { ok: false, error_code: status }, expected: { kind: 'rejected', code } });
  }
  for (const status of [201, 202, 204, 205, 206, 408, 500, 502, 503, 504]) cases.push({ status, body: good(), expected: unknown });
  for (const body of [null, [], true, {}, { ok: 'true', result: { message_id: 1 } }, { ok: true }, { ok: true, result: [] }, ...[0, -1, 1.2, '42', null, Number.MAX_SAFE_INTEGER + 1].map(good), { ok: false, error_code: 408 }, { ok: false, error_code: 500 }, { ok: false, error_code: '429' }]) {
    cases.push({ status: 200, body, expected: unknown });
  }
  cases.push({ status: 200, body: good(Number.MAX_SAFE_INTEGER), expected: { kind: 'confirmed', message_id: Number.MAX_SAFE_INTEGER } });
  const m = await fixture(cases.map(c => json(c.status, c.body)));
  try {
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root });
    for (const c of cases) assert.deepEqual(await sender.send('-123', 'text'), c.expected, JSON.stringify(c));
    assert.equal(m.seen.length, cases.length);
    assert.ok(m.seen.every(x => x.method === 'POST'));
  } finally { await m.close(); }
});

test('QA HTTP: malformed UTF8/JSON, chunked overflow and declared overflow are unknown', async () => {
  const m = await fixture([
    res => res.end('{'),
    res => res.end(Buffer.from([0xff, 0xfe])),
    res => { res.writeHead(200); res.write(' '.repeat(32768)); res.end(' '.repeat(32769)); },
    res => { res.writeHead(200, { 'content-length': '65537' }); res.end(' '.repeat(65537)); },
    res => { res.writeHead(200, { 'content-length': '100' }); res.end('{"ok":true}'); },
  ]);
  try {
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root, timeoutMs: 100 });
    for (let i = 0; i < 5; i++) assert.deepEqual(await sender.send('-123', 'text'), unknown);
    assert.equal(m.seen.length, 5);
  } finally { await m.close(); }
});

test('QA HTTP: exact 64 KiB response can confirm; one extra byte is unknown', async () => {
  const content = JSON.stringify(good());
  const body = content + ' '.repeat(65536 - Buffer.byteLength(content));
  const m = await fixture([
    res => { res.writeHead(200, { 'content-length': '65536' }); res.end(body); },
    res => { res.writeHead(200); res.write(body); res.end(' '); },
  ]);
  try {
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root });
    assert.deepEqual(await sender.send('-123', 'text'), { kind: 'confirmed', message_id: 42 });
    assert.deepEqual(await sender.send('-123', 'text'), unknown);
    assert.equal(m.seen.length, 2);
  } finally { await m.close(); }
});

test('QA HTTP: timeout covers headers and streamed body; socket reset has no retry', async () => {
  const m = await fixture([
    () => {},
    res => { res.writeHead(200); res.write('{"ok":true,'); },
    (_res, req) => req.socket.destroy(),
  ]);
  try {
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root, timeoutMs: 80 });
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      assert.deepEqual(await sender.send('-123', 'text'), unknown);
      assert.ok(performance.now() - start < 1500);
    }
    await delay(30);
    assert.equal(m.seen.length, 3);
  } finally { await m.close(); }
});

test('QA HTTP: all redirect types refuse following another local destination', async () => {
  const target = await fixture([json(200, good())]);
  const statuses = [301, 302, 303, 307, 308];
  const m = await fixture(statuses.map(status => res => { res.writeHead(status, { location: target.root + 'stolen' }); res.end(); }));
  try {
    const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root });
    for (const _ of statuses) assert.deepEqual(await sender.send('-123', 'secret story'), unknown);
    assert.equal(m.seen.length, statuses.length);
    assert.equal(target.seen.length, 0);
  } finally { await m.close(); await target.close(); }
});

test('QA HTTP: unsafe roots, URL injection tokens and invalid timeouts cannot create a sender', () => {
  for (const apiRoot of ['http://api.telegram.org/', 'https://api.telegram.org.evil.test/', 'https://api.telegram.org@evil.test/', 'https://evil.test@api.telegram.org/', 'https://api.telegram.org:444/', 'https://api.telegram.org/?q=x', 'https://api.telegram.org/#x', 'http://127.0.0.2:1234/', 'file:///tmp/x']) {
    assert.throws(() => new TelegramSender({ botToken: TOKEN, apiRoot }));
  }
  for (const botToken of ['123:foo/bar', '123:foo?x=1', '123:foo#x', '123:foo\r\n', '0:abc', '123:']) {
    assert.throws(() => new TelegramSender({ botToken }));
  }
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 60001]) assert.throws(() => new TelegramSender({ botToken: TOKEN, timeoutMs }));
});

test('QA HTTP: early header refusal cancels the unconsumed response stream', async () => {
  for (const status of [200, 400, 503]) {
    let closed = false;
    const m = await fixture([res => {
      res.on('close', () => { closed = true; });
      res.writeHead(status, { 'content-length': '999999' });
      res.flushHeaders();
      res.write('x');
    }]);
    try {
      const sender = new TelegramSender({ botToken: TOKEN, apiRoot: m.root, timeoutMs: 2000 });
      const result = await sender.send('-123', 'text');
      assert.deepEqual(result, status === 400 ? { kind: 'rejected', code: 'SEND_REJECTED' } : unknown);
      await delay(80);
      assert.equal(closed, true, `status ${status}: response remains active after sender returned`);
      assert.equal(m.seen.length, 1);
    } finally { await m.close(); }
  }
});

test('QA Publisher HTTP: real formatter + response loss stops and replay never sends', async () => {
  const m = await fixture([json(200, good(7)), (_res, req) => req.socket.destroy()]);
  try {
    const publisher = new Publisher({ channelId: '-123', sender: new TelegramSender({ botToken: TOKEN, apiRoot: m.root }), readiness: () => ({ publishEnabled: true, telegramReady: true }) });
    const request = { text: 'я'.repeat(4096 * 3), story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: publisher.instanceId };
    const result = await publisher.publish(request);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.uncertain_part_index, 2);
    assert.equal(result.remaining_parts, 1);
    assert.equal(result.manual_check_required, true);
    assert.equal(result.automatic_retry_allowed, false);
    assert.deepEqual(result.confirmed_messages.map(x => x.message_id), [7]);
    assert.equal(m.seen.length, 2);
    assert.deepEqual(m.seen.map(x => JSON.parse(x.body).text), ['я'.repeat(4096), 'я'.repeat(4096)]);
    assert.deepEqual(await publisher.publish(request), result);
    assert.deepEqual(await publisher.publish({ ...request, attempt_id: randomUUID() }), result);
    await delay(30);
    assert.equal(m.seen.length, 2);
  } finally { await m.close(); }
});

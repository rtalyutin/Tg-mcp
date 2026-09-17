import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { splitStoryText, hasSafePartBoundaries, TextFormatError } from '../src/formatter.ts';
import { Publisher, MAX_TEXT_BYTES } from '../src/publisher.ts';

const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });
function invariant(text: string, parts: string[], limit: number) {
  assert.equal(parts.join(''), text);
  const boundaries = new Set(Array.from(segmenter.segment(text), x => x.index + x.segment.length));
  let offset = 0;
  for (const part of parts) {
    assert.ok(part.trim().length > 0, 'no whitespace-only Telegram messages');
    assert.ok(part.length <= limit && part.isWellFormed());
    offset += part.length;
    assert.ok(boundaries.has(offset), `unsafe cut at ${offset}`);
  }
}
// Independent exhaustive partition oracle: enumerate substrings at grapheme cuts;
// deliberately no suffix arrays/range queries/formatter policy in this oracle.
function feasible(text: string, limit: number): boolean {
  if (!text.trim()) return false;
  const ends = Array.from(segmenter.segment(text), x => x.index + x.segment.length);
  function visit(start: number): boolean {
    if (start === text.length) return true;
    for (const end of ends) {
      if (end <= start) continue;
      if (end - start > limit) break;
      if (text.slice(start, end).trim() && visit(end)) return true;
    }
    return false;
  }
  return visit(0);
}
function checkOracle(text: string, limit: number) {
  let parts: string[] | undefined;
  try { parts = splitStoryText(text, limit); }
  catch (error) { assert.ok(error instanceof TextFormatError); }
  const expected = feasible(text, limit);
  assert.equal(Boolean(parts), expected, JSON.stringify({ text, limit }));
  if (parts) invariant(text, parts, limit);
}
function input(p: Publisher, text: string) {
  return { story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: p.instanceId, text };
}
const ready = () => ({ publishEnabled: true, telegramReady: true });

test('independent formatter: exhaustive feasible partitions, spaces and variable-width graphemes', () => {
  const alphabet = ['a', ' ', '\n', '😀'];
  let checked = 0;
  function enumerate(prefix: string, depth: number) {
    if (prefix) for (let limit = 1; limit <= 6; limit++) { checkOracle(prefix, limit); checked++; }
    if (!depth) return;
    for (const symbol of alphabet) enumerate(prefix + symbol, depth - 1);
  }
  enumerate('', 6);
  assert.equal(checked, 32760);
});

test('independent formatter: seeded mixed Unicode oracle and determinism', () => {
  const alphabet = ['a', ' ', '\r\n', 'e\u0301', '👨‍👩‍👧‍👦', '🇷🇺', '\u0301', '.', '\u2029'];
  let seed = 17092026;
  function next() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  for (let n = 0; n < 1000; n++) {
    let text = '';
    for (let j = next() % 7 + 1; j > 0; j--) text += alphabet[next() % alphabet.length];
    const limit = next() % 15 + 1;
    checkOracle(text, limit);
    if (feasible(text, limit)) assert.deepEqual(splitStoryText(text, limit), splitStoryText(text, limit));
  }
});

test('independent formatter: paragraph then sentence then word, preserving separators', () => {
  assert.equal(splitStoryText('Абзац.\n\nВторой абзац тут.', 18)[0], 'Абзац.\n\n');
  assert.equal(splitStoryText('Один. Два слова рядом.', 15)[0], 'Один. ');
  assert.equal(splitStoryText('один два три четыре', 10)[0], 'один два ');
  const original = '  Заголовок\r\n\r\n' + 'Сказка 🐻 e\u0301 👨‍👩‍👧‍👦 🇷🇺. '.repeat(1000) + '\n\t';
  invariant(original, splitStoryText(original), 4096);
  assert.deepEqual(splitStoryText('a    b', 3), ['a  ', '  b']);
});

test('independent formatter: giant clusters and invalid inputs rejected before first send', async () => {
  let calls = 0;
  const publisher = new Publisher({ channelId: '-1001', readiness: ready,
    sender: { async send() { calls++; return { kind: 'confirmed', message_id: calls }; } } });
  const text = 'Valid opening\n\n' + 'e' + '\u0301'.repeat(4096);
  const result = await publisher.publish(input(publisher, text));
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.code, 'TEXT_GRAPHEME_TOO_LONG');
  assert.equal(calls, 0);
  for (const bad of ['', ' \n', '\ud800', 'a\udc00']) assert.throws(() => splitStoryText(bad), TextFormatError);
  for (const limit of [0, -1, 4097, 2.5, NaN, Infinity]) assert.throws(() => splitStoryText('abc', limit), TextFormatError);
  assert.throws(() => splitStoryText('a' + ' '.repeat(8192) + 'b'), /TEXT_CANNOT_SPLIT/);
});

test('independent formatter: exact 256 KiB admission and one-byte overflow', async () => {
  const sent: string[] = [];
  const publisher = new Publisher({ channelId: '-1001', readiness: ready,
    sender: { async send(_channel, text) { sent.push(text); return { kind: 'confirmed', message_id: sent.length }; } } });
  const text = 'a'.repeat(MAX_TEXT_BYTES);
  const result = await publisher.publish(input(publisher, text));
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(sent.length, 64);
  invariant(text, sent, 4096);
  await assert.rejects(publisher.publish(input(publisher, text + 'a')));
  assert.equal(sent.length, 64);
  const unicode = '😀'.repeat(MAX_TEXT_BYTES / 4);
  assert.equal(Buffer.byteLength(unicode), MAX_TEXT_BYTES);
  invariant(unicode, splitStoryText(unicode), 4096);
});

test('independent formatter integration: unknown after real split halts and all replays are send-free', async () => {
  const sent: string[] = [];
  const publisher = new Publisher({ channelId: '-1001', readiness: ready,
    sender: { async send(channel, text) {
      assert.equal(channel, '-1001'); sent.push(text);
      return sent.length === 1 ? { kind: 'confirmed', message_id: 123 } : { kind: 'unknown' };
    } } });
  const text = 'Первая строка 🐻.\n\n'.repeat(1000);
  const expected = splitStoryText(text);
  assert.ok(expected.length > 2);
  const request = input(publisher, text);
  const result = await publisher.publish(request);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.manual_check_required, true);
  assert.equal(result.automatic_retry_allowed, false);
  assert.equal(result.uncertain_part_index, 2);
  assert.equal(result.remaining_parts, expected.length - 2);
  assert.deepEqual(result.confirmed_messages.map(x => [x.part_index, x.message_id]), [[1, 123]]);
  assert.deepEqual(sent, expected.slice(0, 2));
  assert.deepEqual(await publisher.publish(request), result);
  assert.deepEqual(await publisher.publish({ ...request, attempt_id: randomUUID() }), result);
  assert.deepEqual(publisher.getAttemptStatus(requestAsStatus(request)), result);
  assert.equal(sent.length, 2);
});
function requestAsStatus(request: ReturnType<typeof input>) {
  return { attempt_id: request.attempt_id, expected_instance_id: request.expected_instance_id };
}

test('independent formatter integration: rejected second real part is PARTIAL, exception is UNKNOWN', async () => {
  for (const failure of ['reject', 'throw']) {
    let calls = 0;
    const publisher = new Publisher({ channelId: '-1001', readiness: ready,
      sender: { async send() {
        calls++;
        if (calls === 1) return { kind: 'confirmed', message_id: 1 };
        if (failure === 'throw') throw new Error('Lost response');
        return { kind: 'rejected', code: 'RATE_LIMITED' };
      } } });
    const request = input(publisher, 'z'.repeat(4096 * 3));
    const result = await publisher.publish(request);
    assert.equal(result.status, failure === 'reject' ? 'PARTIAL' : 'UNKNOWN');
    assert.equal(result.manual_check_required, true);
    assert.equal(result.automatic_retry_allowed, false);
    assert.deepEqual(await publisher.publish(request), result);
    assert.equal(calls, 2);
  }
});

test('independent formatter integration: injected Unicode boundary damage rejected atomically', async () => {
  for (const parts of [['e', '\u0301x'], ['🇷', '🇺x'], ['👨‍', '👩‍👧‍👦x'], ['a', '\r', '\nb']]) {
    assert.equal(hasSafePartBoundaries(parts.join(''), parts), false);
    let calls = 0;
    const publisher = new Publisher({ channelId: '-1001', readiness: ready, format: () => parts,
      sender: { async send() { calls++; return { kind: 'confirmed', message_id: calls }; } } });
    const result = await publisher.publish(input(publisher, parts.join('')));
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.code, 'FORMAT_INVALID');
    assert.equal(calls, 0);
  }
});

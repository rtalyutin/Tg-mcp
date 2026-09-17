import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { splitStoryText, hasSafePartBoundaries } from '../src/formatter.ts';
import { Publisher } from '../src/publisher.ts';

function check(text: string, limit = 4096) {
  const parts = splitStoryText(text, limit);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => p.trim().length > 0 && p.length <= limit && p.isWellFormed()));
  assert.ok(hasSafePartBoundaries(text, parts));
  assert.deepEqual(splitStoryText(text, limit), parts);
  return parts;
}
test('formatter: short, 4096 and 4097 units keep exact text without added markup', () => {
  for (const text of ['  Заголовок\n\n<&*_ сказка 🐻\r\n ', 'я'.repeat(4096)]) assert.deepEqual(check(text), [text]);
  assert.deepEqual(check('я'.repeat(4097)).map(p => p.length), [4096, 1]);
});
test('formatter: paragraph, sentence, word then grapheme preference', () => {
  assert.equal(check('Ааа\r\n\r\nБбб. Ввв ггг ддд еее', 16)[0], 'Ааа\r\n\r\n');
  assert.equal(check('Раз. Два три четыре пять.', 14)[0], 'Раз. ');
  assert.equal(check('один два три четыре', 10)[0], 'один два ');
  assert.deepEqual(check('абвгдежзикл', 4), ['абвг', 'дежз', 'икл']);
});
test('formatter: full-input graphemes including ZWJ, modifiers, flags, keycap, combining marks', () => {
  for (const unit of ['👩🏽‍🚀', '👨‍👩‍👧‍👦', '🇷🇺', '1️⃣', 'е\u0301', '\r\n']) {
    const text = 'а'.repeat(4095) + unit + ' конец';
    const parts = check(text);
    assert.ok(!parts.some(p => p.endsWith('\ud83d')));
    assert.ok(parts.length > 1);
  }
  assert.equal(hasSafePartBoundaries('е\u0301', ['е', '\u0301']), false);
  assert.equal(hasSafePartBoundaries('🇷🇺', ['🇷', '🇺']), false);
});
test('formatter: whitespace remains exact and cannot create empty posts', () => {
  for (const text of ['а\n\n' + ' '.repeat(4094) + 'б', ' '.repeat(4095) + 'а б', 'а б' + ' '.repeat(4095), 'а\r\n\r\nб\t\tв\n']) check(text);
  assert.throws(() => splitStoryText('а' + ' '.repeat(4096)), /TEXT_CANNOT_SPLIT/);
  assert.throws(() => splitStoryText(' '.repeat(4096) + 'а'), /TEXT_CANNOT_SPLIT/);
});
test('formatter: reject invalid input/limit and an oversized indivisible grapheme', () => {
  for (const text of ['', ' \n ', '\ud800']) assert.throws(() => splitStoryText(text), /FORMAT_INVALID/);
  for (const limit of [0, 4097, NaN, 2.5]) assert.throws(() => splitStoryText('abc', limit), /FORMAT_INVALID/);
  assert.throws(() => splitStoryText('x\n' + 'е' + '\u0301'.repeat(4096)), /TEXT_GRAPHEME_TOO_LONG/);
  assert.deepEqual(check('е' + '\u0301'.repeat(4095)), ['е' + '\u0301'.repeat(4095)]);
});
test('formatter + Publisher: real split is sequential; uncertain second send stops without retry', async () => {
  const text = ('Сказка <&> 🐻. ' + 'а'.repeat(2300) + '\n\n').repeat(5);
  const expected = check(text);
  for (const failure of [false, true]) {
    const sent: string[] = []; let active = 0;
    const publisher = new Publisher({ channelId: '-1001234', readiness: () => ({ publishEnabled: true, telegramReady: true }), sender: {
      async send(_channel, part) { assert.equal(active++, 0); sent.push(part); await Promise.resolve(); active--;
        return failure && sent.length === 2 ? { kind: 'unknown' } : { kind: 'confirmed', message_id: sent.length }; },
    } });
    const input = { text, story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: publisher.instanceId };
    const result = await publisher.publish(input);
    assert.equal(result.status, failure ? 'UNKNOWN' : 'PUBLISHED');
    assert.deepEqual(sent, failure ? expected.slice(0, 2) : expected);
    assert.equal(result.remaining_parts, failure ? expected.length - 2 : 0);
    assert.deepEqual(result.confirmed_messages.map(m => m.part_index), failure ? [1] : expected.map((_, i) => i + 1));
    assert.deepEqual(await publisher.publish(input), result);
    assert.deepEqual(await publisher.publish({ ...input, attempt_id: randomUUID() }), result);
    assert.equal(sent.length, failure ? 2 : expected.length);
  }
});
test('formatter + Publisher: invalid final cluster and unsafe injected cuts send nothing', async () => {
  let calls = 0;
  const options = { channelId: '-1001234', readiness: () => ({ publishEnabled: true, telegramReady: true }), sender: { async send() { calls++; return { kind: 'confirmed', message_id: 1 }; } } };
  for (const [text, format] of [[('Обычный абзац.\n').repeat(500) + 'е' + '\u0301'.repeat(4096), undefined], ['е\u0301', () => ['е', '\u0301']]] as const) {
    const publisher = new Publisher({ ...options, format });
    const result = await publisher.publish({ text, story_id: randomUUID(), attempt_id: randomUUID(), expected_instance_id: publisher.instanceId });
    assert.equal(result.status, 'REJECTED');
    assert.equal(calls, 0);
  }
});

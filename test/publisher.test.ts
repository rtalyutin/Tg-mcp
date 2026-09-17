import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Publisher, publishResultSchema, MAX_TEXT_BYTES } from '../src/publisher.ts';
import type { DeliveryOutcome, PublisherOptions } from '../src/publisher.ts';

function fixture(outcomes: Array<DeliveryOutcome | Error | unknown> = [], overrides: Partial<PublisherOptions> = {}) {
  const calls: Array<{ channel: string; text: string }> = [];
  const publisher = new Publisher({ channelId: '-1001234', readiness: () => ({ publishEnabled: true, telegramReady: true }),
    sender: { async send(channel, text) { calls.push({ channel, text }); const x = outcomes.shift(); if (x instanceof Error) throw x; return x ?? { kind: 'confirmed', message_id: calls.length }; } }, ...overrides });
  const input = (text = 'Сказка', story = 'story-1') => ({ text, story_id: story, attempt_id: randomUUID(), expected_instance_id: publisher.instanceId });
  return { publisher, calls, input };
}
test('success and replay preserve exact text/channel and return detached schema-valid results', async () => {
  const f = fixture(); const data = f.input();
  const result = await f.publisher.publish(data);
  publishResultSchema.parse(result); assert.equal(result.status, 'PUBLISHED');
  result.confirmed_messages[0].message_id = 999;
  const repeat = await f.publisher.publish(data);
  assert.equal(repeat.confirmed_messages[0].message_id, 1);
  assert.equal(repeat.automatic_retry_allowed, false);
  assert.deepEqual(f.calls, [{ channel: '-1001234', text: data.text }]);
});
test('canonical story dedup, conflicting content and attempt-story bindings', async () => {
  const f = fixture(); const data = f.input(); await f.publisher.publish(data);
  assert.equal((await f.publisher.publish({ ...data, attempt_id: randomUUID() })).attempt_id, data.attempt_id);
  assert.equal((await f.publisher.publish({ ...data, text: 'Другая' })).code, 'ATTEMPT_CONFLICT');
  assert.equal((await f.publisher.publish({ ...data, story_id: 'other' })).code, 'ATTEMPT_CONFLICT');
  assert.equal((await f.publisher.publish({ ...data, attempt_id: randomUUID(), text: 'Другая' })).code, 'STORY_CONFLICT');
  assert.equal(f.calls.length, 1);
});
test('replay success survives disablement, loss of readiness and full registry', async () => {
  let ready = true;
  const f = fixture([], { maxAttempts: 1, readiness: () => ({ publishEnabled: ready, telegramReady: ready }) });
  const data = f.input(); await f.publisher.publish(data); ready = false;
  assert.equal((await f.publisher.publish(data)).status, 'PUBLISHED');
  assert.equal((await f.publisher.publish(f.input('new', 'new'))).code, 'PUBLISH_DISABLED');
  ready = true;
  assert.equal((await f.publisher.publish(f.input('new', 'new'))).code, 'REGISTRY_FULL');
  assert.equal(f.publisher.getAttemptStatus({ attempt_id: data.attempt_id, expected_instance_id: data.expected_instance_id }).status, 'PUBLISHED');
});
test('lost registry and stale instance are UNKNOWN, never proof of non-publication', async () => {
  const old = fixture(); const data = old.input(); await old.publisher.publish(data);
  const fresh = fixture();
  const stale = await fresh.publisher.publish(data);
  assert.equal(stale.code, 'INSTANCE_CHANGED'); assert.equal(stale.status, 'UNKNOWN');
  assert.equal(stale.remaining_parts, null); assert.equal(stale.manual_check_required, true);
  assert.equal(fresh.calls.length, 0);
  const missing = fresh.publisher.getAttemptStatus({ attempt_id: data.attempt_id, expected_instance_id: fresh.publisher.instanceId });
  assert.equal(missing.code, 'ATTEMPT_NOT_KNOWN'); assert.equal(missing.story_id, null);
});
test('atomic registration: in-flight replay reads state; other stories are BUSY', async () => {
  let release!: (value: unknown) => void;
  let calls = 0;
  const f = fixture([], { sender: { send() { calls++; return new Promise(resolve => { release = resolve; }); } } });
  const data = f.input(); const pending = f.publisher.publish(data);
  assert.equal((await f.publisher.publish(data)).status, 'IN_PROGRESS');
  assert.equal((await f.publisher.publish({ ...data, attempt_id: randomUUID() })).attempt_id, data.attempt_id);
  assert.equal((await f.publisher.publish(f.input('other', 'other'))).code, 'BUSY');
  release({ kind: 'confirmed', message_id: 1 }); assert.equal((await pending).status, 'PUBLISHED'); assert.equal(calls, 1);
});
test('multipart: sequential success, partial rejection, unknown and zero automatic retries', async () => {
  for (const middle of [{ kind: 'confirmed', message_id: 2 }, { kind: 'rejected', code: 'RATE_LIMITED' }, { kind: 'unknown' }, new Error('timeout'), { ok: true }, { kind: 'confirmed', message_id: -1 }]) {
    const f = fixture([{ kind: 'confirmed', message_id: 1 }, middle], { format: () => ['А', 'Б', 'В'] });
    const data = f.input('АБВ'); const result = await f.publisher.publish(data); publishResultSchema.parse(result);
    const success = !(middle instanceof Error) && middle.kind === 'confirmed' && middle.message_id === 2;
    assert.equal(f.calls.length, success ? 3 : 2);
    assert.equal(result.status, success ? 'PUBLISHED' : !(middle instanceof Error) && middle.kind === 'rejected' ? 'PARTIAL' : 'UNKNOWN');
    assert.equal(result.remaining_parts, success ? 0 : 1);
    if (result.status === 'UNKNOWN') assert.equal(result.uncertain_part_index, 2);
    await f.publisher.publish(data); await f.publisher.publish({ ...data, attempt_id: randomUUID() });
    assert.equal(f.calls.length, success ? 3 : 2);
  }
});
test('first-part definitive rejection is retained; readiness fail-closed', async () => {
  const f = fixture([{ kind: 'rejected', code: 'BOT_FORBIDDEN' }]); const data = f.input();
  assert.equal((await f.publisher.publish(data)).status, 'REJECTED');
  await f.publisher.publish(data); assert.equal(f.calls.length, 1);
  const disabled = new Publisher({ channelId: '-1001234', sender: { async send() { throw new Error('must not call'); } } });
  assert.equal((await disabled.publish({ ...data, expected_instance_id: disabled.instanceId })).code, 'PUBLISH_DISABLED');
});
test('structural input and full formatted package validation precede all sends', async () => {
  const f = fixture();
  for (const patch of [{ chat_id: '-1009999' }, { text: '' }, { text: '\ud800' }, { text: 'x'.repeat(MAX_TEXT_BYTES + 1) }, { attempt_id: 'bad' }]) {
    await assert.rejects(f.publisher.publish({ ...f.input(), ...patch }));
  }
  assert.equal((await f.publisher.publish(f.input('а' + '\u0301'.repeat(4096)))).code, 'TEXT_GRAPHEME_TOO_LONG');
  assert.equal(f.calls.length, 0);
  for (const format of [() => ['А', 'x'.repeat(4097)], () => ['А', ''], () => ['edited'], () => []]) {
    const invalid = fixture([], { format });
    assert.equal((await invalid.publisher.publish(invalid.input('АБ'))).code, 'FORMAT_INVALID');
    assert.equal(invalid.calls.length, 0);
  }
});

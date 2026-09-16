import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Publisher, publishResultSchema } from '../src/publisher.ts';
import type { PublisherOptions } from '../src/publisher.ts';

const open = () => ({ publishEnabled: true, telegramReady: true });
const request = (p: Publisher, text = 'АБВ', story_id = randomUUID()) => ({ story_id, text, attempt_id: randomUUID(), expected_instance_id: p.instanceId });
function deferred() { let resolve!: (x: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; }

test('QA core: observable registration precedes sender, held send dedups and blocks another story', async () => {
  const hold = deferred(); const observed: string[] = []; let input: ReturnType<typeof request>;
  let competing: ReturnType<Publisher['publish']>;
  const p = new Publisher({ channelId: '-100777', readiness: open, sender: { send() {
    observed.push(p.getAttemptStatus({ attempt_id: input.attempt_id, expected_instance_id: p.instanceId }).status);
    competing = p.publish(request(p, 'other'));
    return hold.promise;
  } } });
  input = request(p);
  const pending = p.publish(input);
  assert.deepEqual(observed, ['IN_PROGRESS']);
  assert.equal((await competing!).code, 'BUSY');
  const reads = await Promise.all(Array.from({ length: 25 }, (_, n) => p.publish(n % 2 ? input : { ...input, attempt_id: randomUUID() })));
  for (const r of reads) { assert.equal(r.status, 'IN_PROGRESS'); assert.equal(r.attempt_id, input.attempt_id); assert.equal(r.automatic_retry_allowed, false); }
  assert.equal(observed.length, 1);
  reads[0].confirmed_messages.push({ part_index: 1, message_id: 900, message_url: null });
  hold.resolve({ kind: 'confirmed', message_id: 7 });
  const result = await pending;
  assert.deepEqual(result.confirmed_messages.map(x => x.message_id), [7]);
  assert.equal(result.status, 'PUBLISHED');
});

test('QA core: full registry never evicts; disabling and throwing readiness cannot overwrite replay', async () => {
  let fail = false; let calls = 0;
  const p = new Publisher({ channelId: '-100777', maxAttempts: 1, readiness: () => { if (fail) throw Error('offline'); return open(); }, sender: { async send() { calls++; return { kind: 'confirmed', message_id: 1 }; } } });
  const input = request(p); const result = await p.publish(input);
  assert.equal((await p.publish(request(p))).code, 'REGISTRY_FULL');
  fail = true;
  assert.deepEqual(await p.publish(input), result);
  assert.deepEqual(await p.publish({ ...input, attempt_id: randomUUID() }), result);
  assert.equal((await p.publish(request(p))).code, 'READINESS_FAILED');
  assert.equal((await p.publish({ ...input, text: 'АБВ ' })).code, 'ATTEMPT_CONFLICT');
  assert.equal((await p.publish({ ...input, text: 'АБВ ', attempt_id: randomUUID() })).code, 'STORY_CONFLICT');
  assert.equal(calls, 1);
});

test('QA core: results and status snapshots cannot mutate the retained registry', async () => {
  const p = new Publisher({ channelId: '-100777', readiness: open, sender: { async send() { return { kind: 'confirmed', message_id: 1 }; } } });
  const input = request(p); const good = await p.publish(input);
  const statusInput = { attempt_id: input.attempt_id, expected_instance_id: p.instanceId };
  const snapshot = p.getAttemptStatus(statusInput);
  snapshot.confirmed_messages[0].message_id = 999;
  snapshot.status = 'UNKNOWN'; snapshot.code = 'changed'; snapshot.confirmed_messages.length = 0;
  assert.deepEqual(p.getAttemptStatus(statusInput), good);
  good.confirmed_messages.push({ part_index: 99, message_id: 42, message_url: null });
  assert.equal((await p.publish(input)).confirmed_messages.length, 1);
});

test('QA core: delivery outcome matrix stops immediately and never replays a side effect', async () => {
  for (const firstCount of [0, 1]) for (const ending of [
    { kind: 'rejected', code: 'RATE_LIMITED' }, { kind: 'unknown' }, new Error('transport'),
    { kind: 'confirmed', message_id: 0 }, { kind: 'confirmed', message_id: 2, secret: 'extra' }, { status: 502 },
  ]) {
    const sent: string[] = [];
    const p = new Publisher({ channelId: '-100777', readiness: open, format: () => ['А', 'Б', 'В'], sender: { async send(_channel, text) {
      sent.push(text); if (sent.length <= firstCount) return { kind: 'confirmed', message_id: sent.length };
      if (ending instanceof Error) throw ending; return ending;
    } } });
    const input = request(p); const result = await p.publish(input); publishResultSchema.parse(result);
    const rejected = !(ending instanceof Error) && ending.kind === 'rejected';
    assert.equal(result.status, rejected ? firstCount ? 'PARTIAL' : 'REJECTED' : 'UNKNOWN');
    assert.equal(result.confirmed_messages.length, firstCount);
    assert.equal(result.uncertain_part_index, rejected ? null : firstCount + 1);
    assert.equal(result.remaining_parts, 2 - firstCount);
    assert.equal(result.manual_check_required, !rejected || firstCount > 0);
    assert.equal(result.automatic_retry_allowed, false);
    await p.publish(input); await p.publish({ ...input, attempt_id: randomUUID() });
    assert.equal(sent.length, firstCount + 1);
  }
});

test('QA core: stale instance and unknown attempts preserve uncertainty without sending', async () => {
  let calls = 0;
  const p = new Publisher({ channelId: '-100777', readiness: open, sender: { async send() { calls++; return { kind: 'confirmed', message_id: 1 }; } } });
  const input = request(p); input.expected_instance_id = randomUUID();
  for (const r of [await p.publish(input), p.getAttemptStatus({ attempt_id: input.attempt_id, expected_instance_id: input.expected_instance_id }), p.getAttemptStatus({ attempt_id: randomUUID(), expected_instance_id: p.instanceId })]) {
    assert.equal(r.status, 'UNKNOWN'); assert.equal(r.instance_id, p.instanceId);
    assert.equal(r.remaining_parts, null); assert.equal(r.manual_check_required, true); assert.equal(r.automatic_retry_allowed, false);
  }
  assert.equal(calls, 0);
});

test('QA core: validate the entire formatted package before first mock send', async () => {
  for (const parts of [['А', 'Б'.repeat(4097)], ['А', '\ud800'], ['А', ''], ['А', ' '], ['А', 'different'], []]) {
    let calls = 0;
    const p = new Publisher({ channelId: '-100777', readiness: open, format: () => parts, sender: { async send() { calls++; return { kind: 'confirmed', message_id: 1 }; } } });
    const input = request(p, 'АБ');
    const r = await p.publish(input); assert.equal(r.status, 'REJECTED');
    assert.equal(calls, 0);
  }
});

test('QA core: injected part array, caller input and options cannot redirect pending delivery', async () => {
  const hold = deferred(); const parts = ['А', 'Б', 'В']; const sent: Array<[string, string]> = [];
  const options: PublisherOptions = { channelId: '-100777', readiness: open, format: () => parts, sender: { send(channel, text) {
    sent.push([channel, text]); return sent.length === 1 ? hold.promise : Promise.resolve({ kind: 'confirmed', message_id: sent.length });
  } } };
  const p = new Publisher(options); const input = request(p); const pending = p.publish(input);
  options.channelId = '-100888'; input.text = 'replacement'; parts.splice(0, 3, 'malicious');
  hold.resolve({ kind: 'confirmed', message_id: 1 });
  assert.equal((await pending).status, 'PUBLISHED');
  assert.deepEqual(sent, [['-100777', 'А'], ['-100777', 'Б'], ['-100777', 'В']]);
});

test('QA core: mutating sender injection after construction cannot replace subsequent part delivery', async () => {
  const hold = deferred(); const original: string[] = []; const replacement: string[] = [];
  const sender = { send(_channel: string, text: string): Promise<unknown> {
    original.push(text); return original.length === 1 ? hold.promise : Promise.resolve({ kind: 'confirmed', message_id: original.length });
  } };
  const p = new Publisher({ channelId: '-100777', readiness: open, format: () => ['А', 'Б', 'В'], sender });
  const pending = p.publish(request(p));
  sender.send = async (_channel, text) => { replacement.push(text); return { kind: 'confirmed', message_id: 99 }; };
  hold.resolve({ kind: 'confirmed', message_id: 1 }); await pending;
  assert.deepEqual(replacement, []);
  assert.deepEqual(original, ['А', 'Б', 'В']);
});

test('QA core: unexpected exception while interpreting delivery becomes terminal UNKNOWN', async () => {
  let calls = 0;
  const malformed = { get kind(): string { throw new Error('bad adapter getter'); } };
  const p = new Publisher({ channelId: '-100777', readiness: open, format: () => ['А', 'Б', 'В'], sender: { async send() { calls++; return malformed; } } });
  const input = request(p);
  const result = await p.publish(input);
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.uncertain_part_index, 1);
  assert.equal(result.remaining_parts, 2); assert.equal(result.manual_check_required, true);
  assert.equal(p.getAttemptStatus({ attempt_id: input.attempt_id, expected_instance_id: p.instanceId }).status, 'UNKNOWN');
  await p.publish(input); assert.equal(calls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { AdmissionQueue, admissionQueueLimits } from '../src/outreach/admission-queue.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const allowed = { allowed: true, retryAfter: 0 };
const signal = () => new AbortController().signal;

test('queue: four pending per IP, FIFO, other IP independent, slots reused', async () => {
  const gate = deferred<typeof allowed>(); let calls = 0;
  const queue = new AdmissionQueue(async ip => { if (ip === 'a' && ++calls === 1) return gate.promise; return allowed; });
  const order: number[] = [];
  const waiting = Array.from({ length: 4 }, (_, i) => queue.acquire('a', signal()).then(outcome => { order.push(i); return outcome; }));
  assert.equal(await queue.acquire('a', signal()), 'limited');
  assert.equal(await queue.acquire('b', signal()), 'admitted');
  gate.resolve(allowed);
  assert.deepEqual(await Promise.all(waiting), ['admitted', 'admitted', 'admitted', 'admitted']);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(await queue.acquire('a', signal()), 'admitted');
  queue.close(); await queue.drained();
});

test('queue: 64 total, abort storms cannot release in-flight SQL capacity early', async () => {
  assert.deepEqual(admissionQueueLimits, { perIp: 4, total: 64, waitMs: 5000 });
  const gate = deferred<typeof allowed>(); let calls = 0;
  const queue = new AdmissionQueue(async () => { calls++; return gate.promise; });
  const cancel = new AbortController();
  const pending = Array.from({ length: 64 }, (_, i) => queue.acquire(String(i), cancel.signal));
  await Promise.resolve(); assert.equal(calls, 64);
  assert.equal(await queue.acquire('overflow', signal()), 'limited');
  cancel.abort();
  assert.ok((await Promise.all(pending)).every(result => result === 'cancelled'));
  assert.equal(await queue.acquire('still-busy', signal()), 'limited');
  gate.resolve(allowed); await queue.drained();
  assert.equal(await queue.acquire('recovered', signal()), 'admitted');
  queue.close();
});

test('queue: retries shared gate only after its delay, never bypasses denial', async () => {
  const times: number[] = [];
  const queue = new AdmissionQueue(async () => { times.push(performance.now()); return times.length === 1 ? { allowed: false, retryAfter: 1 } : allowed; });
  assert.equal(await queue.acquire('a', signal()), 'admitted');
  assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 990);
  queue.close();
});

test('queue: deadline returns at five seconds even with stalled SQL; no late admission', async () => {
  const gate = deferred<typeof allowed>(); let calls = 0;
  const queue = new AdmissionQueue(async () => { calls++; return gate.promise; });
  const started = performance.now();
  const pending = Array.from({ length: 4 }, () => queue.acquire('a', signal()));
  assert.deepEqual(await Promise.all(pending), ['limited', 'limited', 'limited', 'limited']);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4990 && elapsed < 6000, `deadline ${elapsed}ms`);
  assert.equal(calls, 1);
  assert.equal(await queue.acquire('a', signal()), 'limited');
  gate.resolve(allowed); await queue.drained();
  assert.equal(calls, 1, 'expired followers must never reach the database');
  queue.close();
});

test('queue: cancellation skips queued work; shutdown cancels waits and rejects new arrivals', async () => {
  const gate = deferred<typeof allowed>(); let calls = 0;
  const queue = new AdmissionQueue(async () => { calls++; return gate.promise; });
  const first = queue.acquire('a', signal());
  const cancel = new AbortController();
  const second = queue.acquire('a', cancel.signal);
  cancel.abort(); assert.equal(await second, 'cancelled');
  queue.close(); assert.equal(await first, 'closed');
  assert.equal(await queue.acquire('new', signal()), 'closed');
  gate.resolve(allowed); await queue.drained();
  assert.equal(calls, 1);
});

test('queue: database failures reject safely and free capacity; aborted input performs no work', async () => {
  let fail = true; let calls = 0;
  const queue = new AdmissionQueue(async () => { calls++; if (fail) throw new Error('synthetic DB failure'); return allowed; });
  const cancel = new AbortController(); cancel.abort();
  assert.equal(await queue.acquire('a', cancel.signal), 'cancelled'); assert.equal(calls, 0);
  await assert.rejects(queue.acquire('a', signal()), /synthetic DB failure/);
  fail = false; assert.equal(await queue.acquire('a', signal()), 'admitted');
  queue.close(); await queue.drained();
});

test('queue: abort while retry timer waits prevents another database attempt', async () => {
  let calls = 0;
  const queue = new AdmissionQueue(async () => { calls++; return { allowed: false, retryAfter: 1 }; });
  const cancel = new AbortController(); const pending = queue.acquire('a', cancel.signal);
  await sleep(20); cancel.abort(); assert.equal(await pending, 'cancelled');
  await queue.drained(); assert.equal(calls, 1); queue.close();
});

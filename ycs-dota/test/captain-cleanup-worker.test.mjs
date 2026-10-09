import test from 'node:test';
import assert from 'node:assert/strict';
import { startCaptainCleanupWorker, CAPTAIN_CLEANUP_INTERVAL_MS } from '../backend/captain-cleanup-worker.mjs';

test('cleanup runs on startup, never overlaps, retries failure on60s and stops gracefully', async () => {
  let calls = 0, release, scheduled, delay, cleared = 0, fail = false;
  const worker = startCaptainCleanupWorker({ enabled: true, now: () => 123,
    service: { async cleanup() { calls++; if (fail) throw new Error('private body must not leak'); await new Promise((resolve) => { release = resolve; }); } },
    setTimer: (fn, ms) => { scheduled = fn; delay = ms; return { unref() {} }; }, clearTimer: () => { cleared++; } });
  await Promise.resolve(); assert.equal(calls, 1);
  const same = worker.run(); await Promise.resolve(); assert.equal(calls, 1);
  release(); await same; assert.equal(worker.state.status, 'idle'); assert.equal(delay, CAPTAIN_CLEANUP_INTERVAL_MS);
  fail = true; scheduled(); await worker.run();
  assert.equal(calls, 2); assert.equal(worker.state.status, 'degraded'); assert.equal(worker.state.error, 'cleanup_unavailable');
  assert.ok(!JSON.stringify(worker.state).includes('private body'));
  fail = false; scheduled(); await Promise.resolve(); assert.equal(calls, 3);
  let stopped = false; const stopping = worker.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release(); await stopping; assert.equal(worker.state.status, 'stopped'); assert.ok(cleared > 0);
  await worker.run(); assert.equal(calls, 3);
});

test('unconfigured cleanup stays disabled and does not call sources or schedule retries', async () => {
  let calls = 0;
  const worker = startCaptainCleanupWorker({ env: {}, service: { cleanup() { calls++; } }, setTimer() { calls++; } });
  await worker.run(); assert.equal(calls, 0); assert.equal(worker.state.status, 'disabled'); await worker.stop();
});

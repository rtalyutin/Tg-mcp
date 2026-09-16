import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Publisher } from '../src/publisher.ts';

if (!global.gc) throw new Error('Run with node --expose-gc');
const text = 'А'.repeat(4096) + 'Б'.repeat(4096) + 'В'.repeat(4096);
let sends = 0;
const core = new Publisher({ channelId: '-1001234', maxAttempts: 1000,
  readiness: () => ({ publishEnabled: true, telegramReady: true }),
  format: value => [value.slice(0, 4096), value.slice(4096, 8192), value.slice(8192)],
  sender: { async send() { return { kind: 'confirmed', message_id: ++sends }; } },
});
global.gc(); const baseline = process.memoryUsage().heapUsed; const start = performance.now();
const first = { text, story_id: 'capacity-0', attempt_id: randomUUID(), expected_instance_id: core.instanceId };
for (let i = 0; i < 1000; i++) {
  const result = await core.publish(i === 0 ? first : { ...first, story_id: `capacity-${i}`, attempt_id: randomUUID() });
  assert.equal(result.status, 'PUBLISHED');
}
assert.equal((await core.publish({ ...first, story_id: 'overflow', attempt_id: randomUUID() })).code, 'REGISTRY_FULL');
assert.equal((await core.publish(first)).status, 'PUBLISHED');
assert.equal(sends, 3000);
global.gc();
const report = { date: '2026-09-16', node: process.version, attempts: 1000, partsPerAttempt: 3,
  mockCalls: sends, overflow: 'REGISTRY_FULL', oldestReplay: 'PUBLISHED_WITHOUT_RESEND',
  elapsedMs: Math.round(performance.now() - start), retainedHeapDeltaBytes: process.memoryUsage().heapUsed - baseline,
  scope: 'Synthetic local mock, no network; not worst-case memory, throughput SLA or Telegram rate limits' };
mkdirSync(new URL('../verification/', import.meta.url), { recursive: true });
writeFileSync(new URL('../verification/core-capacity.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

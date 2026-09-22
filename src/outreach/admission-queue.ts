import { setTimeout as delay } from 'node:timers/promises';

export const admissionQueueLimits = Object.freeze({ perIp: 4, total: 64, waitMs: 5_000 });
export type AdmissionOutcome = 'admitted' | 'limited' | 'cancelled' | 'closed';
type Attempt = (ip: string) => Promise<{ allowed: boolean; retryAfter: number }>;
type Lane = { pending: number; tail: Promise<void> };

/** Bounded, process-local FIFO. Only the shared PostgreSQL gate grants admission.
 * No DB connection is held during a timer. Authentication/business work happens
 * after admission, never inside a queued closure. Requests are not replayed.
 */
export class AdmissionQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly shutdown = new AbortController();
  private pending = 0;
  private readonly attempt: Attempt;

  constructor(attempt: Attempt) { this.attempt = attempt; }

  async acquire(ip: string, requestSignal: AbortSignal): Promise<AdmissionOutcome> {
    if (requestSignal.aborted) return 'cancelled';
    if (this.shutdown.signal.aborted) return 'closed';
    let lane = this.lanes.get(ip);
    if (this.pending >= admissionQueueLimits.total || (lane?.pending ?? 0) >= admissionQueueLimits.perIp) return 'limited';
    if (!lane) { lane = { pending: 0, tail: Promise.resolve() }; this.lanes.set(ip, lane); }
    const current = lane;
    current.pending++; this.pending++;
    const deadline = performance.now() + admissionQueueLimits.waitMs;
    const expiry = new AbortController();
    const signal = AbortSignal.any([requestSignal, this.shutdown.signal, expiry.signal]);
    const interrupted = (): AdmissionOutcome | undefined => {
      if (requestSignal.aborted) return 'cancelled';
      if (this.shutdown.signal.aborted) return 'closed';
      if (expiry.signal.aborted || performance.now() >= deadline) return 'limited';
      return undefined;
    };
    const timer = setTimeout(() => expiry.abort(), admissionQueueLimits.waitMs);
    const work = current.tail.then(async (): Promise<AdmissionOutcome> => {
      while (true) {
        const before = interrupted(); if (before) return before;
        const result = await this.attempt(ip);
        // A slow DB reply must never revive a disconnected/expired request.
        const after = interrupted(); if (after) return after;
        if (result.allowed) return 'admitted';
        try { await delay(Math.max(1, result.retryAfter) * 1000, undefined, { signal }); }
        catch { return interrupted() ?? 'limited'; }
      }
    }).finally(() => {
      current.pending--; this.pending--;
      if (current.pending === 0) this.lanes.delete(ip);
    });
    current.tail = work.then(() => {}, () => {});
    // Return promptly on timeout/abort, but keep its slot until in-flight SQL
    // settles. Otherwise repeated aborts could create unbounded orphan queries.
    let onAbort: () => void = () => {};
    const abort = new Promise<AdmissionOutcome>(resolve => {
      onAbort = () => resolve(interrupted() ?? 'cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([work, abort]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }

  close(): void { this.shutdown.abort(); }
  async drained(): Promise<void> { await Promise.all([...this.lanes.values()].map(lane => lane.tail)); }
}

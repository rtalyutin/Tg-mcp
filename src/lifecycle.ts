import type { TelegramReadiness } from './telegram.ts';

const unavailable = (): TelegramReadiness => ({ ready: false, code: 'TELEGRAM_NOT_READY' });

/** No completed-result cache. Concurrent read checks share a bounded in-flight request. */
export class ReadinessGate {
  #check: () => Promise<TelegramReadiness>;
  #pending?: Promise<TelegramReadiness>;
  #pendingGeneration = 0;
  #snapshot: TelegramReadiness = unavailable();
  #generation = 0;
  #stopped = false;
  constructor(check: () => Promise<TelegramReadiness>) { this.#check = check; }
  get snapshot(): TelegramReadiness { return { ...this.#snapshot }; }
  invalidate(): void { this.#generation++; this.#snapshot = unavailable(); }
  stop(): void { this.#stopped = true; this.invalidate(); }
  refresh(): Promise<TelegramReadiness> {
    if (this.#stopped) return Promise.resolve(unavailable());
    if (!this.#pending) {
      const generation = this.#generation;
      this.#pendingGeneration = generation;
      this.#snapshot = unavailable();
      this.#pending = Promise.resolve().then(() => this.#check()).then(result => {
        if (this.#stopped || generation !== this.#generation) return unavailable();
        this.#snapshot = { ...result };
        return this.#snapshot;
      }).catch(() => { this.#snapshot = unavailable(); return unavailable(); }).finally(() => { this.#pending = undefined; });
    }
    // Each caller owns its result; no mutable snapshot leaks between waiters.
    const generation = this.#pendingGeneration;
    return this.#pending.then(result => this.#stopped || generation !== this.#generation ? unavailable() : { ...result });
  }
}

/** Compose explicitly at an entrypoint; never exits early or aborts a Telegram send. */
export function installShutdownHandlers(close: () => Promise<void>): () => void {
  let closing = false;
  const handler = () => {
    if (closing) return;
    closing = true;
    try { void close().catch(() => { process.exitCode = 1; }); }
    catch { process.exitCode = 1; }
  };
  process.on('SIGTERM', handler); process.on('SIGINT', handler);
  return () => { process.off('SIGTERM', handler); process.off('SIGINT', handler); };
}

export const CAPTAIN_CLEANUP_INTERVAL_MS = 60_000;

// Uses the HTTP service's same authenticated storage/catalog boundary. No
// request bodies, message text, identifiers or exception payloads are logged.
export function startCaptainCleanupWorker({ service, env = process.env, now = Date.now,
  enabled = /^[a-fA-F0-9]{64}$/.test(env.YCS_CAPTAIN_ENCRYPTION_KEY || '') && /^[1-9]\d{0,19}$/.test(env.YCS_CAPTAIN_BOT_ID || ''),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const state = { status: enabled ? 'starting' : 'disabled', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null };
  let stopped = false, timer, pending;
  const schedule = () => {
    if (stopped || !enabled) return;
    clearTimer(timer);
    timer = setTimer(() => { void run(); }, CAPTAIN_CLEANUP_INTERVAL_MS);
    timer.unref?.();
  };
  const run = () => {
    if (stopped || !enabled) return Promise.resolve();
    if (pending) return pending;
    clearTimer(timer);
    state.status = 'running'; state.attempts++; state.lastAttemptAt = now();
    pending = Promise.resolve().then(() => service.cleanup()).then(() => {
      state.lastSuccessAt = now(); state.error = null; state.status = 'idle';
    }, () => {
      state.error = 'cleanup_unavailable'; state.status = 'degraded';
    }).finally(() => { pending = null; if (!stopped) schedule(); });
    return pending;
  };
  if (enabled) void run();
  return { state, run, async stop() {
    stopped = true; clearTimer(timer);
    if (pending) await pending;
    state.status = 'stopped';
  } };
}

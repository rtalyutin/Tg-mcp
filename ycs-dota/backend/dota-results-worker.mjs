import { run } from "./dota-results-import.mjs";
import { isPollWindow } from "../src/lib/dota-import.js";
import tournament from "../src/data/tournaments/dota2-autumn-2026.json" with { type: "json" };

const failureNames = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket',
  'PreconditionFailed', 'InvalidRequest', 'NotImplemented', 'ServiceUnavailable', 'SlowDown',
  'RequestTimeout', 'TimeoutError', 'AbortError']);
const failurePhases = new Set(['read_cache', 'read_mvp', 'read_results', 'confirm_results', 'publish_confirmed_results',
  'collect_mvp', 'publish_mvp', 'publish_mvp_cache', 'build_mvp', 'publish_mvp_snapshot', 'collect_results', 'publish_results']);
function importFailure(error) {
  // Only fixed diagnostic codes escape; provider messages can contain private data.
  let code = failureNames.has(error.name) ? error.name : 'ImportFailed';
  if (code === 'ImportFailed') {
    if (/^Concurrent S3 revision/.test(error.message)) code = 'ConcurrentRevision';
    else if (/^S3 readback differs/.test(error.message)) code = 'ReadbackMismatch';
    else if (/MVP|estimated map|estimation baseline/.test(error.message)) code = 'InvalidMvpData';
  }
  return { code, phase: failurePhases.has(error.importPhase) ? error.importPhase : null,
    httpStatus: Number.isInteger(error.$metadata?.httpStatusCode) && error.$metadata.httpStatusCode >= 400 &&
      error.$metadata.httpStatusCode <= 599 ? error.$metadata.httpStatusCode : null };
}

// One backend writer process. Schedule the next check only after the
// current one finishes, so a slow API/S3 call cannot create overlapping runs.
export function startResultsWorker({ runOnce = run, now = () => new Date(),
  env = process.env, intervalMs = 5 * 60_000, setTimer = setTimeout,
  clearTimer = clearTimeout, logger = console } = {}) {
  let timer;
  let stopped = env.YCS_DOTA_RESULTS_IMPORT_ENABLED === "false";
  let active;
  let pendingRestored = false;
  let pendingMaps = 0;
  let retryNeeded = false;
  let knownMatchIds = [];
  const controller = new AbortController();
  const state = { status: stopped ? "disabled" : "waiting", lastAttemptAt: null, lastSuccessAt: null, pendingMaps: 0, lastFailure: null };

  async function check() {
    if (stopped) return;
    const at = now();
    const inTournament = isPollWindow(at, tournament);
    const afterTournament = at.getTime() >= Date.parse(`${tournament.dates.end}T00:00:00+03:00`) + 24 * 60 * 60_000;
    const canRestore = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    // Read the pending cache once after a restart, then continue only while it
    // contains unresolved maps. New league discovery stops at the published end.
    if (inTournament || (afterTournament && (pendingMaps > 0 || retryNeeded || (!pendingRestored && canRestore)))) {
      state.status = "running";
      state.lastAttemptAt = at.toISOString();
      try {
        const result = await runOnce({ now: at, env, signal: controller.signal, pendingOnly: !inTournament, knownMatchIds });
        pendingMaps = result?.pendingMaps || 0;
        retryNeeded = false;
        knownMatchIds = [];
        state.pendingMaps = pendingMaps;
        pendingRestored = true;
        state.status = "waiting";
        state.lastSuccessAt = now().toISOString();
        state.lastFailure = null;
      } catch (error) {
        if (Array.isArray(error.retryMatchIds) && error.retryMatchIds.every((id) => /^[1-9]\d*$/.test(String(id)))) {
          knownMatchIds = [...new Set([...knownMatchIds, ...error.retryMatchIds.map(String)])];
        }
        if (Number.isSafeInteger(error.pendingMaps)) {
          pendingMaps = error.pendingMaps;
          state.pendingMaps = pendingMaps;
        }
        retryNeeded = true;
        state.status = "error";
        state.lastFailure = importFailure(error);
        if (!stopped) logger.error(`Dota results import failed: ${error.message}`);
      }
    }
    if (afterTournament && pendingMaps === 0 && !retryNeeded && (pendingRestored || !canRestore)) state.status = "complete";
    else if (!stopped) timer = setTimer(() => { active = check(); }, intervalMs);
  }

  if (!stopped) active = check();
  return {
    state,
    async stop() {
      stopped = true;
      clearTimer(timer);
      controller.abort();
      await active;
    },
  };
}

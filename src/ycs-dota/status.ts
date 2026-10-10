import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { YcsDotaRuntime } from './runtime.ts';
export type SafeStatusRoute = (request: IncomingMessage, response: ServerResponse) => boolean;
let manifest: {
  version: string; sourceRevision: string; packageFingerprint: string;
} | null = null;
try { manifest = JSON.parse(await readFile(new URL('../../ycs-dota/manifest.json', import.meta.url), 'utf8')); }
catch { /* Optional collector assets must not prevent the main gateway boot. */ }
const failureCodes = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket',
  'PreconditionFailed', 'InvalidRequest', 'NotImplemented', 'ServiceUnavailable', 'SlowDown',
  'RequestTimeout', 'TimeoutError', 'AbortError', 'ConcurrentRevision', 'ReadbackMismatch', 'InvalidMvpData', 'ImportFailed']);
const failurePhases = new Set(['read_cache', 'read_mvp', 'read_results', 'confirm_results', 'publish_confirmed_results',
  'collect_mvp', 'publish_mvp', 'publish_mvp_cache', 'build_mvp', 'publish_mvp_snapshot', 'collect_results', 'publish_results']);
function safeFailure(value: YcsDotaRuntime['state']['lastFailure']) {
  if (!value) return null;
  return { code: failureCodes.has(value.code) ? value.code : 'ImportFailed',
    phase: typeof value.phase === 'string' && failurePhases.has(value.phase) ? value.phase : null,
    httpStatus: typeof value.httpStatus === 'number' && Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599 ? value.httpStatus : null };
}
export function createYcsDotaStatusRoute(getRuntime: () => YcsDotaRuntime | undefined): SafeStatusRoute {
  return (request, response) => {
    if (request.url !== '/healthz/ycs-dota') return false;
    const runtime = getRuntime();
    const code = runtime?.code ?? 'YCS_DISABLED';
    const allowed = request.method === 'GET' || request.method === 'HEAD';
    response.writeHead(allowed ? 200 : 405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(allowed ? {} : { Allow: 'GET, HEAD' }) });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(allowed ? {
      version: manifest?.version ?? null, sourceRevision: manifest?.sourceRevision ?? null, packageFingerprint: manifest?.packageFingerprint ?? null,
      enabled: runtime?.enabled ?? false, configured: code === 'YCS_STARTED', code,
      status: runtime?.state.status ?? 'disabled', lastAttemptAt: runtime?.state.lastAttemptAt ?? null,
      lastSuccessAt: runtime?.state.lastSuccessAt ?? null, pendingMaps: runtime?.state.pendingMaps ?? 0,
      lastFailure: safeFailure(runtime?.state.lastFailure),
    } : { code: 'METHOD_NOT_ALLOWED' }));
    return true;
  };
}

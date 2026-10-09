import { readFile } from 'node:fs/promises';
import type { SafeStatusRoute } from '../ycs-dota/status.ts';
import type { YcsCaptainRuntime } from './runtime.ts';

let manifest: { version: string; sourceRevision: string; packageFingerprint: string } | null = null;
try { manifest = JSON.parse(await readFile(new URL('../../ycs-dota/captain-manifest.json', import.meta.url), 'utf8')); }
catch { /* An unavailable optional package must not stop the main gateway. */ }

export function createYcsCaptainStatusRoute(getRuntime: () => YcsCaptainRuntime | undefined): SafeStatusRoute {
  return (request, response) => {
    if (request.url !== '/healthz/ycs-captain') return false;
    const runtime = getRuntime(), allowed = request.method === 'GET' || request.method === 'HEAD';
    response.writeHead(allowed ? 200 : 405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(allowed ? {} : { Allow: 'GET, HEAD' }) });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(allowed ? {
      version: manifest?.version ?? null, sourceRevision: manifest?.sourceRevision ?? null, packageFingerprint: manifest?.packageFingerprint ?? null,
      enabled: runtime?.enabled ?? false, configured: runtime?.code === 'CAPTAIN_STARTED', code: runtime?.code ?? 'CAPTAIN_DISABLED',
      status: runtime?.state.status ?? 'disabled', attempts: runtime?.state.attempts ?? 0,
      lastAttemptAt: runtime?.state.lastAttemptAt ?? null, lastSuccessAt: runtime?.state.lastSuccessAt ?? null,
      error: runtime?.state.error === 'cleanup_unavailable' ? 'cleanup_unavailable' : null,
      rosterImport: runtime?.rosterStatus() ?? null,
      cleanupErrorCode: runtime?.cleanupErrorCode() ?? null,
    } : { code: 'METHOD_NOT_ALLOWED' }));
    return true;
  };
}

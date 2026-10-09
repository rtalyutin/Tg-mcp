import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpApiRoute } from '../http-api-route.ts';

export interface CaptainService {
  captain(body: unknown): Promise<unknown>;
  organizer(body?: unknown): Promise<unknown>;
  cleanup(): Promise<unknown>;
}
type SourceHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
export interface CaptainWorker {
  state: { status: string; attempts: number; lastAttemptAt: number | null; lastSuccessAt: number | null; error: string | null };
  stop(): Promise<void>;
}
type ServiceOptions = { env: NodeJS.ProcessEnv; now?: () => number };
export interface CaptainDependencies {
  createCaptainService(options: ServiceOptions): CaptainService;
  createCaptainHandler(options: { service: CaptainService; now?: () => number }): SourceHandler;
  createOrganizerHandler(options: ServiceOptions & { captainService: CaptainService }): SourceHandler;
  startCaptainCleanupWorker(options: ServiceOptions & { service: CaptainService; enabled: boolean }): CaptainWorker;
}
export interface YcsCaptainRuntime {
  enabled: boolean;
  code: 'CAPTAIN_DISABLED' | 'CAPTAIN_CONFIG_MISSING' | 'CAPTAIN_CONFIG_INVALID' | 'CAPTAIN_CREDENTIALS_MISSING' | 'CAPTAIN_STARTED' | 'CAPTAIN_START_FAILED';
  state: CaptainWorker['state'];
  apiRoute: HttpApiRoute;
  stop(): Promise<void>;
}

export function readYcsCaptainConfig(env: NodeJS.ProcessEnv): { enabled: boolean; code: YcsCaptainRuntime['code'] } {
  const flag = env.YCS_CAPTAIN_ENABLED;
  if (flag === undefined || flag === 'false') return { enabled: false, code: 'CAPTAIN_DISABLED' };
  if (flag !== 'true') return { enabled: false, code: 'CAPTAIN_CONFIG_INVALID' };
  if (!env.YCS_CAPTAIN_BOT_ID || !env.YCS_CAPTAIN_ENCRYPTION_KEY) return { enabled: false, code: 'CAPTAIN_CONFIG_MISSING' };
  if (!/^[1-9]\d{0,19}$/.test(env.YCS_CAPTAIN_BOT_ID) || !/^[a-fA-F0-9]{64}$/.test(env.YCS_CAPTAIN_ENCRYPTION_KEY) ||
      (env.YCS_CAPTAIN_BUCKET !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.YCS_CAPTAIN_BUCKET))) return { enabled: false, code: 'CAPTAIN_CONFIG_INVALID' };
  if (!env.AWS_ACCESS_KEY_ID?.trim() || !env.AWS_SECRET_ACCESS_KEY?.trim()) return { enabled: false, code: 'CAPTAIN_CREDENTIALS_MISSING' };
  return { enabled: true, code: 'CAPTAIN_STARTED' };
}

async function loadCaptainDependencies(): Promise<CaptainDependencies> {
  const root = new URL('../../ycs-dota/backend/', import.meta.url);
  const [service, captain, organizer, cleanup] = await Promise.all([
    import(new URL('captain-service.mjs', root).href), import(new URL('captain-api.mjs', root).href),
    import(new URL('organizer-api.mjs', root).href), import(new URL('captain-cleanup-worker.mjs', root).href),
  ]);
  return { createCaptainService: service.createCaptainService, createCaptainHandler: captain.createCaptainHandler,
    createOrganizerHandler: organizer.createOrganizerHandler, startCaptainCleanupWorker: cleanup.startCaptainCleanupWorker };
}

/** One service owns captain requests, organizer requests and retention cleanup. */
export async function startYcsCaptainRuntime({ env = process.env, now, loadDependencies = loadCaptainDependencies }: {
  env?: NodeJS.ProcessEnv; now?: () => number; loadDependencies?: () => Promise<CaptainDependencies>;
} = {}): Promise<YcsCaptainRuntime> {
  const config = readYcsCaptainConfig(env);
  let worker: CaptainWorker | undefined;
  let captain: SourceHandler | undefined, organizer: SourceHandler | undefined;
  let code = config.code;
  if (config.enabled) {
    try {
      const dependencies = await loadDependencies();
      // Do not give the module unrelated Telegram, MCP or database credentials.
      const selected = Object.fromEntries(['YCS_CAPTAIN_BOT_ID', 'YCS_CAPTAIN_ENCRYPTION_KEY', 'YCS_CAPTAIN_BUCKET',
        'YCS_CAPTAIN_WINDOWS_JSON', 'YCS_ORGS_LOGIN', 'YCS_ORGS_PASSWORD', 'YCS_ORGS_ALLOWED_ORIGIN',
        'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
      const options = { env: selected, ...(now ? { now } : {}) };
      const service = dependencies.createCaptainService(options);
      captain = dependencies.createCaptainHandler({ service, ...(now ? { now } : {}) });
      organizer = dependencies.createOrganizerHandler({ ...options, captainService: service });
      worker = dependencies.startCaptainCleanupWorker({ ...options, service, enabled: true });
    } catch { code = 'CAPTAIN_START_FAILED'; }
  }
  const enabled = code === 'CAPTAIN_STARTED' && Boolean(worker);
  const state = worker?.state ?? { status: 'disabled', attempts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null };
  const inFlight = new Set<Promise<boolean>>();
  let stopped = false, stopping: Promise<void> | undefined;
  const unavailable = (request: IncomingMessage, response: ServerResponse, error = 'captain_not_configured') => {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!response.writableEnded) response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error }));
    return true;
  };
  return { enabled, code, state,
    async apiRoute(request, response) {
      let url: URL;
      try { url = new URL(request.url || '/', 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/api/captain' && !url.pathname.startsWith('/api/orgs/')) return false;
      if (!enabled || stopped) return unavailable(request, response);
      const pending = (async () => (await organizer!(request, response, url)) || (await captain!(request, response, url)))()
        .catch(() => unavailable(request, response, 'storage_unavailable'));
      inFlight.add(pending);
      try { return await pending; }
      finally { inFlight.delete(pending); }
    },
    stop() {
      stopped = true;
      return stopping ??= Promise.allSettled([worker?.stop(), ...inFlight]).then(() => { state.status = 'stopped'; });
    },
  };
}

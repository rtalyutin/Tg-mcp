import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpApiRoute } from '../http-api-route.ts';

export const PLAYER_INTAKE_ORIGIN = 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
const PREFIX = '/api/player/v1/intake';
type SourceHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
type IntakeCode = 'PLAYER_INTAKE_DISABLED' | 'PLAYER_INTAKE_CONFIG_INVALID' | 'PLAYER_INTAKE_CREDENTIALS_MISSING' |
  'PLAYER_INTAKE_STARTED' | 'PLAYER_INTAKE_START_FAILED';
export interface PlayerIntakeDependencies {
  createPlayerProfileHandler(options: { env: NodeJS.ProcessEnv; now?: () => number }): SourceHandler;
}
export interface PlayerIntakeRuntime {
  enabled: boolean;
  code: IntakeCode;
  state: { status: 'disabled' | 'running' | 'stopped' };
  apiRoute: HttpApiRoute;
  stop(): Promise<void>;
}

export function readYcsPlayerIntakeConfig(env: NodeJS.ProcessEnv): { enabled: boolean; code: IntakeCode; origin: string } {
  const fallback = { enabled: false, code: 'PLAYER_INTAKE_CONFIG_INVALID' as IntakeCode, origin: PLAYER_INTAKE_ORIGIN };
  if (env.YCS_PLAYER_INTAKE_ENABLED === undefined || env.YCS_PLAYER_INTAKE_ENABLED === 'false') return { ...fallback, code: 'PLAYER_INTAKE_DISABLED' };
  if (env.YCS_PLAYER_INTAKE_ENABLED !== 'true') return fallback;
  let origin: string;
  try {
    const url = new URL(env.YCS_PLAYER_ORIGIN || PLAYER_INTAKE_ORIGIN);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return fallback;
    origin = url.origin;
  } catch { return fallback; }
  for (const bucket of [env.YCS_PLAYER_BUCKET, env.YCS_CAPTAIN_BUCKET]) if (bucket !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { ...fallback, origin };
  if (!env.AWS_ACCESS_KEY_ID?.trim() || !env.AWS_SECRET_ACCESS_KEY?.trim()) return { enabled: false, code: 'PLAYER_INTAKE_CREDENTIALS_MISSING', origin };
  return { enabled: true, code: 'PLAYER_INTAKE_STARTED', origin };
}

async function loadPlayerIntakeDependencies(): Promise<PlayerIntakeDependencies> {
  const source = await import(new URL('../../player-intake/backend/player-profile-api.mjs', import.meta.url).href);
  return { createPlayerProfileHandler: source.createPlayerProfileHandler };
}

/** One opt-in route on the existing native gateway; account APIs never escape. */
export async function startYcsPlayerIntakeRuntime({ env = process.env, now, loadDependencies = loadPlayerIntakeDependencies }: {
  env?: NodeJS.ProcessEnv; now?: () => number; loadDependencies?: () => Promise<PlayerIntakeDependencies>;
} = {}): Promise<PlayerIntakeRuntime> {
  const config = readYcsPlayerIntakeConfig(env);
  let code = config.code, handler: SourceHandler | undefined;
  if (config.enabled) {
    try {
      const dependencies = await loadDependencies();
      const selected: NodeJS.ProcessEnv = Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'YCS_PLAYER_BUCKET', 'YCS_CAPTAIN_BUCKET',
        'YCS_PLAYER_DISCIPLINES_JSON'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
      selected.YCS_PLAYER_ENABLED = 'false'; selected.YCS_PLAYER_INTAKE_ENABLED = 'true'; selected.YCS_PLAYER_ORIGIN = config.origin;
      handler = dependencies.createPlayerProfileHandler({ env: selected, ...(now ? { now } : {}) });
    } catch { code = 'PLAYER_INTAKE_START_FAILED'; }
  }
  const enabled = code === 'PLAYER_INTAKE_STARTED' && Boolean(handler);
  const state: PlayerIntakeRuntime['state'] = { status: enabled ? 'running' : 'disabled' };
  const inFlight = new Set<Promise<boolean>>(); let stopped = false, stopping: Promise<void> | undefined;
  const unavailable = (request: IncomingMessage, response: ServerResponse) => {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      ...(request.headers.origin === config.origin ? { 'Access-Control-Allow-Origin': config.origin, Vary: 'Origin' } : {}) });
    if (!response.writableEnded) response.end(request.method === 'HEAD' ? undefined : '{"error":"player_intake_not_configured"}');
    return true;
  };
  return { enabled, code, state,
    async apiRoute(request, response) {
      let url: URL;
      try { url = new URL(request.url || '/', 'http://localhost'); } catch { return false; }
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
      if (!enabled || stopped || !handler) return unavailable(request, response);
      const pending = Promise.resolve().then(() => handler!(request, response, url)).catch(() => unavailable(request, response));
      inFlight.add(pending);
      try { const handled = await pending; return handled || unavailable(request, response); }
      finally { inFlight.delete(pending); }
    },
    stop() {
      stopped = true;
      return stopping ??= Promise.allSettled([...inFlight]).then(() => { state.status = 'stopped'; });
    },
  };
}

export const combinePlayerIntakeApi = (player: () => PlayerIntakeRuntime | undefined, next: () => HttpApiRoute | undefined): HttpApiRoute =>
  async (request, response) => await player()?.apiRoute(request, response) || await next()?.(request, response) || false;

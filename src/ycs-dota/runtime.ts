export interface YcsDotaWorker {
  state: { status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; pendingMaps: number };
  stop(): Promise<void>;
}
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;
interface WorkerOptions { env: NodeJS.ProcessEnv; logger: Logger; now?: () => Date; }
type StartWorker = (options: WorkerOptions) => YcsDotaWorker;
export interface YcsDotaRuntime {
  enabled: boolean;
  code: 'YCS_DISABLED' | 'YCS_CONFIG_INVALID' | 'YCS_CREDENTIALS_MISSING' | 'YCS_STARTED' | 'YCS_START_FAILED';
  state: YcsDotaWorker['state'];
  stop(): Promise<void>;
}

/** Explicit opt-in only. No credential values or dependency errors escape. */
export function readYcsDotaConfig(env: NodeJS.ProcessEnv): { enabled: boolean; code: YcsDotaRuntime['code'] } {
  const flag = env.YCS_DOTA_RESULTS_IMPORT_ENABLED;
  if (flag === undefined || flag === 'false') return { enabled: false, code: 'YCS_DISABLED' };
  if (flag !== 'true') return { enabled: false, code: 'YCS_CONFIG_INVALID' };
  if (!env.AWS_ACCESS_KEY_ID?.trim() || !env.AWS_SECRET_ACCESS_KEY?.trim()) return { enabled: false, code: 'YCS_CREDENTIALS_MISSING' };
  return { enabled: true, code: 'YCS_STARTED' };
}

export async function startYcsDotaRuntime({ env = process.env, logger = console, now, startWorker }: {
  env?: NodeJS.ProcessEnv; logger?: Logger; now?: () => Date; startWorker?: StartWorker;
} = {}): Promise<YcsDotaRuntime> {
  const config = readYcsDotaConfig(env);
  const disabled = (code: YcsDotaRuntime['code']): YcsDotaRuntime => ({ enabled: false, code,
    state: { status: 'disabled', lastAttemptAt: null, lastSuccessAt: null, pendingMaps: 0 }, async stop() {} });
  if (!config.enabled) return disabled(config.code);
  try {
    const create = startWorker ?? (await import(new URL('../../ycs-dota/backend/dota-results-worker.mjs', import.meta.url).href)).startResultsWorker as StartWorker;
    // The upstream importer logs source/API errors. Never forward those payloads
    // into the shared production logs; status remains available in this process.
    const safeLogger: Logger = { log: () => logger.log('YCS_DOTA_ACTIVITY'), warn: () => logger.warn('YCS_DOTA_WARNING'), error: () => logger.error('YCS_DOTA_RETRY') };
    const worker = create({ env: { YCS_DOTA_RESULTS_IMPORT_ENABLED: 'true',
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY }, logger: safeLogger, ...(now ? { now } : {}) });
    return { enabled: true, code: 'YCS_STARTED', state: worker.state, stop: () => worker.stop() };
  } catch { return disabled('YCS_START_FAILED'); }
}

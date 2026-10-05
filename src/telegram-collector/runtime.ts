import type { Pool, PoolClient } from 'pg';
import { TelegramCollectorApi, TelegramCollectorError, type CollectorApi } from './api.ts';
import type { TelegramCollectorConfig } from './config.ts';
import { TelegramEventStore } from './store.ts';
import { TelegramCollectorGateway } from './gateway.ts';
import { safeStartupCode } from '../startup-diagnostics.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Uses only committed checkpoints. A failed connection lookup cannot ack data. */
export async function collectTelegramBatch(api: CollectorApi, store: TelegramEventStore, now = new Date(), signal?: AbortSignal) {
  const checkpoint = await store.getCheckpoint();
  // Telegram randomizes the next ID after a week without updates. Forgetting
  // the offset before then permits duplicate delivery; journal dedup handles it.
  const stale = checkpoint.lastUpdateAt && now.getTime() - checkpoint.lastUpdateAt.getTime() >= 6 * 24 * 60 * 60 * 1000;
  const updates = await api.getUpdates(stale ? null : checkpoint.nextOffset, signal);
  if (signal?.aborted) throw new TelegramCollectorError('TGC_ABORTED');
  await store.markResponse();
  const known = new Map<string, unknown>();
  for (const item of updates) {
    const connection = record(record(item)?.business_connection);
    if (connection && typeof connection.id === 'string') known.set(connection.id, connection);
  }
  for (const item of updates) {
    const update = record(item);
    const event = record(update?.business_message ?? update?.edited_business_message ?? update?.deleted_business_messages);
    const id = event?.business_connection_id;
    if (typeof id !== 'string' || !id || id.length > 512 || known.has(id)) continue;
    if (!(await store.getConnection(id))) {
      const connection = await api.getBusinessConnection(id, signal);
      if (record(connection)?.id !== id) throw new TelegramCollectorError('TGC_CONNECTION_INVALID');
      known.set(id, connection);
    }
  }
  if (signal?.aborted) throw new TelegramCollectorError('TGC_ABORTED');
  // Receipt timestamp belongs to the completed poll, not to its start.
  const receivedAt = new Date();
  await store.ingestBatch(updates, [...known.values()], receivedAt);
  await store.markPoll(null, receivedAt);
  return updates.length;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function verifyCollectorApi(api: CollectorApi, config: TelegramCollectorConfig, signal?: AbortSignal): Promise<string> {
  const identity = record(await api.getMe(signal));
  if (!identity || identity.is_bot !== true || !Number.isSafeInteger(identity.id) || Number(identity.id) < 1 ||
      typeof identity.username !== 'string' || identity.username.toLowerCase() !== config.expectedUsername.toLowerCase())
    throw new TelegramCollectorError('TGC_BOT_IDENTITY_MISMATCH');
  if (identity.can_connect_to_business !== true) throw new TelegramCollectorError('TGC_BUSINESS_MODE_REQUIRED');
  const webhook = record(await api.getWebhookInfo(signal));
  if (!webhook || typeof webhook.url !== 'string') throw new TelegramCollectorError('TGC_RESPONSE_INVALID');
  if (webhook.url) throw new TelegramCollectorError('TGC_WEBHOOK_ACTIVE');
  return String(identity.id);
}

export async function startTelegramCollector(pool: Pool, config: TelegramCollectorConfig,
  options: { api?: CollectorApi } = {}): Promise<TelegramCollectorGateway> {
  const api = options.api ?? new TelegramCollectorApi(config.botToken);
  const botId = await verifyCollectorApi(api, config);
  const shutdown = new AbortController();
  let controller = new AbortController();
  let lock: PoolClient | undefined; let acquired = false; let running = false; let lost = false; let job: Promise<void> | undefined;
  let recoveryCode = 'TGC_LOCK_LOST';
  let recoveryDelayMs = 5_000;
  const lockLost = (error: unknown) => {
    lost = true; running = false; recoveryCode = 'TGC_LOCK_LOST'; recoveryDelayMs = 5_000; controller.abort();
    if (!shutdown.signal.aborted) console.error(`TELEGRAM_COLLECTOR_STOPPED code=TGC_LOCK_LOST${safeStartupCode(error).replace(' code=', ' diagnostic_code=')}`);
  };
  const acquire = async () => {
    if (controller.signal.aborted || shutdown.signal.aborted) throw new TelegramCollectorError('TGC_ABORTED');
    lock = await pool.connect();
    lock.on('error', lockLost);
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext('telegram-collector'), hashtext($1)) AS acquired", [botId]);
    if (result.rows[0]?.acquired !== true) throw new TelegramCollectorError('TGC_ALREADY_RUNNING');
    acquired = true;
    if (controller.signal.aborted || shutdown.signal.aborted) throw new TelegramCollectorError('TGC_ABORTED');
  };
  const release = async () => {
    const session = lock; lock = undefined;
    try { if (acquired && session && !lost) await session.query("SELECT pg_advisory_unlock(hashtext('telegram-collector'), hashtext($1))", [botId]); }
    catch { lost = true; }
    finally { acquired = false; session?.removeListener('error', lockLost); session?.release(lost); }
  };
  try {
    await acquire();
    const store = new TelegramEventStore(pool, botId, config.ownerTelegramId);
    await store.migrate();
    if (controller.signal.aborted) throw new TelegramCollectorError('TGC_LOCK_LOST');
    running = true;
    job = (async () => {
      try { while (!shutdown.signal.aborted) {
        if (controller.signal.aborted) {
          // The previous poll has settled before we release/reacquire ownership.
          await release();
          await store.markPoll(recoveryCode).catch(() => {});
          await delay(recoveryDelayMs, shutdown.signal);
          if (shutdown.signal.aborted) break;
          controller = new AbortController(); lost = false;
          try {
            const identity = await verifyCollectorApi(api, config, controller.signal);
            if (identity !== botId) throw new TelegramCollectorError('TGC_BOT_IDENTITY_MISMATCH');
            await acquire();
            if (controller.signal.aborted || shutdown.signal.aborted) throw new TelegramCollectorError('TGC_ABORTED');
            running = true;
            recoveryDelayMs = 5_000;
            console.log('TELEGRAM_COLLECTOR_RECOVERED');
          } catch (error) {
            recoveryCode = error instanceof TelegramCollectorError && /^TGC_[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TGC_STORAGE_UNAVAILABLE';
            recoveryDelayMs = error instanceof TelegramCollectorError
              ? Math.min(300, Math.max(5, Number.isFinite(error.retryAfter) ? error.retryAfter : 5)) * 1_000 : 5_000;
            controller.abort();
            if (!shutdown.signal.aborted) console.error(`TELEGRAM_COLLECTOR_RECOVERY_FAILED code=${recoveryCode}${safeStartupCode(error).replace(' code=', ' diagnostic_code=')}`);
            continue;
          }
        }
        try {
          const count = await collectTelegramBatch(api, store, new Date(), controller.signal);
          if (!count) await delay(500, controller.signal); // Also bounds fast empty API doubles.
        } catch (error) {
          if (controller.signal.aborted) continue;
          const storeCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
          const code = error instanceof TelegramCollectorError ? error.code
            : typeof storeCode === 'string' && ['TELEGRAM_EVENT_INVALID', 'TELEGRAM_CONNECTION_INVALID', 'TELEGRAM_CONNECTION_UNKNOWN', 'TGC_OWNER_MISMATCH'].includes(storeCode)
              ? storeCode : 'TGC_STORAGE_UNAVAILABLE';
          await store.markPoll(code).catch(() => {});
          await delay((error instanceof TelegramCollectorError ? error.retryAfter : 5) * 1000, controller.signal);
        }
      } } finally { running = false; await release(); }
    })();
    let closing: Promise<void> | undefined;
    return new TelegramCollectorGateway(store, config.credentialId, config.botToken, () => running, () => closing ??= (async () => {
      running = false; shutdown.abort(); controller.abort(); await job;
    })());
  } catch (error) {
    shutdown.abort(); controller.abort(); await release();
    if (error instanceof TelegramCollectorError) throw error;
    throw new TelegramCollectorError('TGC_STORAGE_UNAVAILABLE');
  }
}

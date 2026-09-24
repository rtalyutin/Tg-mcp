import { randomUUID } from 'node:crypto';
import { Publisher, FORMAT_POLICY } from './publisher.ts';
import { TelegramReadinessChecker, TelegramSender } from './telegram.ts';
import { ReadinessGate } from './lifecycle.ts';

export const SERVICE_VERSION = '0.12.0';
export interface RuntimeOptions {
  profile: 'readonly' | 'publisher';
  publishEnabled: boolean;
  botToken?: string;
  channelId?: string;
  taskChannels?: Readonly<Record<string, string>>;
  telegramTimeoutMs?: number;
  minPublishIntervalMs?: number;
  deliveryMode?: 'direct' | 'worker';
  workerToken?: string;
}

/** Internal assembly. API root is injected by the local mock wrapper, never env/tool input. */
export function createPublisherRuntime(options: RuntimeOptions, mockRoot?: string) {
  const profile = options.profile; const publishEnabled = options.publishEnabled;
  if (profile !== 'readonly' && profile !== 'publisher') throw new Error('Invalid profile');
  if (profile === 'readonly' && publishEnabled) throw new Error('Read-only cannot publish');
  const routeEntries = options.taskChannels ? Object.entries(options.taskChannels) : undefined;
  let stopping = false;
  const gates = new Map<string, ReadinessGate>();
  const pinnedIds = new Map<string, string>();
  const acceptsResolved = (channel: string, resolved: string | undefined) => {
    if (!resolved) return true;
    const previous = pinnedIds.get(channel);
    if (previous && previous !== resolved) return false;
    pinnedIds.set(channel, resolved);
    return true;
  };
  let publisher: Publisher | undefined;
  if (profile === 'publisher') {
    if (!options.botToken || (!options.channelId && !options.taskChannels)) throw new Error('Telegram configuration required');
    const channels = routeEntries ? routeEntries.map(([, channel]) => channel) : [options.channelId!];
    const telegramOptions = { botToken: options.botToken, timeoutMs: options.telegramTimeoutMs, apiRoot: mockRoot };
    const checker = new TelegramReadinessChecker(telegramOptions);
    for (const channel of channels) gates.set(channel, new ReadinessGate(() => checker.check(channel, true)));
    const sender = new TelegramSender(telegramOptions);
    publisher = new Publisher({ channelId: options.channelId, taskChannels: routeEntries ? Object.fromEntries(routeEntries) : undefined,
      minPublishIntervalMs: options.minPublishIntervalMs,
      readiness: () => ({ publishEnabled, telegramReady: false }),
      preflight: async channelId => {
        const state = await gates.get(channelId)!.refresh();
        if (!state.ready) return false;
        if (!acceptsResolved(channelId, state.resolved_channel_id)) return false;
        return state.resolved_channel_id ?? true;
      },
      sender: { async send(channelId, text) {
        const invalidate = () => { for (const [configured, gate] of gates) if (configured === channelId || pinnedIds.get(configured) === channelId) gate.invalidate(); };
        try { const outcome = await sender.send(channelId, text); if (outcome.kind !== 'confirmed') invalidate(); return outcome; }
        catch { invalidate(); return { kind: 'unknown' }; }
      } },
    });
  }
  const instanceId = publisher?.instanceId ?? randomUUID();
  return {
    profile, instanceId,
    async status() {
      const taskStates = publisher && routeEntries ? await Promise.all(routeEntries.map(async ([task_id, channel]) => {
        const state = await gates.get(channel)!.refresh();
        const resolvedAccepted = state.ready && acceptsResolved(channel, state.resolved_channel_id);
        const ready = !stopping && resolvedAccepted;
        return { task_id, telegram_ready: ready, channel_title: ready && state.ready ? state.channel_title : null,
          channel_username: ready && state.ready ? state.channel_username : null,
          resolved_channel_id: ready && state.ready ? state.resolved_channel_id ?? null : null,
          check_code: ready ? null : stopping ? 'SHUTTING_DOWN' : state.ready ? 'CHANNEL_ID_CHANGED' : state.check_code ?? 'TELEGRAM_NOT_READY' };
      })) : undefined;
      const state = options.channelId && gates.has(options.channelId) ? await gates.get(options.channelId)!.refresh() : null;
      const ready = !stopping && (taskStates ? taskStates.every(item => item.telegram_ready)
        : state?.ready === true && !!options.channelId && acceptsResolved(options.channelId, state.resolved_channel_id));
      return { service_version: SERVICE_VERSION, instance_id: instanceId, publish_enabled: publishEnabled,
        telegram_ready: ready, channel_title: ready && state?.ready ? state.channel_title : null,
        channel_username: ready && state?.ready ? state.channel_username : null, format_policy: FORMAT_POLICY,
        ...(taskStates ? { task_status: taskStates } : {}),
        ...(!taskStates && profile === 'publisher' ? { telegram_check_code: ready ? null : stopping ? 'SHUTTING_DOWN'
          : state?.ready ? 'CHANNEL_ID_CHANGED' : state?.check_code ?? 'TELEGRAM_NOT_READY' } : {}),
        reason_code: stopping ? 'SHUTTING_DOWN' : profile === 'readonly' ? 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED'
          : !publishEnabled ? 'PUBLISH_DISABLED' : !ready ? 'TELEGRAM_NOT_READY' : null };
    },
    publish(input: unknown) { if (!publisher) throw new Error('Tool unavailable'); return publisher.publish(input); },
    attempt(input: unknown) { if (!publisher) throw new Error('Tool unavailable'); return publisher.getAttemptStatus(input); },
    stop() { stopping = true; for (const gate of gates.values()) gate.stop(); return publisher?.stop() ?? Promise.resolve(); },
  };
}

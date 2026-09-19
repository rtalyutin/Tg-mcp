import { randomUUID } from 'node:crypto';
import { Publisher, FORMAT_POLICY } from './publisher.ts';
import { TelegramReadinessChecker, TelegramSender } from './telegram.ts';
import { ReadinessGate } from './lifecycle.ts';

export const SERVICE_VERSION = '0.8.0';
export interface RuntimeOptions {
  profile: 'readonly' | 'publisher';
  publishEnabled: boolean;
  botToken?: string;
  channelId?: string;
  telegramTimeoutMs?: number;
}

/** Internal assembly. API root is injected by the local mock wrapper, never env/tool input. */
export function createPublisherRuntime(options: RuntimeOptions, mockRoot?: string) {
  const profile = options.profile; const publishEnabled = options.publishEnabled;
  if (profile !== 'readonly' && profile !== 'publisher') throw new Error('Invalid profile');
  if (profile === 'readonly' && publishEnabled) throw new Error('Read-only cannot publish');
  let stopping = false;
  let gate: ReadinessGate | undefined;
  let publisher: Publisher | undefined;
  if (profile === 'publisher') {
    if (!options.botToken || !options.channelId) throw new Error('Telegram configuration required');
    const channel = options.channelId;
    const telegramOptions = { botToken: options.botToken, timeoutMs: options.telegramTimeoutMs, apiRoot: mockRoot };
    const checker = new TelegramReadinessChecker(telegramOptions);
    gate = new ReadinessGate(() => checker.check(channel));
    const sender = new TelegramSender(telegramOptions);
    publisher = new Publisher({ channelId: channel,
      readiness: () => ({ publishEnabled, telegramReady: false }),
      preflight: async () => (await gate!.refresh()).ready,
      sender: { async send(channelId, text) {
        try { const outcome = await sender.send(channelId, text); if (outcome.kind !== 'confirmed') gate!.invalidate(); return outcome; }
        catch { gate!.invalidate(); return { kind: 'unknown' }; }
      } },
    });
  }
  const instanceId = publisher?.instanceId ?? randomUUID();
  return {
    profile, instanceId,
    async status() {
      const state = gate ? await gate.refresh() : null;
      const ready = !stopping && state?.ready === true;
      return { service_version: SERVICE_VERSION, instance_id: instanceId, publish_enabled: publishEnabled,
        telegram_ready: ready, channel_title: ready && state?.ready ? state.channel_title : null,
        channel_username: ready && state?.ready ? state.channel_username : null, format_policy: FORMAT_POLICY,
        reason_code: stopping ? 'SHUTTING_DOWN' : profile === 'readonly' ? 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED'
          : !publishEnabled ? 'PUBLISH_DISABLED' : !ready ? 'TELEGRAM_NOT_READY' : null };
    },
    publish(input: unknown) { if (!publisher) throw new Error('Tool unavailable'); return publisher.publish(input); },
    attempt(input: unknown) { if (!publisher) throw new Error('Tool unavailable'); return publisher.getAttemptStatus(input); },
    stop() { stopping = true; gate?.stop(); return publisher?.stop() ?? Promise.resolve(); },
  };
}

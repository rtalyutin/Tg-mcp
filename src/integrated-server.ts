import { z } from 'zod';
import { FORMAT_POLICY, MAX_TEXT_BYTES, Publisher, attemptInputSchema, publishInputSchema, publishResultSchema } from './publisher.ts';
import { TelegramSender } from './telegram.ts';
import { startLoopbackMcp } from './mcp-http.ts';

export const INTEGRATED_VERSION = '0.5.0';
// JSON escaping can expand a valid input substantially beyond its UTF-8 text size.
export const INTEGRATED_MAX_BODY_BYTES = MAX_TEXT_BYTES * 6 + 4096;

const statusSchema = z.strictObject({
  service_version: z.literal(INTEGRATED_VERSION),
  instance_id: z.uuid(),
  publish_enabled: z.boolean(),
  telegram_ready: z.boolean(),
  channel_title: z.null(),
  channel_username: z.null(),
  format_policy: z.literal(FORMAT_POLICY),
  reason_code: z.enum(['PUBLISH_DISABLED', 'TELEGRAM_NOT_READY']).nullable(),
});

export interface LocalIntegratedOptions {
  accessToken: string;
  botToken: string;
  channelId: string;
  telegramApiRoot: string;
  publishEnabled: boolean;
  telegramReady: boolean;
  telegramTimeoutMs?: number;
  port?: number;
}

/**
 * Loopback integration harness. It intentionally requires a local mock Telegram
 * root and is not the Timeweb/production entrypoint.
 */
export async function startLocalIntegratedPublisher(options: LocalIntegratedOptions) {
  const root = new URL(options.telegramApiRoot);
  if (root.protocol !== 'http:' || root.hostname !== '127.0.0.1' || root.port === '') {
    throw new Error('Local integration requires a loopback mock Telegram API');
  }
  const readiness = Object.freeze({ publishEnabled: options.publishEnabled, telegramReady: options.telegramReady });
  const sender = new TelegramSender({ botToken: options.botToken, apiRoot: options.telegramApiRoot, timeoutMs: options.telegramTimeoutMs });
  const publisher = new Publisher({ channelId: options.channelId, sender, readiness: () => readiness });
  const status = Object.freeze({
    service_version: INTEGRATED_VERSION,
    instance_id: publisher.instanceId,
    publish_enabled: readiness.publishEnabled,
    telegram_ready: readiness.telegramReady,
    channel_title: null,
    channel_username: null,
    format_policy: FORMAT_POLICY,
    reason_code: !readiness.publishEnabled ? 'PUBLISH_DISABLED' as const : !readiness.telegramReady ? 'TELEGRAM_NOT_READY' as const : null,
  });
  const server = await startLoopbackMcp({
    token: options.accessToken,
    port: options.port,
    serverName: 'story-publisher-local-integration',
    serverVersion: INTEGRATED_VERSION,
    maxBodyBytes: INTEGRATED_MAX_BODY_BYTES,
    registerTools(mcp) {
      mcp.registerTool('get_publisher_status', {
        title: 'Read publisher readiness',
        description: 'Read readiness and current in-memory instance identity.',
        inputSchema: z.strictObject({}), outputSchema: statusSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async () => ({ structuredContent: { ...status }, content: [{ type: 'text', text: JSON.stringify(status) }] }));
      mcp.registerTool('publish_story', {
        title: 'Publish final story',
        description: 'Publish the complete final story sequentially. Never retry automatically after an unknown outcome.',
        inputSchema: publishInputSchema, outputSchema: publishResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      }, async input => {
        const result = await publisher.publish(input);
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      });
      mcp.registerTool('get_publish_attempt', {
        title: 'Read publication attempt',
        description: 'Read the in-memory state of one publication attempt without sending anything.',
        inputSchema: attemptInputSchema, outputSchema: publishResultSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async input => {
        const result = publisher.getAttemptStatus(input);
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      });
    },
  });
  return { ...server, instanceId: publisher.instanceId };
}

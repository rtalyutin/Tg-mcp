import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { READ_ONLY_MAX_BODY_BYTES, startLoopbackMcp } from './mcp-http.ts';

export const VERSION = '0.1.0';
export const MAX_BODY_BYTES = READ_ONLY_MAX_BODY_BYTES;
const statusSchema = z.strictObject({
  service_version: z.string(), instance_id: z.uuid(),
  publish_enabled: z.literal(false), telegram_ready: z.literal(false),
  channel_title: z.null(), channel_username: z.null(),
  format_policy: z.literal('sequential_text_posts'),
  reason_code: z.literal('READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED'),
});

// Test-only authentication. It is NOT an OAuth implementation or a deployable
// ChatGPT connection. Binding is deliberately hardcoded to loopback below.
export async function startLocalProbe(token: string, port = 0) {
  const status = Object.freeze({
    service_version: VERSION, instance_id: randomUUID(),
    publish_enabled: false as const, telegram_ready: false as const,
    channel_title: null, channel_username: null,
    format_policy: 'sequential_text_posts' as const,
    reason_code: 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED' as const,
  });
  return startLoopbackMcp({ token, port, serverName: 'story-publisher-local-probe', serverVersion: VERSION,
    maxBodyBytes: MAX_BODY_BYTES, registerTools(mcp) {
      mcp.registerTool('get_publisher_status', {
        title: 'Read publisher readiness',
        description: 'Read local prototype readiness. This build cannot contact Telegram or publish stories.',
        inputSchema: z.strictObject({}), outputSchema: statusSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async () => ({ structuredContent: { ...status }, content: [{ type: 'text', text: JSON.stringify(status) }] }));
    } });
}

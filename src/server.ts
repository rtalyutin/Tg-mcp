import { createServer } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const VERSION = '0.1.0';
export const MAX_BODY_BYTES = 16 * 1024;
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
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('LOCAL_PROBE_TOKEN must be 32–256 base64url characters');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const expectedHash = createHash('sha256').update(`Bearer ${token}`).digest();
  const status = Object.freeze({
    service_version: VERSION, instance_id: randomUUID(),
    publish_enabled: false as const, telegram_ready: false as const,
    channel_title: null, channel_username: null,
    format_policy: 'sequential_text_posts' as const,
    reason_code: 'READ_ONLY_PROBE_TELEGRAM_NOT_CONFIGURED' as const,
  });
  const http = createServer(async (req, res) => {
    const reply = (code: number, body: object) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const address = http.address();
    if (!address || typeof address === 'string') { reply(503, { error: 'NOT_READY' }); return; }
    if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin !== undefined) {
      reply(403, { error: 'ORIGIN_OR_HOST_DENIED' }); return;
    }
    if (req.url === '/healthz' && req.method === 'GET') { reply(200, { status: 'ok' }); return; }
    if (req.url !== '/mcp') { reply(404, { error: 'NOT_FOUND' }); return; }
    const actualHash = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expectedHash, actualHash)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="local-probe-only"');
      reply(401, { error: 'UNAUTHORIZED' }); return;
    }
    // Stateless, JSON-only probe: server-initiated SSE and session deletion
    // are intentionally unsupported; MCP permits 405 for the GET stream.
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      reply(415, { error: 'JSON_REQUIRED' }); return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
    let mcp: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { error: 'INVALID_JSON' }); return; }
      // This protocol profile accepts one JSON-RPC message per HTTP request.
      // The SDK may accept an empty batch as an empty notification response;
      // reject batches and scalar JSON before dispatch rather than return 202.
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        reply(400, { error: 'INVALID_RPC_ENVELOPE' }); return;
      }
      mcp = new McpServer({ name: 'story-publisher-local-probe', version: VERSION });
      mcp.registerTool('get_publisher_status', {
        title: 'Read publisher readiness',
        description: 'Read local prototype readiness. This build cannot contact Telegram or publish stories.',
        inputSchema: z.strictObject({}), outputSchema: statusSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async () => ({ structuredContent: { ...status }, content: [{ type: 'text', text: JSON.stringify(status) }] }));
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reply(500, { error: 'INTERNAL_ERROR' });
      else if (!res.writableEnded) res.end();
    } finally {
      await transport?.close().catch(() => {});
      await mcp?.close().catch(() => {});
    }
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  http.setTimeout(15_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve());
      http.closeAllConnections();
    }),
  };
}

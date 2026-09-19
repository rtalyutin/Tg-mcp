import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { acceptsSecretPath, validateSecretPathConfig, type SecretPathConfig } from './secret-auth.ts';
import { createPublisherRuntime, SERVICE_VERSION, type RuntimeOptions } from './publisher-runtime.ts';
import { attemptInputSchema, publishInputSchema, publishResultSchema, MAX_TEXT_BYTES } from './publisher.ts';

export interface SecretServerOptions extends RuntimeOptions { secret: SecretPathConfig; port?: number }
const empty = z.strictObject({});
const statusOutput = z.strictObject({ service_version: z.string(), instance_id: z.uuid(), publish_enabled: z.boolean(), telegram_ready: z.boolean(),
  channel_title: z.string().nullable(), channel_username: z.string().nullable(), format_policy: z.literal('sequential_text_posts'), reason_code: z.string().nullable() });
function definition(name: string, input: z.ZodType, output: z.ZodType, write: boolean, network: boolean) {
  // ChatGPT performs no OAuth handshake. Possession of the endpoint is the credential.
  const securitySchemes = [{ type: 'noauth' }];
  return { name, description: write ? 'Publish the complete final story in order. Never retry an unknown outcome.' : 'Read publisher state without sending messages.',
    inputSchema: z.toJSONSchema(input, { unrepresentable: 'any' }), outputSchema: z.toJSONSchema(output),
    annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: network }, securitySchemes, _meta: { securitySchemes } };
}

/** TLS terminates at Timeweb. Use ONLY the configured HTTPS endpoint from clients. */
export function startSecretPublisher(options: SecretServerOptions) { return startServer(options, false); }

/** Tests cannot reach Telegram: publisher requires an explicit loopback mock. */
export function startLocalSecretPublisher(options: SecretServerOptions & { telegramApiRoot?: string }) {
  if (options.profile === 'publisher' && !options.telegramApiRoot) throw new Error('Mock Telegram root required');
  if (options.telegramApiRoot) {
    const u = new URL(options.telegramApiRoot);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.search || u.hash) throw new Error('Loopback mock required');
  }
  return startServer(options, true, options.telegramApiRoot);
}

async function startServer(options: SecretServerOptions, local: boolean, mockRoot?: string) {
  const secret = validateSecretPathConfig(options.secret, local);
  const publicOrigin = new URL(secret.publicOrigin);
  const port = options.port ?? (local ? 0 : 8080);
  if (!Number.isInteger(port) || port < (local ? 0 : 1) || port > 65535) throw new Error('Invalid port');
  // Fixed admission limit: one new story per minute per process, no delay/queue/retry.
  const runtime = createPublisherRuntime({ ...options, minPublishIntervalMs: 60_000 }, mockRoot);
  const definitions = [definition('get_publisher_status', empty, statusOutput, false, runtime.profile === 'publisher')];
  if (runtime.profile === 'publisher') definitions.push(definition('publish_story', publishInputSchema, publishResultSchema, true, true), definition('get_publish_attempt', attemptInputSchema, publishResultSchema, false, false));
  const http = createServer({ maxHeaderSize: 20 * 1024 }, async (req, res) => {
    const reply = (code: number, body: object) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(body)); };
    // Platform health probes may send an internal Host. This endpoint has no state/secrets.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/healthz') { reply(200, { status: 'ok' }); return; }
    const address = http.address();
    const expectedHost = local && address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : publicOrigin.host;
    if (req.headers.host !== expectedHost || (req.headers.origin !== undefined && req.headers.origin !== (local ? `http://${expectedHost}` : publicOrigin.origin))) { reply(403, { error: 'ORIGIN_OR_HOST_DENIED' }); return; }
    // No redirects: a request containing a capability must never move to another URL.
    if (!local && req.headers['x-forwarded-proto'] !== undefined && req.headers['x-forwarded-proto'] !== 'https') { reply(403, { error: 'HTTPS_REQUIRED' }); return; }
    if (!acceptsSecretPath(req.url, secret.pathSecret)) { reply(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { reply(415, { error: 'JSON_REQUIRED' }); return; }
    const limit = runtime.profile === 'readonly' ? 16 * 1024 : MAX_TEXT_BYTES * 6 + 4096;
    if (Number(req.headers['content-length'] ?? 0) > limit) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
    let mcp: Server | undefined; let transport: StreamableHTTPServerTransport | undefined;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > limit) { reply(413, { error: 'BODY_TOO_LARGE' }); return; } chunks.push(Buffer.from(chunk)); }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reply(400, { error: 'INVALID_JSON' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(400, { error: 'INVALID_RPC_ENVELOPE' }); return; }
      mcp = new Server({ name: 'telegram-story-publisher', version: SERVICE_VERSION }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(definitions) }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        const name = request.params.name;
        if (!definitions.some(tool => tool.name === name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
        const schema = name === 'publish_story' ? publishInputSchema : name === 'get_publish_attempt' ? attemptInputSchema : empty;
        const parsed = schema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, 'Invalid tool input');
        const value = name === 'publish_story' ? await runtime.publish(parsed.data) : name === 'get_publish_attempt' ? runtime.attempt(parsed.data) : await runtime.status();
        (name === 'get_publisher_status' ? statusOutput : publishResultSchema).parse(value);
        return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      });
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) reply(500, { error: 'INTERNAL_ERROR' }); else if (!res.writableEnded) res.end(); }
    finally { await transport?.close().catch(() => {}); await mcp?.close().catch(() => {}); }
  });
  http.maxConnections = 64; http.requestTimeout = 15_000; http.headersTimeout = 10_000; http.setTimeout(0);
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => { http.removeListener('error', reject); resolve(); }); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  let closing: Promise<void> | undefined;
  return { url: `${local ? `http://127.0.0.1:${address.port}` : secret.publicOrigin}/mcp/${secret.pathSecret}`, instanceId: runtime.instanceId,
    stop: () => runtime.stop(), close: () => closing ??= runtime.stop().then(() => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); })) };
}

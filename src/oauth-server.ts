import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OAuthVerifier, AuthFailure, READ_SCOPE, WRITE_SCOPE, type OAuthConfig } from './oauth.ts';
import { createPublisherRuntime, SERVICE_VERSION, type RuntimeOptions } from './publisher-runtime.ts';
import { attemptInputSchema, publishInputSchema, publishResultSchema, MAX_TEXT_BYTES } from './publisher.ts';

export interface OAuthServerOptions extends RuntimeOptions { oauth: OAuthConfig; port?: number }
const empty = z.strictObject({});
const statusOutput = z.strictObject({ service_version: z.string(), instance_id: z.uuid(), publish_enabled: z.boolean(), telegram_ready: z.boolean(),
  channel_title: z.string().nullable(), channel_username: z.string().nullable(), format_policy: z.literal('sequential_text_posts'), reason_code: z.string().nullable(),
  task_status: z.array(z.strictObject({ task_id: z.string(), telegram_ready: z.boolean(), channel_title: z.string().nullable(), channel_username: z.string().nullable(), resolved_channel_id: z.string().nullable() })).optional() });
function description(name: string, input: z.ZodType, output: z.ZodType, write: boolean, network: boolean) {
  const securitySchemes = [{ type: 'oauth2', scopes: write ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE] }];
  return { name, description: name === 'publish_story' ? 'Publish the complete final story in order. In task routing mode provide task_id; the server selects its configured channel. Never retry an unknown outcome.' : 'Read publisher state without sending messages.',
    inputSchema: z.toJSONSchema(input, { unrepresentable: 'any' }), outputSchema: z.toJSONSchema(output),
    annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: network },
    securitySchemes, _meta: { securitySchemes } };
}

/** The only real Telegram composition root. HTTPS must terminate at the platform proxy. */
export function startProductionPublisher(options: OAuthServerOptions) {
  return startOAuthServer(options, false);
}

/** Synthetic OAuth+Telegram integration: ALL outbound origins are loopback and binding is loopback. */
export function startLocalOAuthPublisher(options: OAuthServerOptions & { telegramApiRoot?: string }) {
  if (options.profile === 'publisher' && !options.telegramApiRoot) throw new Error('Mock Telegram root required');
  if (options.telegramApiRoot) {
    const root = new URL(options.telegramApiRoot);
    if (root.protocol !== 'http:' || root.hostname !== '127.0.0.1' || !root.port || root.username || root.password || root.search || root.hash) throw new Error('Loopback mock required');
  }
  return startOAuthServer(options, true, options.telegramApiRoot);
}

async function startOAuthServer(options: OAuthServerOptions, local: boolean, mockRoot?: string) {
  const auth = new OAuthVerifier(options.oauth, local);
  const port = options.port ?? (local ? 0 : 8080);
  if (!Number.isInteger(port) || port < (local ? 0 : 1) || port > 65535) throw new Error('Invalid port');
  const runtime = createPublisherRuntime(options, mockRoot);
  const resource = new URL(auth.config.resource);
  const definitions = [description('get_publisher_status', empty, statusOutput, false, runtime.profile === 'publisher')];
  if (runtime.profile === 'publisher') definitions.push(description('publish_story', publishInputSchema, publishResultSchema, true, true), description('get_publish_attempt', attemptInputSchema, publishResultSchema, false, false));
  const http = createServer({ maxHeaderSize: 20 * 1024 }, async (req, res) => {
    const reply = (code: number, body: object) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    // Never trust Host/Forwarded to construct URLs. Host must be preserved by proxy.
    const address = http.address();
    const expectedHost = local && address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : resource.host;
    if (req.headers.host !== expectedHost || (req.headers.origin !== undefined && req.headers.origin !== resource.origin)) { reply(403, { error: 'ORIGIN_OR_HOST_DENIED' }); return; }
    if (req.method === 'GET' && req.url === '/healthz') { reply(200, { status: 'ok' }); return; }
    if (req.method === 'GET' && (req.url === '/.well-known/oauth-protected-resource/mcp' || req.url === '/.well-known/oauth-protected-resource')) { reply(200, auth.metadata(runtime.profile === 'publisher')); return; }
    if (req.url !== '/mcp') { reply(404, { error: 'NOT_FOUND' }); return; }
    let identity;
    try {
      if (req.rawHeaders.filter((header, i) => i % 2 === 0 && header.toLowerCase() === 'authorization').length !== 1) throw new AuthFailure('invalid_token');
      identity = await auth.verify(req.headers.authorization);
    }
    catch (error) {
      const failure = error instanceof AuthFailure ? error : new AuthFailure('invalid_token');
      res.setHeader('WWW-Authenticate', auth.challenge(failure));
      reply(failure.code === 'insufficient_scope' ? 403 : 401, { error: failure.code }); return;
    }
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
      // Token may have expired during a slow body upload; no dispatch after expiry.
      try { auth.require(identity, [READ_SCOPE]); }
      catch { res.setHeader('WWW-Authenticate', auth.challenge()); reply(401, { error: 'invalid_token' }); return; }
      mcp = new Server({ name: 'telegram-story-publisher', version: SERVICE_VERSION }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(definitions) }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        const name = request.params.name;
        if (!definitions.some(tool => tool.name === name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
        try { auth.require(identity, name === 'publish_story' ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE]); }
        catch (error) {
          const failure = error instanceof AuthFailure ? error : new AuthFailure('invalid_token');
          return { isError: true, content: [{ type: 'text' as const, text: 'Authorization required' }], _meta: { 'mcp/www_authenticate': [auth.challenge(failure)] } };
        }
        const schema = name === 'publish_story' ? publishInputSchema : name === 'get_publish_attempt' ? attemptInputSchema : empty;
        const parsed = schema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, 'Invalid tool input');
        const value = name === 'publish_story' ? await runtime.publish(parsed.data) : name === 'get_publish_attempt' ? runtime.attempt(parsed.data) : await runtime.status();
        (name === 'get_publisher_status' ? statusOutput : publishResultSchema).parse(value);
        return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) reply(500, { error: 'INTERNAL_ERROR' }); else if (!res.writableEnded) res.end(); }
    finally { await transport?.close().catch(() => {}); await mcp?.close().catch(() => {}); }
  });
  http.requestTimeout = 15_000; http.headersTimeout = 10_000;
  // Full story can span many Telegram calls. Do not abort an executing response
  // at a short idle timeout; the request/body deadline above still applies.
  http.setTimeout(0);
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => { http.removeListener('error', reject); resolve(); }); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  let closing: Promise<void> | undefined;
  return { url: local ? `http://127.0.0.1:${address.port}/mcp` : auth.config.resource, instanceId: runtime.instanceId,
    stop: () => runtime.stop(), close: () => closing ??= runtime.stop().then(() => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); })) };
}

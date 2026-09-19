import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const READ_ONLY_MAX_BODY_BYTES = 16 * 1024;

export interface LoopbackMcpOptions {
  token: string;
  port?: number;
  serverName: string;
  serverVersion: string;
  maxBodyBytes?: number;
  registerTools: (server: McpServer) => void;
}

/** Shared loopback-only MCP transport. Production auth/binding are deliberately absent. */
export async function startLoopbackMcp(options: LoopbackMcpOptions) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) {
    throw new Error('LOCAL_PROBE_TOKEN must be 32–256 base64url characters');
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const maxBodyBytes = options.maxBodyBytes ?? READ_ONLY_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('Invalid body limit');
  const expectedHash = createHash('sha256').update(`Bearer ${options.token}`).digest();
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
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      reply(415, { error: 'JSON_REQUIRED' }); return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBodyBytes) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
    let mcp: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > maxBodyBytes) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { error: 'INVALID_JSON' }); return; }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        reply(400, { error: 'INVALID_RPC_ENVELOPE' }); return;
      }
      mcp = new McpServer({ name: options.serverName, version: options.serverVersion });
      options.registerTools(mcp);
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
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: ({ force = true }: { force?: boolean } = {}) => closing ??= new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve());
      if (force) http.closeAllConnections();
    }),
  };
}

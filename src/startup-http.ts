import { createServer, type RequestListener, type Server } from 'node:http';
import type { SafeStatusRoute } from './ycs-dota/status.ts';
import { handleHttpApiRoute, type HttpApiRoute } from './http-api-route.ts';

export interface StartupHttpListener {
  server: Server;
  activate(handler: RequestListener): void;
  close(): Promise<void>;
}

/** Bind before dependencies initialize; independent APIs keep their own auth. */
export async function startStartupHttpListener(port: number, statusRoute?: SafeStatusRoute, apiRoute?: HttpApiRoute): Promise<StartupHttpListener> {
  let handler: RequestListener | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    if (statusRoute?.(req, res)) return;
    if (await handleHttpApiRoute(apiRoute, req, res)) return;
    if (handler) { handler(req, res); return; }
    const health = req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD');
    res.writeHead(health ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Strict-Transport-Security': 'max-age=31536000',
    });
    res.end(JSON.stringify(health ? { status: 'ok' } : { code: 'SERVICE_UNAVAILABLE' }));
  });
  server.maxConnections = 64; server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  // Parser errors can contain a query login: never log them or reflect input.
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
  return {
    server,
    activate(next) {
      if (closing || handler) throw new Error('HTTP startup listener is already closed or activated');
      handler = next;
    },
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
      // An independent API can still be completing a write before activation.
      if (!handler && !apiRoute) server.closeAllConnections();
    }),
  };
}

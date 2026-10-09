import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpApiRoute = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** Optional API failures must not escape into the shared gateway or logs. */
export async function handleHttpApiRoute(route: HttpApiRoute | undefined, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!route) return false;
  try { return await route(request, response); }
  catch {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!response.writableEnded) response.end('{"error":"storage_unavailable"}');
    return true;
  }
}

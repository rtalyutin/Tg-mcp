import { createRateLimit, fail } from './captain-auth.mjs';
import { captainErrorResponse } from './captain-service.mjs';

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('invalid_request', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) fail('invalid_request', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid_request'); }
}

export function createCaptainHandler({ service, now = Date.now } = {}) {
  // Captains share the relay's egress IP; verified per-user limits below are
  // stricter. Keep this coarse pre-signature budget large enough for polling.
  const preAuthLimit = createRateLimit({ now, limit: 1200 });
  return async (request, response, url) => {
    if (url.pathname !== '/api/captain') return false;
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', ...(status === 429 ? { 'retry-after': '60' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
      return true;
    };
    // This is a server-to-server relay target, not a credentialed browser API.
    if (request.headers.origin) return send(403, { error: 'forbidden' });
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return send(405, { error: 'invalid_request' }); }
    try {
      preAuthLimit(request.socket.remoteAddress || 'unknown');
      return send(200, await service.captain(await readBody(request)));
    } catch (error) { const failure = captainErrorResponse(error); return send(failure.status, failure.body); }
  };
}

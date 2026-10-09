import { createServer } from 'node:http';
import { createCaptainHandler } from '../../backend/captain-api.mjs';
import { createOrganizerHandler } from '../../backend/organizer-api.mjs';

// Test-only composition of the real handlers. No collector or production entrypoint.
export function createCaptainTestServer({ env = {}, captainService } = {}) {
  if (!captainService) throw new TypeError('A test captain service is required');
  const organizer = createOrganizerHandler({ env, captainService,
    getData: async () => { throw new Error('Unexpected organizer data lookup in captain test'); } });
  const captain = createCaptainHandler({ service: captainService });
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (await organizer(request, response, url)) return;
    if (await captain(request, response, url)) return;
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

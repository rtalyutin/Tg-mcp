import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AccessStore, AccessError, clientIp, parseMcpLogin } from './access.ts';
import { AdmissionQueue } from './admission-queue.ts';
import { Registry, RegistryError, registryToolDefinitions, executeRegistryTool } from './registry.ts';
import type { OutreachConfig } from './config.ts';
import { loginPage, unavailablePage, tablePage, cardPage, stylesheet, browserScript } from './ui.ts';
import { createPublisherRuntime, type RuntimeOptions } from '../publisher-runtime.ts';
import { attemptInputSchema, publishInputSchema } from '../publisher.ts';
import { QueuedPublisher, workerInput, queuedPublishInputSchema, coverInputSchema,
  coverChunkSchema, COVER_CHUNK_PREFIX, COVER_TEXT_PREFIX, COVER_ONLY_MARKER, queuedCoverOnlyInputSchema } from './telegram-delivery.ts';
import { MailService, mailToolDefinitions } from './mail.ts';
import { z } from 'zod';
import { isPublicDashboardRequest, serveDashboardWeb } from '../dashboard-web.ts';

const unavailable = { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' };
const ownerCredentials = z.strictObject({ login: z.string().min(1).max(128), password: z.string().min(1).max(256) });
const idPattern = /^[0-9a-f-]{36}$/i;
function sameSecret(a: string | undefined, b: string) {
  return !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function tokenFromCookie(req: IncomingMessage) {
  const tokens = (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith('ycs_session='));
  return tokens.length === 1 ? tokens[0].slice(12) : null;
}
async function jsonBody(req: IncomingMessage, maxBytes = 65536): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RegistryError('JSON_REQUIRED', 415, 'JSON required');
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new RegistryError('BODY_TOO_LARGE', 413, 'Request too large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new RegistryError('BODY_TOO_LARGE', 413, 'Request too large'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RegistryError('INVALID_JSON', 400, 'Invalid JSON'); }
}
function safeRoute(path: string) {
  if (['/', '/login', '/logout', '/mcp', '/dashboard/mcp', '/dashboard/api/snapshot'].includes(path)) return path;
  if (path.startsWith('/internal/telegram/')) return '/internal/telegram';
  if (/^\/companies\/[0-9a-f-]{36}$/i.test(path)) return '/companies/:id';
  if (['/api/v1/companies', '/api/v1/operations', '/api/v1/candidates', '/api/v1/candidates/resolve', '/api/v1/contacts', '/api/v1/opportunities', '/api/v1/opportunities/status'].includes(path)) return path;
  if (path.startsWith('/api/v1/mail/')) return '/api/v1/mail/:action';
  return '/unknown';
}

export interface DashboardRoute { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): Promise<void> }
export interface DashboardSnapshotRoute { read(): Promise<unknown>; close(): Promise<void> }
export function startOutreachGateway(options: { config: OutreachConfig; pool: Pool; telegram?: RuntimeOptions; dashboard?: DashboardRoute; dashboardSnapshot?: DashboardSnapshotRoute }) {
  return start(options.pool, options.config.publicOrigin, options.config.port, options.config.trustedProxyCidrs, false, options.telegram, options.dashboard, options.dashboardSnapshot, options.config.mail);
}
/** Explicit loopback-only harness. No environment setting can enable it in production. */
export function startLocalOutreach(options: { pool: Pool; port?: number; trustedProxyCidrs?: string[]; telegram?: RuntimeOptions; dashboard?: DashboardRoute; dashboardSnapshot?: DashboardSnapshotRoute }) {
  return start(options.pool, 'http://127.0.0.1', options.port ?? 0, options.trustedProxyCidrs ?? [], true, options.telegram, options.dashboard, options.dashboardSnapshot, null);
}

async function start(pool: Pool, origin: string, port: number, trustedCidrs: string[], local: boolean, telegramOptions?: RuntimeOptions, dashboard?: DashboardRoute, dashboardSnapshot?: DashboardSnapshotRoute, mailConfig: OutreachConfig['mail']=null) {
  const access = new AccessStore(pool); const registry = new Registry(pool);
  const mail = new MailService(pool,mailConfig);
  const admissionQueue = new AdmissionQueue(ip => access.admitIp(ip, false));
  // Disabled Telegram is not constructed and cannot prevent registry startup.
  if (telegramOptions?.deliveryMode === 'worker' && (!telegramOptions.workerToken ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(telegramOptions.workerToken))) throw new Error('Invalid worker configuration');
  const telegram = telegramOptions ? telegramOptions.deliveryMode === 'worker'
    ? new QueuedPublisher(pool, telegramOptions) : createPublisherRuntime(telegramOptions) : undefined;
  const worker = telegram instanceof QueuedPublisher ? telegram : undefined;
  const extraTools = telegram ? [{ name: 'get_publisher_status', description: 'Read Telegram publisher state.', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: true } },
    ...(telegram.profile === 'publisher' ? [
      ...(worker ? [{ name: 'upload_story_cover', description: 'Stage a square PNG cover for a task and story before publishing. Return cover_id; never place image bytes in chat.', inputSchema: z.toJSONSchema(coverInputSchema) as { type: 'object' }, annotations: { readOnlyHint: false, openWorldHint: false } }] : []),
      { name: 'publish_story', description: worker ? 'Queue the uploaded cover with the start of the story in its caption, then the remaining text in order for this task channel. Requires cover_id.' : 'Publish the approved text to the configured Telegram channel; never retry an unknown result.', inputSchema: z.toJSONSchema(worker ? queuedPublishInputSchema : publishInputSchema) as { type: 'object' }, annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false } },
      { name: 'get_publish_attempt', description: 'Read one Telegram attempt.', inputSchema: z.toJSONSchema(attemptInputSchema) as { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } },
    ] : [])] : [];
  const definitions = [...registryToolDefinitions, ...mailToolDefinitions, ...extraTools].map(tool => ({ ...tool, securitySchemes: [{ type: 'noauth' }], _meta: { securitySchemes: [{ type: 'noauth' }] } }));
  let fallbackLogAfter = 0;
  function fallbackLog() { if (Date.now() >= fallbackLogAfter) { fallbackLogAfter = Date.now() + 10000; console.error('OUTREACH_ACCESS_DEPENDENCY_UNAVAILABLE'); } }
  const rateLogs = new Set<Promise<void>>();
  function recordRateRejection(ip: string) {
    // Respond at the queue deadline even when PostgreSQL is slow. Every final
    // rejection gets one INSERT: a healthy but slow DB is not a reason to drop
    // counters. Unlike admission, pending audit work is not capacity-bounded.
    const pending = access.recordRateRejection(ip).catch(() => { fallbackLog(); }).finally(() => { rateLogs.delete(pending); });
    rateLogs.add(pending);
  }
  async function audit(ip: string, path: string, outcome: string, requestId: string, credentialId?: string) {
    try { await access.recordAccess({ ip, route: safeRoute(path), outcome, requestId, credentialId }); } catch { fallbackLog(); }
  }
  const http = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (!local) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Request-Id', requestId);
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const html = (status: number, value: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(value); };
    let path = '/unknown'; let ip = '0.0.0.0';
    const disconnected = new AbortController();
    const cancel = () => disconnected.abort();
    req.once('aborted', cancel); res.once('close', cancel);
    if (req.aborted || res.destroyed) cancel();
    try {
      // Never retain/log the raw URL. No route redirects a query-bearing request.
      const url = new URL(req.url ?? '/', 'http://local.invalid'); path = url.pathname;
      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD') && !url.search) { reply(200, { status: 'ok' }); return; }
      const expectedOrigin = local ? `http://127.0.0.1:${(http.address() as { port: number }).port}` : origin;
      const expectedHost = new URL(expectedOrigin).host;
      const publicAsset = !url.search && (path === '/assets/app.css' || path === '/assets/app.js') && req.method === 'GET';
      const dashboardAsset = isPublicDashboardRequest(req);
      const workerRoute = worker && path.startsWith('/internal/telegram/');
      const workerAuthorized = workerRoute && req.method === 'POST' && !url.search &&
        typeof req.headers.authorization === 'string' &&
        sameSecret(req.headers.authorization, `Bearer ${telegramOptions!.workerToken}`);
      if (!publicAsset && !dashboardAsset && !workerAuthorized) {
        ip = clientIp(req, trustedCidrs);
        const admission = await admissionQueue.acquire(ip, disconnected.signal);
        if (admission === 'cancelled' || res.destroyed) return;
        if (admission === 'closed') { reply(503, unavailable); return; }
        if (admission === 'limited') { res.setHeader('Retry-After', '1'); reply(429, { code: 'RATE_LIMITED' }); recordRateRejection(ip); return; }
      }
      if (req.headers.host !== expectedHost || (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin)) { await audit(ip, path, 'ORIGIN_DENIED', requestId); reply(403, unavailable); return; }
      if (!local && req.headers['x-forwarded-proto'] !== undefined && req.headers['x-forwarded-proto'] !== 'https') { reply(403, unavailable); return; }
      if (workerRoute) {
        if (!workerAuthorized) { reply(403, unavailable); return; }
        if (req.headers.origin !== undefined) { reply(403, unavailable); return; }
        const action = path.slice('/internal/telegram/'.length);
        const validators = workerInput;
        if (action === 'routes') { z.strictObject({}).parse(await jsonBody(req)); reply(200, { routes:worker.routes() }); return; }
        if (action === 'check') { reply(200, await worker.check(validators.check.parse(await jsonBody(req)))); return; }
        if (action === 'claim') { validators.claim.parse(await jsonBody(req)); reply(200, await worker.claim()); return; }
        if (action === 'begin') { reply(200, await worker.begin(validators.begin.parse(await jsonBody(req)))); return; }
        if (action === 'complete') { reply(200, await worker.complete(validators.complete.parse(await jsonBody(req)))); return; }
        if (action === 'defer') { reply(200, await worker.defer(validators.defer.parse(await jsonBody(req)))); return; }
        reply(404, unavailable); return;
      }
      if (publicAsset) { res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }); res.end(path.endsWith('.css') ? stylesheet : browserScript); return; }
      if (path === '/dashboard/mcp') {
        if (url.search || !dashboard) { reply(404, unavailable); return; }
        await dashboard.handle(req, res); return;
      }
      if (path === '/dashboard/api/snapshot') {
        if (req.method !== 'GET' || url.search || !dashboardSnapshot) { reply(404, unavailable); return; }
        const session = await access.getSession(tokenFromCookie(req));
        if (!session) { await audit(ip,path,'WEB_DENIED',requestId); reply(401,{code:'AUTH_REQUIRED'}); return; }
        const snapshot = await dashboardSnapshot.read();
        if (!snapshot) { reply(503,unavailable); return; }
        await audit(ip,path,'OWNER_ALLOWED',requestId);
        reply(200,snapshot); return;
      }
      if (path === '/dashboard' || path.startsWith('/dashboard/')) {
        await serveDashboardWeb(req, res); return;
      }
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
        const credential = await access.authenticateLogin(parseMcpLogin(req.url ?? ''));
        await audit(ip, path, credential ? 'MCP_ALLOWED' : 'MCP_DENIED', requestId, credential?.id);
        const body = await jsonBody(req, credential && worker ? 10 * 1024 * 1024 : 65536);
        const mcp = new Server({ name: 'ycs-gateway', version: '0.17.0' }, { capabilities: { tools: {} } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
        mcp.setRequestHandler(CallToolRequestSchema, async request => {
          if (!credential) return { isError: true, content: [{ type: 'text', text: JSON.stringify(unavailable) }], structuredContent: unavailable };
          try {
            let value: object;
            if (telegram && request.params.name === 'get_publisher_status') { z.strictObject({}).parse(request.params.arguments ?? {}); value = await telegram.status(); }
            else if (worker && request.params.name === 'upload_story_cover') value = await worker.uploadCover(coverInputSchema.parse(request.params.arguments));
            else if (worker && request.params.name === 'publish_story') {
              const args = request.params.arguments;
              if (typeof args?.text === 'string' && args.text.startsWith(COVER_CHUNK_PREFIX)) {
                const input = publishInputSchema.parse(args);
                let chunk: unknown;
                try { chunk = JSON.parse(input.text.slice(COVER_CHUNK_PREFIX.length)); }
                catch { throw new RegistryError('VALIDATION_ERROR',400,'Invalid cover chunk'); }
                value = await worker.stageCoverChunk(input,coverChunkSchema.parse(chunk));
              } else if (typeof args?.text === 'string' && args.text.startsWith(COVER_TEXT_PREFIX)) {
                const input = publishInputSchema.parse(args);
                value = await worker.publish(queuedPublishInputSchema.parse({ ...input, cover_id:input.attempt_id,
                  text:input.text.slice(COVER_TEXT_PREFIX.length) }));
              } else if (args?.text === COVER_ONLY_MARKER) {
                const input = publishInputSchema.parse(args);
                const { text: _marker, ...identifiers } = input;
                value = await worker.publishCoverOnly(queuedCoverOnlyInputSchema.parse({ ...identifiers, cover_id:input.attempt_id }));
              } else if (args?.text === '1' && typeof args.story_id === 'string' && args.story_id.startsWith('test-one:')) {
                value = await worker.publishTextProbe(publishInputSchema.parse(args));
              } else value = await worker.publish(queuedPublishInputSchema.parse(args));
            }
            else if (telegram && !(telegram instanceof QueuedPublisher) && telegram.profile === 'publisher' && request.params.name === 'publish_story') value = await telegram.publish(publishInputSchema.parse(request.params.arguments));
            else if (telegram?.profile === 'publisher' && request.params.name === 'get_publish_attempt') value = await telegram.attempt(attemptInputSchema.parse(request.params.arguments));
            else if (request.params.name === 'save_proposal_draft') value = await mail.saveDraft(request.params.arguments ?? {},`mcp:${credential.id}`);
            else if (request.params.name === 'submit_for_review') value = await mail.submit(request.params.arguments ?? {},`mcp:${credential.id}`);
            else if (request.params.name === 'get_proposal') {
              const input = z.strictObject({proposal_id:z.uuid()}).parse(request.params.arguments ?? {});
              value = await mail.detail(input.proposal_id);
            } else if (request.params.name === 'get_company') {
              value = await executeRegistryTool(registry,request.params.name,request.params.arguments ?? {},`mcp:${credential.id}`);
              if ('kind' in value && value.kind === 'company' && 'id' in value && typeof value.id === 'string') {
                value = {...value,mail:await mail.forCompany(value.id)};
              }
            } else value = await executeRegistryTool(registry, request.params.name, request.params.arguments ?? {}, `mcp:${credential.id}`);
            return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
          } catch (error) {
            const result = error instanceof RegistryError ? { code: error.code, ...(error.details ? { details: error.details } : {}) } : { code: error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'SERVICE_UNAVAILABLE' };
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
          }
        });
        try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
        finally { await transport.close().catch(() => {}); await mcp.close().catch(() => {}); }
        return;
      }
      if (path === '/login' && req.method === 'GET' && !url.search) { html(200, loginPage()); return; }
      if (path === '/login' && req.method === 'POST' && !url.search) {
        if (req.headers.origin !== expectedOrigin) { reply(403, unavailable); return; }
        const parsed = ownerCredentials.safeParse(await jsonBody(req));
        const owner = parsed.success ? await access.authenticateOwner(parsed.data.login, parsed.data.password) : null;
        await audit(ip, path, owner ? 'OWNER_ALLOWED' : 'OWNER_DENIED', requestId);
        if (!owner) { reply(503, unavailable); return; }
        const session = await access.createSession(owner.id);
        res.setHeader('Set-Cookie', `ycs_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${local ? '' : '; Secure'}`);
        reply(200, { status: 'ok' }); return;
      }
      const session = await access.getSession(tokenFromCookie(req));
      if (!session) {
        await audit(ip, path, 'WEB_DENIED', requestId);
        if (req.method === 'GET' && path === '/' && !url.search) html(200, loginPage());
        else if (path.startsWith('/api/')) reply(503, unavailable); else html(503, unavailablePage());
        return;
      }
      const actorId = `owner:${session.ownerId}`;
      if (req.method === 'GET' && path === '/') {
        const filters = Object.fromEntries(url.searchParams);
        const data = await registry.searchCompanies({ ...(filters.q ? { q: filters.q } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.cursor ? { cursor: filters.cursor } : {}) });
        html(200, tablePage(data as Parameters<typeof tablePage>[0], session.csrfToken, filters)); return;
      }
      if (req.method === 'GET' && path.startsWith('/companies/') && !url.search && idPattern.test(path.slice(11))) {
        const company = await registry.getCompany({ id: path.slice(11) });
        const proposals = company.kind === 'company' ? await mail.forCompany(company.id) : [];
        html(200, cardPage({...company,mail:proposals} as Parameters<typeof cardPage>[0], session.csrfToken)); return;
      }
      if (req.method === 'GET' && path === '/api/v1/companies') { reply(200, await registry.searchCompanies(Object.fromEntries(url.searchParams))); return; }
      if (req.method === 'GET' && path === '/api/v1/operations') { reply(200, await registry.getOperation(Object.fromEntries(url.searchParams))); return; }
      if (req.method === 'GET' && path === '/api/v1/mail/proposal') {
        reply(200,await mail.detail(url.searchParams.get('proposal_id') ?? '')); return;
      }
      if (req.method !== 'POST' || url.search) { reply(404, unavailable); return; }
      if (req.headers.origin !== expectedOrigin || !sameSecret(typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined, session.csrfToken)) { await audit(ip, path, 'CSRF_DENIED', requestId); reply(403, unavailable); return; }
      const body = await jsonBody(req);
      let result: unknown;
      switch (path) {
        case '/logout': await access.revokeSession(tokenFromCookie(req)!); res.setHeader('Set-Cookie', `ycs_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${local ? '' : '; Secure'}`); result = { status: 'ok' }; break;
        case '/api/v1/candidates': result = await registry.upsertCompanyCandidate(body, actorId); break;
        case '/api/v1/candidates/resolve': result = await registry.resolveCandidate(body, actorId); break;
        case '/api/v1/contacts': result = await registry.saveContact(body, actorId); break;
        case '/api/v1/opportunities': result = await registry.createOpportunity(body, actorId); break;
        case '/api/v1/opportunities/status': result = await registry.setOpportunityStatus(body, actorId); break;
        case '/api/v1/mail/draft': result = await mail.saveDraft(body,actorId); break;
        case '/api/v1/mail/submit': result = await mail.submit(body,actorId); break;
        case '/api/v1/mail/approve': result = await mail.approve(body,actorId); break;
        case '/api/v1/mail/queue': result = await mail.queue(body,actorId); break;
        case '/api/v1/mail/revoke': result = await mail.revoke(body,actorId); break;
        case '/api/v1/mail/pause': result = await mail.pause(body,actorId); break;
        case '/api/v1/mail/suppress': result = await mail.suppress(body,actorId); break;
        case '/api/v1/mail/close-unknown': result = await mail.closeUnknown(body,actorId); break;
        case '/api/v1/mail/reconcile': result = await mail.reconcile(body,actorId); break;
        case '/api/v1/mail/probe': result = await mail.probe(actorId); break;
        default: reply(404, unavailable); return;
      }
      await audit(ip, path, 'OWNER_ACTION', requestId);
      reply(200, result);
    } catch (error) {
      if (disconnected.signal.aborted || res.destroyed) return;
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      if (error instanceof RegistryError) { await audit(ip, path, 'REQUEST_REJECTED', requestId); reply(error.status, { code: error.code, ...(error.details ? { details: error.details } : {}) }); return; }
      fallbackLog(); await audit(ip, path, error instanceof AccessError ? error.code : 'DEPENDENCY_UNAVAILABLE', requestId);
      reply(503, unavailable);
    } finally {
      req.off('aborted', cancel); res.off('close', cancel);
    }
  });
  http.maxConnections = 64; http.requestTimeout = 15_000; http.headersTimeout = 10_000;
  // Raw HTTP parser errors can contain a request URL: intentionally discard them.
  http.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => { http.off('error', reject); resolve(); }); });
  mail.start();
  const url = local ? `http://127.0.0.1:${(http.address() as { port: number }).port}` : origin;
  let closing: Promise<void> | undefined;
  return { url, access, registry, close: () => closing ??= (async () => {
    admissionQueue.close();
    await mail.stop();
    await telegram?.stop();
    await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeIdleConnections(); });
    await admissionQueue.drained(); await Promise.all(rateLogs);
  })() };
}

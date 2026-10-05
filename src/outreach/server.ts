import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from 'node:http';
import type { StartupHttpListener } from '../startup-http.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AccessStore, AccessError, clientIp, parseMcpLogin } from './access.ts';
import { AdmissionQueue } from './admission-queue.ts';
import { Registry, RegistryError, registryToolDefinitions, executeRegistryTool } from './registry.ts';
import type { OutreachConfig } from './config.ts';
import { loginPage, unavailablePage, tablePage, cardPage, stylesheet, browserScript } from './ui.ts';
import { createPublisherRuntime, type RuntimeOptions } from '../publisher-runtime.ts';
import { attemptInputSchema, publishInputSchema } from '../publisher.ts';
import { QueuedPublisher, workerInput, queuedPublishInputSchema, coverInputSchema,
  coverChunkSchema, COVER_CHUNK_PREFIX, COVER_TEXT_PREFIX, COVER_ONLY_MARKER, TEXT_ONLY_PREFIX,
  queuedCoverOnlyInputSchema, queuedTextOnlyInputSchema } from './telegram-delivery.ts';
import { MailService, mailToolDefinitions } from './mail.ts';
import { z } from 'zod';
import { isPublicDashboardRequest, serveDashboardWeb } from '../dashboard-web.ts';
import { DatabaseToolError, type DatabaseTools } from './database-tools.ts';
import { serveWorkspaceWeb, readWorkspaceResource, workspaceResources, workspaceResourceUri, workspaceProjectsTool, workspaceAppOperations } from '../workspace-web.ts';
import type { OwnsiteGateway } from '../ownsite/gateway.ts';
import { PublicReadLimit } from './public-read-limit.ts';
import type { TelegramCollectorGateway } from '../telegram-collector/gateway.ts';
import { telegramCollectorToolDefinitions } from '../telegram-collector/gateway.ts';
import { TelegramCollectorError } from '../telegram-collector/api.ts';
import { safeStartupCode } from '../startup-diagnostics.ts';

const unavailable = { code: 'SERVICE_UNAVAILABLE', status: 'unavailable' };
const diagnosticReadTools = new Set(['telegram_collector_status', 'telegram_daily_events', 'get_dashboard_snapshot_state']);
const ownerCredentials = z.strictObject({ login: z.string().min(1).max(128), password: z.string().min(1).max(256) });
const idPattern = /^[0-9a-f-]{36}$/i;
function sameSecret(a: string | undefined, b: string) {
  return !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function databaseFailureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code !== 'string') return null;
  if (['23502','23503','23505','23514','23P01'].includes(code)) return 'DATABASE_CONSTRAINT_VIOLATION';
  if (code.startsWith('22')) return 'DATABASE_VALUE_INVALID';
  if (code === '42501') return 'DATABASE_PERMISSION_DENIED';
  if (code === '40001' || code === '40P01') return 'DATABASE_TRANSACTION_RETRY';
  if (code === '42P01' || code === '42703') return 'DATABASE_TABLE_CHANGED';
  return null;
}
function tokenFromCookie(req: IncomingMessage) {
  const tokens = (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith('ycs_session='));
  return tokens.length === 1 ? tokens[0].slice(12) : null;
}
const DEFAULT_JSON_BODY_BYTES = 65_536;
// Dashboard limits the parsed snapshot to 512,000 UTF-8 bytes. The separate
// JSON-RPC envelope can expand through Unicode escapes and group assignments.
// Only the owner's snapshot tools get this larger bounded transport allowance.
const SNAPSHOT_MCP_BODY_BYTES = 4 * 1024 * 1024;
async function jsonBody(req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_BYTES, largeTools?: readonly string[]): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RegistryError('JSON_REQUIRED', 415, 'JSON required');
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new RegistryError('BODY_TOO_LARGE', 413, 'Request too large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new RegistryError('BODY_TOO_LARGE', 413, 'Request too large'); chunks.push(Buffer.from(chunk)); }
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (largeTools && size > DEFAULT_JSON_BODY_BYTES) {
      const call = body && typeof body === 'object' ? body as {method?: unknown; params?: {name?: unknown}} : null;
      if (call?.method !== 'tools/call' || typeof call.params?.name !== 'string' || !largeTools.includes(call.params.name))
        throw new RegistryError('BODY_TOO_LARGE', 413, 'Request too large');
    }
    return body;
  }
  catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError('INVALID_JSON', 400, 'Invalid JSON');
  }
}
function safeRoute(path: string) {
  if (path.startsWith('/ownsite/')) return '/ownsite/public';
  if (path.startsWith('/workspace/api/')) return '/workspace/api';
  if (path === '/workspace' || path === '/workspace/') return '/workspace';
  if (['/', '/login', '/logout', '/mcp', '/dashboard/mcp', '/dashboard/api/snapshot',
    '/dashboard/api/history', '/dashboard/api/compare', '/dashboard/api/plan',
    '/dashboard/api/plan/task', '/dashboard/api/visibility',
    '/dashboard/api/visibility/project'].includes(path)) return path;
  if (path.startsWith('/internal/telegram/')) return '/internal/telegram';
  if (/^\/companies\/[0-9a-f-]{36}$/i.test(path)) return '/companies/:id';
  if (['/api/v1/companies', '/api/v1/operations', '/api/v1/candidates', '/api/v1/candidates/resolve', '/api/v1/contacts', '/api/v1/opportunities', '/api/v1/opportunities/status'].includes(path)) return path;
  if (path.startsWith('/api/v1/mail/')) return '/api/v1/mail/:action';
  return '/unknown';
}

export interface DashboardRoute { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): Promise<void> }
export interface WorkspaceRoute {
  ownerId: string;
  definitions: { name: string; description: string; inputSchema: { type: 'object'; [key: string]: unknown }; annotations: {readOnlyHint:boolean;destructiveHint:boolean;openWorldHint:boolean} }[];
  status(): Record<string, unknown>;
  uiSchema(): Record<string, unknown>;
  executeUi(name: string, input: unknown, ownerId: string): Promise<object>;
  callMcp(name: string, input: unknown, credentialId: string): Promise<{isError?:boolean;content:{type:'text';text:string}[];structuredContent:Record<string,unknown>}>;
  error(error: unknown): {status:number;body:object};
  close(): Promise<void>;
}
export interface DashboardSnapshotRoute {
  read(): Promise<unknown>;
  dates?(): Promise<unknown>;
  compare?(a: {from:string;to:string}, b: {from:string;to:string}): Promise<unknown>;
  readPlan?(): Promise<unknown>;
  writeTaskPlan?(input: unknown): Promise<unknown>;
  readVisibility?(): Promise<unknown>;
  writeVisibility?(input: unknown): Promise<unknown>;
  close(): Promise<void>
}
export interface DashboardMigrationRoute { credentialId: string; apply(input: unknown): Promise<object> }
export interface DashboardSnapshotWriterRoute { credentialId: string; readState(): Promise<object>; update(input: unknown): Promise<object> }
export function startOutreachGateway(options: { config: OutreachConfig; pool: Pool; startupListener?: StartupHttpListener; telegram?: RuntimeOptions; dashboard?: DashboardRoute; dashboardSnapshot?: DashboardSnapshotRoute; dashboardMigration?: DashboardMigrationRoute; dashboardWriter?: DashboardSnapshotWriterRoute; databaseTools?: DatabaseTools; workspace?: WorkspaceRoute; ownsite?: OwnsiteGateway; telegramCollector?: TelegramCollectorGateway }) {
  return start(options.pool, options.config.publicOrigin, options.config.port, options.config.trustedProxyCidrs, false, options.telegram, options.dashboard, options.dashboardSnapshot, options.dashboardMigration, options.dashboardWriter, options.databaseTools, options.config.mail, options.workspace, options.ownsite, options.telegramCollector, options.startupListener);
}
/** Explicit loopback-only harness. No environment setting can enable it in production. */
export function startLocalOutreach(options: { pool: Pool; port?: number; trustedProxyCidrs?: string[]; telegram?: RuntimeOptions; dashboard?: DashboardRoute; dashboardSnapshot?: DashboardSnapshotRoute; dashboardMigration?: DashboardMigrationRoute; dashboardWriter?: DashboardSnapshotWriterRoute; databaseTools?: DatabaseTools; workspace?: WorkspaceRoute; ownsite?: OwnsiteGateway; telegramCollector?: TelegramCollectorGateway }) {
  return start(options.pool, 'http://127.0.0.1', options.port ?? 0, options.trustedProxyCidrs ?? [], true, options.telegram, options.dashboard, options.dashboardSnapshot, options.dashboardMigration, options.dashboardWriter, options.databaseTools, null, options.workspace, options.ownsite, options.telegramCollector);
}

async function start(pool: Pool, origin: string, port: number, trustedCidrs: string[], local: boolean, telegramOptions?: RuntimeOptions, dashboard?: DashboardRoute, dashboardSnapshot?: DashboardSnapshotRoute, dashboardMigration?: DashboardMigrationRoute, dashboardWriter?: DashboardSnapshotWriterRoute, databaseTools?: DatabaseTools, mailConfig: OutreachConfig['mail']=null, workspace?: WorkspaceRoute, ownsite?: OwnsiteGateway, telegramCollector?: TelegramCollectorGateway, startupListener?: StartupHttpListener) {
  const access = new AccessStore(pool); const registry = new Registry(pool);
  const mail = new MailService(pool,mailConfig);
  const admissionQueue = new AdmissionQueue(ip => access.admitIp(ip, false));
  const ownsiteReads = new PublicReadLimit();
  // Disabled Telegram is not constructed and cannot prevent registry startup.
  if (telegramOptions?.deliveryMode === 'worker' && (!telegramOptions.workerToken ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(telegramOptions.workerToken))) throw new Error('Invalid worker configuration');
  const telegram = telegramOptions ? telegramOptions.deliveryMode === 'worker'
    ? new QueuedPublisher(pool, telegramOptions) : createPublisherRuntime(telegramOptions) : undefined;
  const worker = telegram instanceof QueuedPublisher ? telegram : undefined;
  const workerPublishInputSchema = publishInputSchema.extend({ cover_id: z.uuid().optional() });
  const extraTools = telegram ? [{ name: 'get_publisher_status', description: 'Read Telegram publisher state.', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: true } },
    ...(telegram.profile === 'publisher' ? [
      ...(worker ? [{ name: 'upload_story_cover', description: 'Stage a square PNG cover for a task and story before publishing. Return cover_id; never place image bytes in chat.', inputSchema: z.toJSONSchema(coverInputSchema) as { type: 'object' }, annotations: { readOnlyHint: false, openWorldHint: false } }] : []),
      { name: 'publish_story', description: worker ? 'Queue a text post or an uploaded cover with optional caption and following text for the configured task channel. For an older action schema, use the documented versioned markers.' : 'Publish the approved text to the configured Telegram channel; never retry an unknown result.', inputSchema: z.toJSONSchema(worker ? workerPublishInputSchema : publishInputSchema) as { type: 'object' }, annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false } },
      { name: 'get_publish_attempt', description: 'Read one Telegram attempt.', inputSchema: z.toJSONSchema(attemptInputSchema) as { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } },
    ] : [])] : [];
  const definitions = [...registryToolDefinitions, ...mailToolDefinitions, ...extraTools].map(tool => ({ ...tool, securitySchemes: [{ type: 'noauth' }], _meta: { securitySchemes: [{ type: 'noauth' }] } }));
  const storageAccessTool = { name:'get_dashboard_storage_access',description:'Read this MCP login ID and Dashboard storage tool availability. Returns no database secrets.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false} };
  const migrationTool = { name:'install_dashboard_snapshot',description:'One-time migration and import of a validated partial Dashboard snapshot. Only the configured MCP login may run it. Returns counts and a readback receipt, never snapshot contents.',
    inputSchema:{type:'object',properties:{snapshot:{type:'object'},project_groups:{type:'array',items:{type:'object',properties:{project_id:{type:'string'},group_code:{type:'string'}},required:['project_id','group_code'],additionalProperties:false}}},required:['snapshot','project_groups'],additionalProperties:false},
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false} };
  const snapshotStateTool={name:'get_dashboard_snapshot_state',description:'Read current Dashboard snapshot digest, date, coverage and counts for optimistic updates. Does not return private titles.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false} };
  const updateSnapshotTool={name:'update_dashboard_snapshot',description:'Write one sourced, explicitly partial Dashboard snapshot. Preserves exclusions and existing IDs, then reads it back through the restricted reader.',
    inputSchema:{type:'object',properties:{snapshot:{type:'object'},project_groups:{type:'array',items:{type:'object',properties:{project_id:{type:'string'},group_code:{type:'string'}},required:['project_id','group_code'],additionalProperties:false}}},required:['snapshot'],additionalProperties:false},
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false} };
  const dbTarget = { schema: {type:'string'}, table: {type:'string'} };
  const dbPage = {limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:1000000}};
  const dbFields = {type:'object',minProperties:1,additionalProperties:true};
  const dbValues = {type:'object',additionalProperties:true};
  const databaseToolDefinitions = [
    {name:'read_database',description:'Without a table, list accessible tables; with schema and table, return current columns and rows. Optional equality filters and pagination.',
      inputSchema:{type:'object',properties:{...dbTarget,where:dbFields,columns:{type:'array',items:{type:'string'}},order_by:{type:'array',items:{type:'string'}},...dbPage},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
    {name:'write_database',description:'Atomically insert, update matching rows, or upsert by primary key in an existing PostgreSQL table. Never deletes or changes schema. Update defaults to exactly one matching row per item.',
      inputSchema:{type:'object',properties:{...dbTarget,operation:{type:'string',enum:['insert','update','upsert']},rows:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{values:dbValues,where:dbFields,expected_count:{type:'integer',minimum:1,maximum:100}},required:['values'],additionalProperties:false}}},required:['schema','table','operation','rows'],additionalProperties:false},
      annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false}}
  ];
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
  const requestHandler: RequestListener = async (req, res) => {
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
      const ownsiteRequest = path.startsWith('/ownsite/');
      const workerRoute = worker && path.startsWith('/internal/telegram/');
      const workerAuthorized = workerRoute && req.method === 'POST' && !url.search &&
        typeof req.headers.authorization === 'string' &&
        sameSecret(req.headers.authorization, `Bearer ${telegramOptions!.workerToken}`);
      if (!publicAsset && !dashboardAsset && !workerAuthorized && !ownsiteRequest) {
        ip = clientIp(req, trustedCidrs);
        const admission = await admissionQueue.acquire(ip, disconnected.signal);
        if (admission === 'cancelled' || res.destroyed) return;
        if (admission === 'closed') { reply(503, unavailable); return; }
        if (admission === 'limited') { res.setHeader('Retry-After', '1'); reply(429, { code: 'RATE_LIMITED' }); recordRateRejection(ip); return; }
      }
      if (req.headers.host !== expectedHost || (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin)) { await audit(ip, path, 'ORIGIN_DENIED', requestId); reply(403, unavailable); return; }
      if (!local && req.headers['x-forwarded-proto'] !== undefined && req.headers['x-forwarded-proto'] !== 'https') { reply(403, unavailable); return; }
      if (ownsiteRequest) {
        if (!ownsite) { reply(404, unavailable); return; }
        ip = clientIp(req, trustedCidrs);
        if (!ownsiteReads.admit(ip)) { res.setHeader('Retry-After', '60'); reply(429, { code: 'RATE_LIMITED' }); return; }
        if (!(await ownsite.handle(req, res))) reply(404, unavailable);
        return;
      }
      if (path.startsWith('/workspace/api/')) {
        if (!workspace || url.search) { reply(404, unavailable); return; }
        const session = await access.getSession(tokenFromCookie(req));
        if (!session || session.ownerId !== workspace.ownerId) { await audit(ip,path,'WEB_DENIED',requestId); reply(401,unavailable); return; }
        if (req.method === 'GET' && path === '/workspace/api/session') {
          reply(200,{csrf_token:session.csrfToken,...workspace.status()}); return;
        }
        if (req.method === 'GET' && path === '/workspace/api/schema') { reply(200,workspace.uiSchema()); return; }
        if (req.method === 'GET' && path === '/workspace/api/workspace') {
          reply(200,await workspace.executeUi('workspace_get',{},session.ownerId)); return;
        }
        const operation = /^\/workspace\/api\/operations\/([a-z][a-z0-9_]{1,80})$/.exec(path)?.[1];
        if (req.method !== 'POST' || !operation) { reply(404,unavailable); return; }
        if (req.headers.origin !== expectedOrigin || !sameSecret(typeof req.headers['x-csrf-token']==='string'?req.headers['x-csrf-token']:undefined,session.csrfToken)) {
          await audit(ip,path,'CSRF_DENIED',requestId); reply(403,unavailable); return;
        }
        try {
          const result = await workspace.executeUi(operation,await jsonBody(req,16*1024*1024),session.ownerId);
          await audit(ip,path,'OWNER_ALLOWED',requestId); reply(200,result);
        } catch (error) {
          if (error instanceof RegistryError) throw error;
          const result = workspace.error(error); reply(result.status,result.body);
        }
        return;
      }
      if (path === '/workspace' || path.startsWith('/workspace/')) {
        if (!workspace) { reply(404, unavailable); return; }
        await serveWorkspaceWeb(req, res); return;
      }
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
      if (['/dashboard/api/snapshot','/dashboard/api/history','/dashboard/api/compare',
        '/dashboard/api/plan','/dashboard/api/plan/task','/dashboard/api/visibility',
        '/dashboard/api/visibility/project'].includes(path)) {
        const ownerWrite=path === '/dashboard/api/plan/task' || path === '/dashboard/api/visibility/project';
        if (req.method !== (ownerWrite ? 'POST' : 'GET') || !dashboardSnapshot ||
            (path !== '/dashboard/api/compare' && url.search)) { reply(404, unavailable); return; }
        const session = await access.getSession(tokenFromCookie(req));
        if (!session) { await audit(ip,path,'WEB_DENIED',requestId); reply(401,{code:'AUTH_REQUIRED'}); return; }
        if (ownerWrite) {
          const write=path === '/dashboard/api/plan/task' ? dashboardSnapshot.writeTaskPlan : dashboardSnapshot.writeVisibility;
          if (!write) { reply(503,unavailable); return; }
          if (req.headers.origin !== expectedOrigin || !sameSecret(typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,session.csrfToken)) {
            await audit(ip,path,'CSRF_DENIED',requestId); reply(403,unavailable); return;
          }
          try {
            const result=await write(await jsonBody(req,2048));
            await audit(ip,path,'OWNER_ACTION',requestId); reply(200,result);
          } catch(error) {
            const code=error instanceof Error ? error.message : '';
            if (['INVALID_TASK_PLAN','TASK_NOT_FOUND','TASK_PLAN_CONFLICT',
              'INVALID_PROJECT_VISIBILITY','PROJECT_NOT_FOUND','PROJECT_VISIBILITY_CONFLICT'].includes(code))
              reply(code.endsWith('_CONFLICT') ? 409 : code.endsWith('_NOT_FOUND') ? 404 : 400,{code});
            else throw error;
          }
          return;
        }
        if (path === '/dashboard/api/plan') {
          if (!dashboardSnapshot.readPlan) { reply(503,unavailable); return; }
          const tasks=await dashboardSnapshot.readPlan();
          await audit(ip,path,'OWNER_ALLOWED',requestId);
          reply(200,{tasks,csrf_token:session.csrfToken}); return;
        }
        if (path === '/dashboard/api/visibility') {
          if (!dashboardSnapshot.readVisibility) { reply(503,unavailable); return; }
          const projects=await dashboardSnapshot.readVisibility();
          await audit(ip,path,'OWNER_ALLOWED',requestId);
          reply(200,{projects,csrf_token:session.csrfToken,editable:!!dashboardSnapshot.writeVisibility}); return;
        }
        if (path === '/dashboard/api/compare') {
          const keys=[...url.searchParams.keys()];
          if (keys.length!==4 || new Set(keys).size!==4 ||
              !['a_from','a_to','b_from','b_to'].every(key=>url.searchParams.has(key)) ||
              !dashboardSnapshot.compare) { reply(dashboardSnapshot.compare ? 400 : 503,
                dashboardSnapshot.compare ? {code:'INVALID_PERIOD'} : unavailable); return; }
          try {
            const result=await dashboardSnapshot.compare(
              {from:url.searchParams.get('a_from')!,to:url.searchParams.get('a_to')!},
              {from:url.searchParams.get('b_from')!,to:url.searchParams.get('b_to')!});
            await audit(ip,path,'OWNER_ALLOWED',requestId); reply(200,result);
          } catch(error) {
            const code=error instanceof Error ? error.message : '';
            if (['INVALID_PERIOD','PERIODS_OVERLAP','PERIOD_TOO_LONG'].includes(code)) reply(400,{code});
            else throw error;
          }
          return;
        }
        const value=path === '/dashboard/api/history'
          ? await dashboardSnapshot.dates?.() : await dashboardSnapshot.read();
        if (!value) { reply(503,unavailable); return; }
        await audit(ip,path,'OWNER_ALLOWED',requestId);
        reply(200,value); return;
      }
      if (path === '/dashboard' || path.startsWith('/dashboard/')) {
        await serveDashboardWeb(req, res); return;
      }
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
        const credential = await access.authenticateLogin(parseMcpLogin(req.url ?? ''));
        await audit(ip, path, credential ? 'MCP_ALLOWED' : 'MCP_DENIED', requestId, credential?.id);
        const largeSnapshotTools = credential ? [
          ...(dashboardMigration?.credentialId===credential.id.toLowerCase()?['install_dashboard_snapshot']:[]),
          ...(dashboardWriter?.credentialId===credential.id.toLowerCase()?['update_dashboard_snapshot']:[]),
          ...(workspace?['workspace_artifact_add','workspace_artifact_version_create','workspace_save_run_result']:[])
        ] : [];
        const body = await jsonBody(req, credential && worker ? 10 * 1024 * 1024 :
          workspace && credential ? 16*1024*1024 : largeSnapshotTools.length ? SNAPSHOT_MCP_BODY_BYTES : DEFAULT_JSON_BODY_BYTES,
          credential && worker ? undefined : largeSnapshotTools);
        const mcp = new Server({ name: 'ycs-gateway', version: '0.17.0' }, { capabilities: { tools: {}, ...(workspace ? { resources: {} } : {}) } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
          ...definitions,...(credential?[storageAccessTool]:[]),
          ...(credential && dashboardMigration?.credentialId===credential.id.toLowerCase()?[migrationTool]:[]),
          ...(credential && dashboardWriter?.credentialId===credential.id.toLowerCase()?[snapshotStateTool,updateSnapshotTool]:[]),
          ...(credential && databaseTools?.credentialId===credential.id.toLowerCase()?databaseToolDefinitions:[]),
          ...(credential && ownsite?.credentialId===credential.id.toLowerCase()?ownsite.toolDefinitions:[]),
          ...(credential && telegramCollector?.credentialId===credential.id.toLowerCase()?telegramCollectorToolDefinitions:[]),
          ...(credential && workspace ? [workspaceProjectsTool, ...workspace.definitions.map(tool => workspaceAppOperations.has(tool.name) ? { ...tool, _meta: { ui: { visibility: ['model', 'app'] } } } : tool)] : [])
        ] }));
        if (workspace) {
          mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: credential ? workspaceResources : [] }));
          mcp.setRequestHandler(ReadResourceRequestSchema, async request => {
            if (!credential || request.params.uri !== workspaceResourceUri)
              throw new McpError(ErrorCode.InvalidParams, 'Resource unavailable');
            return readWorkspaceResource();
          });
        }
        mcp.setRequestHandler(CallToolRequestSchema, async request => {
          if (!credential) return { isError: true, content: [{ type: 'text', text: JSON.stringify(unavailable) }], structuredContent: unavailable };
          if (request.params.name.startsWith('workspace_')) {
            if (!workspace) return {isError:true,content:[{type:'text',text:JSON.stringify(unavailable)}],structuredContent:unavailable};
            if (request.params.name === workspaceProjectsTool.name)
              return workspace.callMcp('workspace_workspace_get', request.params.arguments ?? {}, credential.id);
            return workspace.callMcp(request.params.name,request.params.arguments ?? {},credential.id);
          }
          try {
            let value: object;
            if (telegramCollectorToolDefinitions.some(tool => tool.name === request.params.name)) {
              if (!telegramCollector || telegramCollector.credentialId !== credential.id.toLowerCase()) throw new RegistryError('FORBIDDEN',403,'Forbidden');
              if (request.params.name === 'telegram_collector_status') {
                z.strictObject({}).parse(request.params.arguments ?? {});
                value = await telegramCollector.status();
              } else value = await telegramCollector.readEvents(request.params.arguments ?? {});
            }
            else if (request.params.name.startsWith('ownsite_')) {
              if (!ownsite || ownsite.credentialId !== credential.id.toLowerCase()) throw new RegistryError('FORBIDDEN',403,'Forbidden');
              value = await ownsite.callTool(request.params.name, request.params.arguments ?? {}, credential.id);
              if (request.params.name === 'ownsite_update_work') await audit(ip, path, 'OWNSITE_WRITE', requestId, credential.id);
            }
            else if (request.params.name === 'get_dashboard_storage_access') {
              z.strictObject({}).parse(request.params.arguments ?? {});
              value={credential_id:credential.id,migration_enabled:!!dashboardMigration,
                updates_enabled:!!dashboardWriter,
                permitted_for_migration:!!dashboardMigration && dashboardMigration.credentialId===credential.id.toLowerCase(),
                permitted_for_updates:!!dashboardWriter && dashboardWriter.credentialId===credential.id.toLowerCase(),
                ...(workspace ? {workspace:workspace.status()} : {})};
            }
            else if (request.params.name === 'install_dashboard_snapshot') {
              if (!dashboardMigration || dashboardMigration.credentialId!==credential.id.toLowerCase())
                throw new RegistryError('FORBIDDEN',403,'Forbidden');
              value=await dashboardMigration.apply(request.params.arguments);
            }
            else if (request.params.name === 'get_dashboard_snapshot_state' || request.params.name === 'update_dashboard_snapshot') {
              if (!dashboardWriter || dashboardWriter.credentialId!==credential.id.toLowerCase())
                throw new RegistryError('FORBIDDEN',403,'Forbidden');
              if (request.params.name==='get_dashboard_snapshot_state') {
                z.strictObject({}).parse(request.params.arguments ?? {});
                value=await dashboardWriter.readState();
              } else value=await dashboardWriter.update(request.params.arguments);
            }
            else if (databaseToolDefinitions.some(tool => tool.name === request.params.name)) {
              if (!databaseTools || databaseTools.credentialId !== credential.id.toLowerCase())
                throw new RegistryError('FORBIDDEN',403,'Forbidden');
              if (request.params.name === 'read_database') value = await databaseTools.readDatabase(request.params.arguments);
              else {
                value = await databaseTools.writeRows(request.params.arguments);
                await audit(ip, path, 'DATABASE_WRITE', requestId, credential.id);
              }
            }
            else if (telegram && request.params.name === 'get_publisher_status') { z.strictObject({}).parse(request.params.arguments ?? {}); value = await telegram.status(); }
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
              } else if (typeof args?.text === 'string' && args.text.startsWith(TEXT_ONLY_PREFIX)) {
                const input = publishInputSchema.parse(args);
                value = await worker.publishTextOnly(queuedTextOnlyInputSchema.parse({ ...input,
                  text: input.text.slice(TEXT_ONLY_PREFIX.length) }));
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
            const migrationErrors=['DASHBOARD_MIGRATION_INPUT_INVALID','DASHBOARD_SNAPSHOT_TOO_LARGE',
              'DASHBOARD_DATABASE_ROLES_REQUIRED','DASHBOARD_SNAPSHOT_ALREADY_INITIALIZED','DASHBOARD_READBACK_FAILED',
              'DASHBOARD_WRITER_ROLE_INVALID','DASHBOARD_INITIAL_SNAPSHOT_REQUIRED',
              'DASHBOARD_UPDATE_INPUT_INVALID'];
            const result = error instanceof RegistryError ? { code: error.code, ...(error.details ? { details: error.details } : {}) } :
              { code: error instanceof DatabaseToolError || error instanceof TelegramCollectorError ? error.code : error instanceof z.ZodError ? 'VALIDATION_ERROR' :
                error instanceof Error && migrationErrors.includes(error.message) ? error.message :
                databaseToolDefinitions.some(tool => tool.name === request.params.name) ? databaseFailureCode(error) ?? 'SERVICE_UNAVAILABLE' :
                'SERVICE_UNAVAILABLE' };
            if (result.code === 'SERVICE_UNAVAILABLE' && diagnosticReadTools.has(request.params.name)) {
              const suffix = safeStartupCode(error);
              Object.assign(result, { diagnostic_code: suffix.slice(' code='.length) });
              // Names are restricted above; never log arguments, evidence text or driver messages.
              console.error(`MCP_READ_FAILED tool=${request.params.name}${suffix}`);
            }
            if (result.code==='DASHBOARD_SNAPSHOT_TOO_LARGE' && error instanceof Error && 'details' in error &&
                error.details && typeof error.details==='object')
              Object.assign(result,{details:error.details});
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
  };
  const http = startupListener?.server ?? createServer({ maxHeaderSize: 16 * 1024 }, requestHandler);
  http.maxConnections = 64; http.requestTimeout = 15_000; http.headersTimeout = 10_000;
  // Raw HTTP parser errors can contain a request URL: intentionally discard them.
  if (!startupListener) {
    http.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => { http.off('error', reject); resolve(); }); });
  }
  mail.start();
  startupListener?.activate(requestHandler);
  const url = local ? `http://127.0.0.1:${(http.address() as { port: number }).port}` : origin;
  let closing: Promise<void> | undefined;
  return { url, access, registry, close: () => closing ??= (async () => {
    admissionQueue.close();
    await mail.stop();
    await telegram?.stop();
    if (startupListener) await startupListener.close();
    else await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeIdleConnections(); });
    await admissionQueue.drained(); await Promise.all(rateLogs);
  })() };
}

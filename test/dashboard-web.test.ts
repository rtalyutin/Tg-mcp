import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type pg from 'pg';
import { startLocalOutreach } from '../src/outreach/server.ts';

// Use the raw HTTP path so traversal and empty-query fixtures reach the server
// unchanged; fetch/URL normalize some of these before making a request.
function request(base: string, path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = httpRequest(base, { path, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function controlledApp() {
  let admissionChecks = 0, sessionChecks = 0, credentialChecks = 0;
  const { createDashboardHandler } = await import(new URL('../dashboard/src/http-gateway.mjs', import.meta.url).href);
  const token = 'synthetic-dashboard-web-authorization-token';
  const unexpectedDatabaseAccess = async () => { throw new Error('No business data belongs in this public UI fixture'); };
  const dashboard = createDashboardHandler({ query: unexpectedDatabaseAccess, transaction: unexpectedDatabaseAccess }, token);
  const app = await startLocalOutreach({ pool: {} as pg.Pool, dashboard });
  app.access.admitIp = async () => { admissionChecks++; return { allowed: true, retryAfter: 0 }; };
  app.access.recordAccess = async () => {};
  app.access.getSession = async () => { sessionChecks++; return null; };
  app.access.authenticateLogin = async () => { credentialChecks++; return null; };
  return { app, token, dashboard, counters: () => ({ admissionChecks, sessionChecks, credentialChecks }) };
}

test('Outreach health handles exact GET/HEAD; query variants use normal admission',async t=>{
  let snapshotState:'ok'|'failed'='ok';
  let throwHealth=false;
  const checks=()=>({database:'ok' as const,dashboard_schema:'ok' as const,snapshot_reader:snapshotState,
    snapshot_writer:'not_configured' as const,dashboard_assets:'ok' as const,dashboard_mcp:'not_configured' as const});
  const app=await startLocalOutreach({pool:{} as pg.Pool,healthCheck:async()=>{
    if (throwHealth) throw new Error('private database URL');
    return {status:snapshotState==='ok'?'ok':'unhealthy',checks:checks()};
  }});
  t.after(async()=>app.close());
  let admissionChecks=0;
  app.access.admitIp=async()=>{admissionChecks++;return {allowed:true,retryAfter:0};};
  const healthy=await request(app.url,'/healthz');
  assert.equal(healthy.status,200);
  assert.equal(admissionChecks,0);
  assert.deepEqual(JSON.parse(healthy.body.toString()).checks,checks());
  const head=await request(app.url,'/healthz','HEAD');
  assert.equal(head.status,200);assert.equal(head.body.length,0);
  assert.equal(head.headers['content-length'],healthy.headers['content-length']);

  snapshotState='failed';
  const unhealthy=await request(app.url,'/healthz');
  assert.equal(unhealthy.status,503);
  assert.equal(admissionChecks,0);
  assert.equal(JSON.parse(unhealthy.body.toString()).status,'unhealthy');
  assert.equal(JSON.parse(unhealthy.body.toString()).checks.snapshot_reader,'failed');
  const unhealthyHead=await request(app.url,'/healthz','HEAD');
  assert.equal(unhealthyHead.status,503);assert.equal(unhealthyHead.body.length,0);
  throwHealth=true;
  const failedProbe=await request(app.url,'/healthz');
  assert.equal(failedProbe.status,503);
  assert.doesNotMatch(failedProbe.body.toString(),/private database URL/);
  assert.equal(JSON.parse(failedProbe.body.toString()).checks.database,'unknown');
  assert.equal((await request(app.url,'/healthz?x=1')).status,404);
  assert.equal(admissionChecks,1,'query-bearing paths follow ordinary admission');
  const method=await request(app.url,'/healthz','POST');
  assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, HEAD');
  assert.equal(admissionChecks,1);
});

test('dashboard HTML, modules, CSS, SVG and fonts are public static assets under the existing gateway', async t => {
  const fixture = await controlledApp();
  t.after(async () => { await fixture.app.close(); await fixture.dashboard.close(); });
  const { app } = fixture;
  const html = await request(app.url, '/dashboard/');
  assert.equal(html.status, 200);
  assert.match(String(html.headers['content-type']), /^text\/html/);
  assert.match(html.body.toString(), /Следующий ход/);
  assert.match(html.body.toString(), /<script\b[^>]*\btype=["']module["'][^>]*>/);
  assert.doesNotMatch(html.body.toString(), /<script\b(?![^>]*\bsrc=)[^>]*>|\bon[a-z]+\s*=/i);
  const csp = String(html.headers['content-security-policy']);
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal(html.headers['x-content-type-options'], 'nosniff');
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  assert.equal(Number(html.headers['content-length']), html.body.length);
  const cases = [
    ['/dashboard/dashboard.css', 'text/css'],
    ['/dashboard/dashboard.js', 'text/javascript'],
    ['/dashboard/demo-data.js', 'text/javascript'],
    ['/dashboard/assets/logo.svg', 'image/svg+xml'],
    ['/dashboard/assets/roboto-cyrillic.woff2', 'font/woff2'],
  ];
  for (const [path, type] of cases) {
    const response = await request(app.url, path);
    assert.equal(response.status, 200, path);
    assert.ok(String(response.headers['content-type']).startsWith(type), path);
    assert.ok(response.body.length > 20, path);
    assert.equal(Number(response.headers['content-length']), response.body.length, path);
    const head = await request(app.url, path, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.equal(head.body.length, 0, path);
    assert.equal(head.headers['content-length'], response.headers['content-length'], path);
  }
  const head = await request(app.url, '/dashboard/', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], html.headers['content-length']);
  const redirect = await request(app.url, '/dashboard');
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, '/dashboard/');
  assert.deepEqual(fixture.counters(), { admissionChecks: 0, sessionChecks: 0, credentialChecks: 0 }, 'no database admission or authentication is needed for exact public demo assets');
});

test('dashboard files cannot bypass Host/Origin checks or expose arbitrary paths, query strings and methods', async t => {
  const fixture = await controlledApp();
  t.after(async () => { await fixture.app.close(); await fixture.dashboard.close(); });
  const { app } = fixture;
  const disallowedHeaders: Record<string, string>[] = [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }];
  for (const headers of disallowedHeaders) {
    const denied = await request(app.url, '/dashboard/', 'GET', headers);
    assert.equal(denied.status, 403); assert.doesNotMatch(denied.body.toString(), /Следующий ход/);
  }
  assert.equal(fixture.counters().admissionChecks, 0);
  const paths = [
    '/dashboard?login=must-not-be-reflected', '/dashboard/?',
    '/dashboard/dashboard.css?x=1', '/dashboard/assets/../dashboard.css',
    '/dashboard/assets/%2e%2e/dashboard.js', '/dashboard/%69ndex.html',
    '/dashboard/package.json', '/dashboard/assets/license.txt', '/dashboard/assets/missing.svg',
    '/dashboard/src/http-gateway.mjs', '/dashboard/mcp/',
  ];
  for (const path of paths) {
    const denied = await request(app.url, path);
    assert.equal(denied.status, 404, path);
    assert.equal(denied.headers.location, undefined, path);
    assert.doesNotMatch(denied.body.toString(), /must-not-be-reflected|Следующий ход|DATABASE_URL|createDashboardHandler/, path);
  }
  for (const method of ['POST', 'PUT', 'OPTIONS']) {
    const denied = await request(app.url, '/dashboard/dashboard.js', method);
    assert.equal(denied.status, 405, method); assert.equal(denied.headers.allow, 'GET, HEAD');
  }
  assert.equal(fixture.counters().admissionChecks, paths.length + 3, 'invalid routes and methods retain database admission');
  assert.equal(fixture.counters().sessionChecks, 0);
});

test('public dashboard does not weaken v1/v2 MCP authorization or admission and leaves the registry protected', async t => {
  const fixture = await controlledApp();
  t.after(async () => { await fixture.app.close(); await fixture.dashboard.close(); });
  const { app, token } = fixture;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_companies', arguments: {} } });
  const denied = await request(app.url, '/dashboard/mcp', 'POST', headers, list);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['www-authenticate'], 'Bearer realm="dashboard"');
  assert.doesNotMatch(denied.body.toString(), /read_state/);
  const badToken = await request(app.url, '/dashboard/mcp', 'POST', { ...headers, authorization: 'Bearer not-the-token' }, list);
  assert.equal(badToken.status, 401);
  const allowed = await request(app.url, '/dashboard/mcp', 'POST', { ...headers, authorization: `Bearer ${token}` }, list);
  assert.equal(allowed.status, 200);
  const tools = JSON.parse(allowed.body.toString()).result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(tools.includes('read_state')); assert.ok(!tools.includes('search_companies'));
  const query = await request(app.url, '/dashboard/mcp?login=anything', 'POST', { ...headers, authorization: `Bearer ${token}` }, list);
  assert.equal(query.status, 404);
  const v1 = await request(app.url, '/mcp', 'POST', headers, call);
  assert.equal(v1.status, 200);
  assert.equal(JSON.parse(v1.body.toString()).result.isError, true);
  const registry = await request(app.url, '/api/v1/companies');
  assert.equal(registry.status, 503);
  assert.deepEqual(fixture.counters(), { admissionChecks: 6, sessionChecks: 1, credentialChecks: 1 });
  assert.ok(!String(v1.headers['content-security-policy']).includes("connect-src 'none'"), 'dashboard CSP remains isolated from the registry');
});

test('partial snapshot is returned only with a valid owner session, never as a public asset', async t => {
  const payload = { schema:'dashboard-curated-snapshot/1', coverage:'partial', projects:[{id:'work',title:'Работа'}], tasks:[] };
  let reads = 0, checked = 0;
  const app = await startLocalOutreach({pool:{} as pg.Pool, dashboardSnapshot:{
    read:async()=>{ reads++; return payload; },close:async()=>{}
  }});
  t.after(async()=>{ await app.close(); });
  app.access.admitIp=async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess=async()=>{};
  app.access.getSession=async token=>{ checked++; return token==='valid' ? {ownerId:'owner',csrfToken:'csrf'} : null; };
  assert.equal((await request(app.url,'/dashboard/api/snapshot')).status,401);
  assert.equal((await request(app.url,'/dashboard/api/snapshot','GET',{cookie:'ycs_session=invalid'})).status,401);
  assert.equal(reads,0);
  assert.equal((await request(app.url,'/dashboard/api/snapshot?x=1','GET',{cookie:'ycs_session=valid'})).status,404);
  const valid=await request(app.url,'/dashboard/api/snapshot','GET',{cookie:'ycs_session=valid'});
  assert.equal(valid.status,200);
  assert.deepEqual(JSON.parse(valid.body.toString()),payload);
  assert.equal(valid.headers['cache-control'],'no-store');
  assert.equal(reads,1);assert.equal(checked,3);
});

test('YCS MCP migration command is visible and callable only by its configured login',async t=>{
  const permitted='14a4d6e9-63b0-44ea-9f45-a6237692aef1';
  const other='68c15837-4b5a-47db-8ced-f10aae51e0dc';
  let calls=0,updates=0;
  const app=await startLocalOutreach({pool:{} as pg.Pool,dashboardMigration:{credentialId:permitted,
    apply:async()=>{calls++;return {schema_version:4,verified:true};}},dashboardWriter:{credentialId:permitted,
    readState:async()=>({digest:'0'.repeat(64),coverage:'partial'}),
    update:async()=>{updates++;return {readback_verified:true};}}});
  t.after(async()=>app.close());
  app.access.admitIp=async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess=async()=>{};
  app.access.authenticateLogin=async secret=>secret==='!!!!!!!!!!!!!!!!' ? {id:permitted} : secret==='################' ? {id:other} : null;
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
  const mcp=(method:string,params:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,method,params});
  const list=async (secret:string)=>JSON.parse((await request(app.url,`/mcp?login=${encodeURIComponent(secret)}`,'POST',headers,mcp('tools/list',{}))).body.toString());
  const mine=await list('!!!!!!!!!!!!!!!!');
  const theirs=await list('################');
  const anonymous=await list('????????????????');
  assert.ok(mine.result.tools.some((tool:{name:string})=>tool.name==='install_dashboard_snapshot'));
  assert.ok(mine.result.tools.some((tool:{name:string})=>tool.name==='update_dashboard_snapshot'));
  assert.deepEqual(mine.result.tools.find((tool:{name:string})=>tool.name==='install_dashboard_snapshot').inputSchema.required,['snapshot']);
  assert.deepEqual(mine.result.tools.find((tool:{name:string})=>tool.name==='update_dashboard_snapshot').inputSchema.required,['snapshot']);
  assert.ok(!theirs.result.tools.some((tool:{name:string})=>tool.name==='install_dashboard_snapshot'));
  assert.ok(!theirs.result.tools.some((tool:{name:string})=>tool.name==='update_dashboard_snapshot'));
  assert.ok(!anonymous.result.tools.some((tool:{name:string})=>tool.name==='install_dashboard_snapshot'));
  const call=mcp('tools/call',{name:'install_dashboard_snapshot',arguments:{snapshot:{}}});
  const denied=JSON.parse((await request(app.url,'/mcp?login=%23%23%23%23%23%23%23%23%23%23%23%23%23%23%23%23','POST',headers,call)).body.toString());
  assert.equal(denied.result.isError,true);
  assert.equal(denied.result.structuredContent.code,'FORBIDDEN');
  const deniedUpdate=JSON.parse((await request(app.url,'/mcp?login=%23%23%23%23%23%23%23%23%23%23%23%23%23%23%23%23','POST',headers,
    mcp('tools/call',{name:'update_dashboard_snapshot',arguments:{snapshot:{}}}))).body.toString());
  assert.equal(deniedUpdate.result.structuredContent.code,'FORBIDDEN');
  assert.equal(calls,0);
  const allowed=JSON.parse((await request(app.url,'/mcp?login=!!!!!!!!!!!!!!!!','POST',headers,call)).body.toString());
  assert.equal(allowed.result.structuredContent.verified,true);
  assert.equal(calls,1);
  const updated=JSON.parse((await request(app.url,'/mcp?login=!!!!!!!!!!!!!!!!','POST',headers,
    mcp('tools/call',{name:'update_dashboard_snapshot',arguments:{snapshot:{}}}))).body.toString());
  assert.equal(updated.result.structuredContent.readback_verified,true);assert.equal(updates,1);
  const access=JSON.parse((await request(app.url,'/mcp?login=!!!!!!!!!!!!!!!!','POST',headers,
    mcp('tools/call',{name:'get_dashboard_storage_access',arguments:{}}))).body.toString());
  assert.deepEqual(access.result.structuredContent,{credential_id:permitted,migration_enabled:true,updates_enabled:true,
    permitted_for_migration:true,permitted_for_updates:true});
});

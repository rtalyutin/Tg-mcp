import {createHash,timingSafeEqual} from 'node:crypto';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {createDashboardMcpServer} from './mcp-server.mjs';
import {connectPostgres} from './postgres.mjs';
import {verifySchema} from './migrate.mjs';
import {verifyRuntimePrivileges} from './runtime-privileges.mjs';

export const DASHBOARD_PATH='/dashboard/mcp';
const MAX_BODY_BYTES=1_100_000;

export function validateDashboardConfig(env) {
  if (env.DASHBOARD_ENABLED === undefined || env.DASHBOARD_ENABLED === 'false') return null;
  if (env.DASHBOARD_ENABLED !== 'true') throw new Error('DASHBOARD_CONFIG_INVALID');
  const token=env.DASHBOARD_BEARER_TOKEN;
  if (typeof token!=='string' || token.length<32 || token.length>4096 || /\s/.test(token))
    throw new Error('DASHBOARD_CONFIG_INVALID');
  try {
    const url=new URL(env.DATABASE_URL);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || url.pathname.length<2 || url.hash) throw new Error();
  } catch {throw new Error('DASHBOARD_CONFIG_INVALID');}
  return {token,databaseUrl:env.DATABASE_URL,sharedRole:true};
}

export async function createDashboardGateway(config,{connect=connectPostgres,
  checkSchema=verifySchema,checkPrivileges=verifyRuntimePrivileges}={}) {
  const db=connect(config.databaseUrl);
  try { await checkSchema(db); if (!config.sharedRole) await checkPrivileges(db); }
  catch (error) { await db.close(); throw error; }
  return createDashboardHandler(db,config.token,()=>db.close());
}

/** For synthetic tests; the caller owns the database adapter. */
export function createDashboardHandler(db,token,close=async()=>{}) {
  if (typeof token!=='string' || token.length<32) throw new Error('DASHBOARD_CONFIG_INVALID');
  const expected=createHash('sha256').update(token).digest();
  let stopped=false;
  const response=(res,status,code)=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify({error:code}));
  };
  return {
    async healthCheck({timeoutMs=2000}={}) {
      if (stopped) throw new Error('DASHBOARD_GATEWAY_STOPPED');
      const bounded=Number.isSafeInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=5000 ? timeoutMs : 2000;
      return db.transaction(async tx=>{
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec(`SET LOCAL statement_timeout = ${bounded}`);
        await tx.query('SELECT 1');
      },{timeoutMs:bounded});
    },
    async handle(req,res) {
      if (stopped) { response(res,503,'SERVICE_UNAVAILABLE'); return; }
      // The parent HTTP gateway verifies Host, Origin and HTTPS before calling this handler.
      const headers=req.rawHeaders;
      const authCount=headers.filter((h,i)=>i%2===0 && h.toLowerCase()==='authorization').length;
      const value=req.headers.authorization;
      const candidate=typeof value==='string' && value.startsWith('Bearer ') ? value.slice(7) : '';
      const digest=createHash('sha256').update(candidate).digest();
      if (authCount!==1 || !candidate || !timingSafeEqual(digest,expected)) {
        res.setHeader('WWW-Authenticate','Bearer realm="dashboard"');
        response(res,401,'UNAUTHORIZED'); return;
      }
      if (req.method!=='POST') { res.setHeader('Allow','POST'); response(res,405,'METHOD_NOT_ALLOWED'); return; }
      if (req.headers['content-type']?.split(';')[0].trim()!=='application/json') { response(res,415,'JSON_REQUIRED'); return; }
      if (Number(req.headers['content-length']??0)>MAX_BODY_BYTES) { response(res,413,'BODY_TOO_LARGE'); return; }
      let body;
      try {
        const chunks=[];let size=0;
        for await (const chunk of req) {
          size+=chunk.length;
          if(size>MAX_BODY_BYTES) { response(res,413,'BODY_TOO_LARGE'); return; }
          chunks.push(chunk);
        }
        body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
        if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error('INVALID_JSON');
      } catch { if (!res.headersSent) response(res,400,'INVALID_JSON'); return; }
      const server=createDashboardMcpServer(db);
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      try { await server.connect(transport); await transport.handleRequest(req,res,body); }
      catch { if (!res.headersSent) response(res,503,'SERVICE_UNAVAILABLE'); else if (!res.writableEnded) res.end(); }
      finally { await transport.close().catch(()=>{}); await server.close().catch(()=>{}); }
    },
    async close() { stopped=true; await close(); }
  };
}

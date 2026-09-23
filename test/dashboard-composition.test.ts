import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { startLocalOutreach } from '../src/outreach/server.ts';

test('one outreach process routes v1 and v2 MCP independently',async()=>{
  const {migrate}=await import(new URL('../dashboard/src/migrate.mjs',import.meta.url).href);
  const {createDashboardHandler}=await import(new URL('../dashboard/src/http-gateway.mjs',import.meta.url).href);
  const db=new PGlite();await migrate(db);
  const token='synthetic-composition-token-2026-09-23';
  const dashboard=createDashboardHandler(db,token);
  const app=await startLocalOutreach({pool:{} as pg.Pool,dashboard});
  app.access.admitIp=async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess=async()=>{};
  app.access.authenticateLogin=async()=>null;
  const request=(path:string,auth?:string)=>fetch(app.url+path,{
    method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
      ...(auth?{authorization:`Bearer ${auth}`}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}),
  });
  try {
    const denied=await request('/dashboard/mcp');
    assert.equal(denied.status,401);
    assert.doesNotMatch(await denied.text(),/read_state|apply_change_batch/);
    const telegram=await request('/mcp');
    assert.equal(telegram.status,200);
    const telegramTools=(await telegram.json()).result.tools.map((tool:{name:string})=>tool.name);
    assert.ok(telegramTools.includes('search_companies'));
    assert.ok(!telegramTools.includes('read_state'));
    const personal=await request('/dashboard/mcp',token);
    assert.equal(personal.status,200);
    const personalTools=(await personal.json()).result.tools.map((tool:{name:string})=>tool.name);
    assert.ok(personalTools.includes('read_state'));
    assert.ok(!personalTools.includes('search_companies'));
    assert.equal((await request('/dashboard/mcp?login=anything',token)).status,404);
  } finally { await app.close();await dashboard.close();await db.close(); }
});

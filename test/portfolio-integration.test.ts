import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createOwnsiteGateway } from '../src/ownsite/gateway.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { PublicReadLimit } from '../src/outreach/public-read-limit.ts';

const owner = '14a4d6e9-63b0-44ea-9f45-a6237692aef1';
const other = '68c15837-4b5a-47db-8ced-f10aae51e0dc';
test('mounted portfolio public reads and protected MCP edits remain isolated', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const query = async (sql:string, params?:unknown[]) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect:async()=>({ query,release(){} }) } as unknown as Pool;
  const ownsite = await createOwnsiteGateway(pool,owner,{phone:undefined,email:undefined});
  const app = await startLocalOutreach({pool,ownsite});
  t.after(()=>app.close());
  app.access.admitIp = async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess = async()=>{};
  app.access.authenticateLogin = async secret => secret==='!!!!!!!!!!!!!!!!' ? {id:owner} : secret==='################' ? {id:other} : null;
  const call = async (login:string, method:string, params:object) => {
    const response = await fetch(`${app.url}/mcp?login=${encodeURIComponent(login)}`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return (await response.json()).result;
  };
  // Public reading must not use the 1/sec MCP admission queue shared by SSR IPs.
  const admitted = app.access.admitIp;
  app.access.admitIp = async()=>{ throw new Error('MCP admission should not serve portfolio'); };
  const responses = await Promise.all(Array.from({length:6},()=>fetch(app.url+'/ownsite/api/works')));
  assert.ok(responses.every(res=>res.status===200));
  const works = await responses[0].json();
  assert.deepEqual(works.map((row:{slug:string})=>row.slug),['ycs','dashboard']);
  assert.ok(works.every((row:object)=>!('show' in row)));
  assert.equal((await fetch(app.url+'/ownsite/api/works/stories')).status,404);
  assert.equal((await fetch(app.url+'/ownsite/api/works',{method:'POST',body:'{}'})).status,405);
  assert.equal((await fetch(app.url+'/ownsite/api/works?schema=workspace')).status,400);
  assert.equal((await fetch(app.url+'/ownsite/api/works',{headers:{origin:'https://attacker.example'}})).status,403);
  assert.deepEqual(await (await fetch(app.url+'/ownsite/api/contacts')).json(),[
    {label:'Позвонить',href:'tel:+79065253445'}, {label:'Написать письмо',href:'mailto:info@yarcyberseason.ru'}
  ]);
  app.access.admitIp = admitted;
  const ownTools = (await call('!!!!!!!!!!!!!!!!','tools/list',{})).tools;
  assert.ok(ownTools.some((tool:{name:string})=>tool.name==='ownsite_update_work'));
  const otherTools = (await call('################','tools/list',{})).tools;
  assert.ok(!otherTools.some((tool:{name:string})=>tool.name.startsWith('ownsite_')));
  for (const login of ['################','']) {
    const result = await call(login,'tools/call',{name:'ownsite_update_work',arguments:{id:'ycs',patch:{show:false}}});
    assert.equal(result.isError,true);
  }
  assert.equal((await fetch(app.url+'/ownsite/api/works/ycs')).status,200);
  const hidden = await call('!!!!!!!!!!!!!!!!','tools/call',{name:'ownsite_update_work',arguments:{id:'ycs',patch:{show:false}}});
  assert.notEqual(hidden.isError,true);
  assert.equal((await fetch(app.url+'/ownsite/api/works/ycs')).status,404);
  assert.equal((await call('!!!!!!!!!!!!!!!!','tools/call',{name:'ownsite_update_work',arguments:{id:'ycs',patch:{show:true}}})).isError,undefined);
  const head = await fetch(app.url+'/ownsite/api/works',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('public read limiter bounds memory and resets without affecting MCP admission',()=>{
  const limit = new PublicReadLimit(2,2);
  assert.equal(limit.admit('ip-a',0),true);assert.equal(limit.admit('ip-a',1),true);
  assert.equal(limit.admit('ip-a',2),false);assert.equal(limit.admit('ip-b',3),true);
  assert.equal(limit.admit('ip-c',4),false);assert.equal(limit.admit('ip-c',60000),true);
});

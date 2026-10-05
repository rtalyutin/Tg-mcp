import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { Pool } from 'pg';
import { startStartupHttpListener } from '../src/startup-http.ts';
import { startOutreachGateway } from '../src/outreach/server.ts';
import { readOutreachConfig } from '../src/outreach/config.ts';
import type { TelegramCollectorGateway } from '../src/telegram-collector/gateway.ts';

test('startup hands the same socket to the production gateway and preserves owner-only MCP reads', async t => {
  let databaseReads = 0, collectorReads = 0;
  const pool = {query:async()=>{ databaseReads++; throw new Error('Unexpected fixture database access'); }} as unknown as Pool;
  const listener = await startStartupHttpListener(0);
  t.after(()=>listener.close());
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '0.0.0.0');
  const base = `http://127.0.0.1:${address.port}`;
  const owner = '14a4d6e9-63b0-44ea-9f45-a6237692aef1';
  const request = (login: string) => new Promise<Pick<Response, 'status'|'json'>>((resolve, reject) => {
    const req = httpRequest(`${base}/mcp?login=${encodeURIComponent(login)}`, {
      method:'POST', headers:{host:'example.test','content-type':'application/json',accept:'application/json, text/event-stream'},
    }, res => {
      let body=''; res.setEncoding('utf8'); res.on('data',chunk=>body+=chunk); res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode ?? 0,json:async()=>JSON.parse(body)}));
    });
    req.on('error',reject);
    req.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'telegram_collector_status',arguments:{}}}));
  });
  const pending = await request('!!!!!!!!!!!!!!!!');
  assert.equal(pending.status, 503); assert.deepEqual(await pending.json(), {code:'SERVICE_UNAVAILABLE'});
  assert.equal(databaseReads, 0);
  const config = readOutreachConfig({MCP_PUBLIC_ORIGIN:'https://example.test',DATABASE_URL:'postgresql://fixture@127.0.0.1/unused',PORT:String(address.port)});
  const app = await startOutreachGateway({config,pool,startupListener:listener,telegramCollector:{
    credentialId:owner,status:async()=>{collectorReads++;return {fixture:'ready'};},
  } as unknown as TelegramCollectorGateway});
  t.after(()=>app.close());
  app.access.admitIp = async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess = async()=>{};
  app.access.authenticateLogin = async login=>login==='!!!!!!!!!!!!!!!!'?{id:owner}:null;
  assert.deepEqual(listener.server.address(), address);
  assert.equal(listener.server.listenerCount('request'), 1);
  assert.equal(listener.server.listenerCount('clientError'), 1);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), {status:'ok'});
  const denied = await request('%%%%%%%%%%%%%%%%');
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).result.isError, true);
  assert.equal(collectorReads, 0);
  const allowed = await request('!!!!!!!!!!!!!!!!');
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).result.structuredContent, {fixture:'ready'});
  assert.equal(collectorReads, 1); assert.equal(databaseReads, 0);
  assert.throws(()=>listener.activate(()=>{}));
  await app.close(); await app.close(); await listener.close();
  assert.throws(()=>listener.activate(()=>{}));
  await assert.rejects(fetch(`${base}/healthz`));
});

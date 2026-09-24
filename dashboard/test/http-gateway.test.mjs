import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createDashboardHandler,createDashboardGateway,validateDashboardConfig} from '../src/http-gateway.mjs';
import {migrate} from '../src/migrate.mjs';

test('Dashboard HTTP MCP denies unauthenticated callers and serves v2 tools with a bearer',async()=>{
  const db=new PGlite();await migrate(db);
  const secret='synthetic-dashboard-token-for-test-only-2026';
  const gateway=createDashboardHandler(db,secret);
  const server=createServer((req,res)=>void gateway.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=new URL(`http://127.0.0.1:${server.address().port}/dashboard/mcp`);
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'probe',version:'1'}}});
  const post=(headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body});
  const client=new Client({name:'dashboard-http-test',version:'1'},{versionNegotiation:{mode:'auto'}});
  try {
    for(const headers of [{},{authorization:'Bearer wrong'},{authorization:`Bearer ${secret}, Bearer wrong`}]) {
      const response=await post(headers);
      assert.equal(response.status,401);
      assert.equal((await response.text()).includes('read_state'),false);
    }
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${secret}`}}}));
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),
      ['apply_change_batch','begin_collection_run','complete_source','finalize_run','read_state','verify_change_batch']);
    const result=await client.callTool({name:'read_state',arguments:{sourceId:'11111111-1111-4111-8111-111111111111'}});
    assert.equal(result.isError,true);
  } finally {
    await client.close().catch(()=>{});
    await new Promise(resolve=>server.close(resolve));
    await gateway.close();await db.close();
  }
});

test('Dashboard stays off without explicit valid opt-in',()=>{
  assert.equal(validateDashboardConfig({}),null);
  assert.throws(()=>validateDashboardConfig({DASHBOARD_ENABLED:'true',DATABASE_URL:'postgres://local/db',DASHBOARD_BEARER_TOKEN:'short'}),/DASHBOARD_CONFIG_INVALID/);
  const token='synthetic-dashboard-token-for-test-only-2026';
  assert.throws(()=>validateDashboardConfig({DASHBOARD_ENABLED:'true',DATABASE_URL:'postgres://local/db',
    DASHBOARD_DATABASE_URL:'postgres://local/db',DASHBOARD_BEARER_TOKEN:token}),/DASHBOARD_CONFIG_INVALID/);
  assert.deepEqual(validateDashboardConfig({DASHBOARD_ENABLED:'true',DATABASE_URL:'postgres://outreach/db',
    DASHBOARD_DATABASE_URL:'postgres://dashboard/db',DASHBOARD_BEARER_TOKEN:token}),
    {token,databaseUrl:'postgres://dashboard/db'});
});

test('Dashboard startup closes its connection and exposes no route on schema or role failure',async()=>{
  for (const failing of ['schema','role']) {
    let closed=false,roleChecked=false;
    const db={close:async()=>{closed=true;}};
    await assert.rejects(createDashboardGateway({databaseUrl:'postgres://dashboard/db',token:'x'.repeat(32)},
      {connect:()=>db,checkSchema:async()=>{if(failing==='schema') throw new Error('STALE_SCHEMA');},
        checkPrivileges:async()=>{roleChecked=true;if(failing==='role') throw new Error('ROLE_TOO_BROAD');}}),
    failing==='schema'?/STALE_SCHEMA/:/ROLE_TOO_BROAD/);
    assert.equal(closed,true);
    assert.equal(roleChecked,failing==='role');
  }
});

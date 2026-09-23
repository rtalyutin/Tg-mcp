import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {migrate} from '../src/migrate.mjs';
import {registerSource,beginRun} from '../src/ingest.mjs';
import {createDashboardMcpServer,MCP_LIMITS} from '../src/mcp-server.mjs';

let db,server,client;
const ids={sourceId:randomUUID(),chatSourceId:randomUUID(),runId:randomUUID()};
before(async()=>{
  db=new PGlite(); await migrate(db);
  await registerSource(db,{id:ids.sourceId,kind:'codex',externalScope:'mcp-in-memory'});
  await registerSource(db,{id:ids.chatSourceId,kind:'chatgpt',externalScope:'mcp-in-memory-chat'});
  await beginRun(db,[ids.sourceId,ids.chatSourceId],ids.runId);
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  server={transport:serverTransport,instance:createDashboardMcpServer(db)};
  client={transport:clientTransport,instance:new Client({name:'dashboard-test',version:'0.2.0'},{versionNegotiation:{mode:'auto'}})};
  await server.instance.connect(server.transport);
  await client.instance.connect(client.transport);
});
after(async()=>{await client.instance.close();await server.instance.close();await db.close();});

const batch=()=>({sourceId:ids.sourceId,runId:ids.runId,batchKey:'mcp-packet-1',baseVersion:0,cursorAfter:{page:2},events:[{
  nativeId:'m-1',revision:'r-1',threadId:'t-1',occurredAt:'2026-09-21T10:00:00Z',payload:{text:'synthetic'}
}]});

test('MCP exposes the import and run-lifecycle tools with schemas',async()=>{
  const {tools}=await client.instance.listTools();
  assert.deepEqual(tools.map(x=>x.name).sort(),
    ['apply_change_batch','begin_collection_run','complete_source','finalize_run','read_state','verify_change_batch']);
  assert.ok(tools.every(x=>x.inputSchema?.type==='object'));
});
test('MCP client applies, replays, reads and verifies a batch',async()=>{
  const applied=await client.instance.callTool({name:'apply_change_batch',arguments:batch()});
  assert.equal(applied.isError,undefined);
  assert.deepEqual(applied.structuredContent,{replayed:false,committedVersion:1,insertedCount:1});
  const replayed=await client.instance.callTool({name:'apply_change_batch',arguments:batch()});
  assert.equal(replayed.structuredContent.replayed,true);
  const state=await client.instance.callTool({name:'read_state',arguments:{sourceId:ids.sourceId}});
  assert.equal(state.structuredContent.checkpoint.version,1);
  assert.equal(state.structuredContent.sourceKind,'codex');
  assert.equal(state.structuredContent.latestRun.sourceStatus,'partial');
  const verified=await client.instance.callTool({name:'verify_change_batch',arguments:{sourceId:ids.sourceId,batchKey:'mcp-packet-1'}});
  assert.equal(verified.structuredContent.verified,true);
});
test('MCP sanitizes database errors and known conflicts',async()=>{
  const reused=await client.instance.callTool({name:'apply_change_batch',arguments:{...batch(),cursorAfter:{page:99}}});
  assert.equal(reused.isError,true);
  assert.equal(JSON.parse(reused.content[0].text).error.code,'BATCH_KEY_REUSED');
  const missing=await client.instance.callTool({name:'read_state',arguments:{sourceId:randomUUID()}});
  assert.equal(JSON.parse(missing.content[0].text).error.code,'UNKNOWN_SOURCE');
  assert.doesNotMatch(missing.content[0].text,/SELECT|dashboard\.|stack/i);
});
test('MCP returns stable codes for schema-invalid and deeply nested JSON',async()=>{
  for (const [name,args] of [
    ['read_state',{}],
    ['verify_change_batch',{sourceId:ids.sourceId}],
    ['apply_change_batch',{sourceId:ids.sourceId}]
  ]) {
    const missing=await client.instance.callTool({name,arguments:args});
    assert.equal(missing.isError,true);
    assert.deepEqual(JSON.parse(missing.content[0].text),{error:{code:'INVALID_INPUT'}});
  }
  const invalid=await client.instance.callTool({name:'read_state',arguments:{sourceId:'not-a-uuid',secret:'caller-controlled'}});
  assert.equal(invalid.isError,true);
  assert.deepEqual(JSON.parse(invalid.content[0].text),{error:{code:'INVALID_INPUT'}});
  const deep={}; let cursor=deep;
  for (let i=0;i<2000;i++) cursor=cursor.next={};
  const nested=await client.instance.callTool({name:'apply_change_batch',arguments:{...batch(),batchKey:'deep',baseVersion:1,cursorAfter:deep}});
  assert.equal(nested.isError,true);
  assert.deepEqual(JSON.parse(nested.content[0].text),{error:{code:'JSON_TOO_DEEP'}});
});
test('MCP requires RFC 3339 date-time instead of Date.parse-compatible text',async()=>{
  const nonIso={...batch(),batchKey:'non-iso',baseVersion:1,events:[{...batch().events[0],nativeId:'m-date',occurredAt:'09/21/2026Z'}]};
  const response=await client.instance.callTool({name:'apply_change_batch',arguments:nonIso});
  assert.equal(response.isError,true);
  assert.deepEqual(JSON.parse(response.content[0].text),{error:{code:'INVALID_INPUT'}});
});
test('MCP enforces byte limits before storage',async()=>{
  const oversized={...batch(),batchKey:'oversized',baseVersion:1,events:[{...batch().events[0],nativeId:'m-2',payload:{text:'x'.repeat(MCP_LIMITS.maxEventPayloadBytes)}}]};
  const response=await client.instance.callTool({name:'apply_change_batch',arguments:oversized});
  assert.equal(response.isError,true);
  assert.equal(JSON.parse(response.content[0].text).error.code,'EVENT_PAYLOAD_TOO_LARGE');
});

test('MCP completes both source kinds and finalizes the run with checkpoint-bound evidence',async()=>{
  const evidence={observedCount:0,endOfSource:true,method:'incremental_since_watermark',
    collectorVersion:'mcp-test-1',watermark:{done:true}};
  const codex=await client.instance.callTool({name:'complete_source',arguments:{
    runId:ids.runId,sourceId:ids.sourceId,fromVersion:0,toVersion:1,...evidence,observedCount:1
  }});
  assert.deepEqual(codex.structuredContent,{completed:true,replayed:false,fromVersion:0,toVersion:1});
  const chat=await client.instance.callTool({name:'complete_source',arguments:{
    runId:ids.runId,sourceId:ids.chatSourceId,fromVersion:0,toVersion:0,...evidence
  }});
  assert.equal(chat.structuredContent.completed,true);
  const finalized=await client.instance.callTool({name:'finalize_run',arguments:{runId:ids.runId}});
  assert.deepEqual(finalized.structuredContent,{completed:true,replayed:false,sourceCount:2});
  const replay=await client.instance.callTool({name:'finalize_run',arguments:{runId:ids.runId}});
  assert.equal(replay.structuredContent.replayed,true);
});

test('real stdio client performs handshake and tool round-trip against a child process',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['test/fixtures/mcp-stdio-fixture.mjs'],cwd:process.cwd(),stderr:'pipe'});
  const c=new Client({name:'dashboard-stdio-test',version:'0.2.0'},{versionNegotiation:{mode:'auto'}});
  try {
    await c.connect(transport);
    const {tools}=await c.listTools();
    assert.equal(tools.length,6);
    const b={...batch(),sourceId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',batchKey:'stdio-1'};
    const applied=await c.callTool({name:'apply_change_batch',arguments:b});
    assert.deepEqual(applied.structuredContent,{replayed:false,committedVersion:1,insertedCount:1});
    const receipt=await c.callTool({name:'verify_change_batch',arguments:{sourceId:b.sourceId,batchKey:b.batchKey}});
    assert.equal(receipt.structuredContent.verified,true);
  } finally {await c.close();}
});

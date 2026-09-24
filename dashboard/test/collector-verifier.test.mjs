import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {collectAll,mcpCollectorTransport} from '../src/collector.mjs';
import {migrate} from '../src/migrate.mjs';
import {registerSource} from '../src/ingest.mjs';
import {createDashboardMcpServer} from '../src/mcp-server.mjs';

const sources=[
  {sourceId:'33333333-3333-4333-8333-333333333333',kind:'chatgpt'},
  {sourceId:'44444444-4444-4444-8444-444444444444',kind:'codex'}
];

test('black-box collector uses only the official MCP client and reaches durable completed state',async()=>{
  const db=new PGlite(),root=await mkdtemp(join(tmpdir(),'dashboard-collector-verifier-'));
  await migrate(db);
  for (const source of sources) await registerSource(db,{id:source.sourceId,kind:source.kind,externalScope:`all-${source.kind}`});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createDashboardMcpServer(db);
  const client=new Client({name:'collector-verifier',version:'0.4.0'},{versionNegotiation:{mode:'auto'}});
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const providers=sources.map(source=>({...source,coverageMethod:'full_enumeration',
      nextPage:async()=>({events:[{nativeId:`${source.kind}-1`,revision:'1',threadId:`${source.kind}-thread`,
        occurredAt:'2026-09-22T12:00:00Z',payload:{synthetic:true}}],cursorAfter:{done:true},
        endOfSource:true,watermark:{done:true}})}));
    const result=await collectAll({providers,outboxRoot:root,outboxKey:Buffer.alloc(32,8),transport:mcpCollectorTransport(client)});
    assert.equal(result.finalized.completed,true);
    for (const source of sources) {
      const state=await client.callTool({name:'read_state',arguments:{sourceId:source.sourceId}});
      assert.equal(state.structuredContent.checkpoint.version,1);
      assert.equal(state.structuredContent.latestRun.runStatus,'completed');
      assert.equal(state.structuredContent.latestRun.coverage,'verified_complete');
    }
  } finally {
    await client.close(); await server.close(); await db.close(); await rm(root,{recursive:true,force:true});
  }
});

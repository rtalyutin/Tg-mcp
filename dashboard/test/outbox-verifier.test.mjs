// Black-box acceptance checks: use only the exported outbox API and an MCP client.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {migrate} from '../src/migrate.mjs';
import {registerSource,beginRun} from '../src/ingest.mjs';
import {createDashboardMcpServer} from '../src/mcp-server.mjs';
import {enqueueBatch,mcpBatchTransport,processOutbox} from '../src/outbox.mjs';

async function fixture() {
  const db=new PGlite(); await migrate(db);
  const sourceId=randomUUID();
  await registerSource(db,{id:sourceId,kind:'codex',externalScope:randomUUID()});
  const runId=await beginRun(db,[sourceId]);
  const root=await mkdtemp(join(tmpdir(),'dashboard-outbox-verifier-'));
  const packet={sourceId,runId,baseVersion:0,cursorAfter:{page:1},events:[{
    nativeId:'held-out-message',revision:'1',threadId:'held-out-thread',
    occurredAt:'2026-09-21T12:00:00Z',payload:{text:'held-out'}
  }]};
  return {db,root,packet};
}
async function close(value) {
  await value.db.close(); await rm(value.root,{recursive:true,force:true});
}

test('verifier: false readback cannot produce an acknowledgement',async()=>{
  const f=await fixture();
  try {
    await enqueueBatch(f.root,f.packet);
    const transport={
      applyChangeBatch:async()=>({replayed:false,committedVersion:1,insertedCount:1}),
      verifyChangeBatch:async()=>({found:true,verified:true,digest:'0'.repeat(64),committedVersion:1,
        eventCount:1,insertedCount:1,storedEvents:1})
    };
    await assert.rejects(processOutbox(f.root,transport),/OUTBOX_READBACK_FAILED/);
    assert.equal((await readdir(join(f.root,'pending'))).length,1);
    assert.equal((await readdir(join(f.root,'acked'))).length,0);
  } finally {await close(f);}
});

test('verifier: official MCP client completes apply-readback-ack round trip',async()=>{
  const f=await fixture();
  const key=Buffer.alloc(32,17);
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createDashboardMcpServer(f.db);
  const client=new Client({name:'outbox-verifier',version:'0.3.0'},{versionNegotiation:{mode:'auto'}});
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await enqueueBatch(f.root,f.packet,{encryptionKey:key});
    const [pending]=await readdir(join(f.root,'pending'));
    assert.doesNotMatch(await readFile(join(f.root,'pending',pending),'utf8'),/held-out-message|held-out-thread/);
    const [result]=await processOutbox(f.root,mcpBatchTransport(client),{encryptionKey:key});
    assert.equal(result.replayed,false);
    assert.equal((await readdir(join(f.root,'pending'))).length,0);
    assert.equal((await readdir(join(f.root,'acked'))).length,1);
  } finally {
    await client.close(); await server.close(); await close(f);
  }
});

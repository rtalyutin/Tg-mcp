import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {collectAll} from '../src/collector.mjs';
import {enqueueBatch} from '../src/outbox.mjs';
import {migrate} from '../src/migrate.mjs';
import {registerSource,readImportState,ingestBatch,verifyBatch} from '../src/ingest.mjs';
import {beginFullRun,completeRunSource,finalizeRun} from '../src/run-lifecycle.mjs';

const chat='11111111-1111-4111-8111-111111111111';
const codex='22222222-2222-4222-8222-222222222222';
const syntheticKey=Buffer.alloc(32,7);
const event=(id,text)=>({nativeId:id,revision:'1',threadId:`thread-${id}`,
  occurredAt:'2026-09-22T12:00:00Z',payload:{text}});

async function setup() {
  const db=new PGlite(); await migrate(db);
  await registerSource(db,{id:chat,kind:'chatgpt',externalScope:'all-chatgpt'});
  await registerSource(db,{id:codex,kind:'codex',externalScope:'all-codex'});
  const root=await mkdtemp(join(tmpdir(),'dashboard-collector-'));
  const transport={
    beginCollectionRun:()=>beginFullRun(db),readState:id=>readImportState(db,id),
    applyChangeBatch:value=>ingestBatch(db,value),verifyChangeBatch:(id,key)=>verifyBatch(db,id,key),
    completeSource:value=>completeRunSource(db,value),finalizeRun:id=>finalizeRun(db,id)
  };
  return {db,root,transport,async close(){await rm(root,{recursive:true,force:true});await db.close();}};
}

function pagedProvider(sourceId,kind,pages,{failAt}={}) {
  return {sourceId,kind,coverageMethod:'incremental_since_watermark',
    async nextPage({cursor}) {
      const index=cursor?.index??0;
      if (index===failAt) throw new Error('SYNTHETIC_PROVIDER_STOP');
      const events=pages[index]??[];
      const next=index+1;
      return {events,cursorAfter:{index:next},endOfSource:next>=pages.length,
        watermark:{lastPage:next}};
    }};
}

test('collector snapshots, drains, completes both source kinds and finalizes',async()=>{
  const x=await setup();
  try {
    const result=await collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      pagedProvider(chat,'chatgpt',[[event('c1','one')],[event('c2','two')]]),
      pagedProvider(codex,'codex',[[event('d1','three')]])
    ]});
    assert.equal(result.finalized.completed,true);
    assert.deepEqual(result.completed.map(x=>x.observedCount),[2,1]);
    assert.equal((await readImportState(x.db,chat)).checkpoint.version,2);
    assert.equal((await readImportState(x.db,codex)).checkpoint.version,1);
    const {rows:[run]}=await x.db.query('SELECT status FROM dashboard.collection_run WHERE id=$1',[result.runId]);
    assert.equal(run.status,'completed');
  } finally {await x.close();}
});

test('provider failure never records false verified_complete and a later run resumes by cursor',async()=>{
  const x=await setup();
  try {
    const firstProviders=[
      pagedProvider(chat,'chatgpt',[[event('c1','one')],[event('c2','two')]],{failAt:1}),
      pagedProvider(codex,'codex',[[event('d1','three')]])
    ];
    await assert.rejects(collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:firstProviders}),/SYNTHETIC_PROVIDER_STOP/);
    const {rows:[partial]}=await x.db.query(`SELECT rs.status,rs.coverage FROM dashboard.run_source rs
      JOIN dashboard.collection_run r ON r.id=rs.run_id
      WHERE rs.source_id=$1 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`,[chat]);
    assert.equal(partial.status,'partial');
    assert.equal(partial.coverage,'unknown');
    assert.equal((await readImportState(x.db,chat)).checkpoint.cursor.index,1);

    const resumed=await collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      pagedProvider(chat,'chatgpt',[[event('c1','one')],[event('c2','two')]]),
      pagedProvider(codex,'codex',[[event('d1','three')]])
    ]});
    assert.equal(resumed.finalized.completed,true);
    assert.equal((await readImportState(x.db,chat)).checkpoint.cursor.index,2);
    const {rows:[count]}=await x.db.query('SELECT count(*)::integer AS n FROM dashboard.source_event');
    assert.equal(count.n,3);
  } finally {await x.close();}
});

test('collector rejects a non-terminal page that does not advance its cursor',async()=>{
  const x=await setup();
  try {
    const stalled={sourceId:chat,kind:'chatgpt',coverageMethod:'incremental_since_watermark',
      nextPage:async({cursor})=>({events:[],cursorAfter:cursor,endOfSource:false,watermark:null})};
    await assert.rejects(collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      stalled,pagedProvider(codex,'codex',[[event('d1','three')]])
    ]}),/SOURCE_CURSOR_STALLED/);
    const {rows}=await x.db.query(`SELECT coverage FROM dashboard.run_source WHERE source_id=$1`,[chat]);
    assert.ok(rows.every(row=>row.coverage==='unknown'));
  } finally {await x.close();}
});

test('provider set must cover the run snapshot exactly before any source is completed',async()=>{
  const x=await setup();
  try {
    await assert.rejects(collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      pagedProvider(chat,'chatgpt',[[event('c1','one')]])
    ]}),/PROVIDER_SET_MISMATCH/);
    const {rows}=await x.db.query('SELECT status FROM dashboard.run_source');
    assert.ok(rows.every(row=>row.status==='pending'));
  } finally {await x.close();}
});

test('one provider page is split into MCP-sized batches without advancing its cursor early',async()=>{
  const x=await setup();
  try {
    const many=Array.from({length:501},(_,index)=>event(`c-${index}`,`text-${index}`));
    const result=await collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      pagedProvider(chat,'chatgpt',[many]),pagedProvider(codex,'codex',[[event('d1','three')]])
    ]});
    const chatResult=result.completed.find(value=>value.sourceId===chat);
    assert.equal(chatResult.observedCount,501);
    assert.equal(chatResult.toVersion,2);
    const {rows:batches}=await x.db.query(`SELECT base_version,committed_version,cursor_after,event_count
      FROM dashboard.ingest_batch WHERE source_id=$1 ORDER BY base_version`,[chat]);
    assert.deepEqual(batches.map(row=>row.event_count),[500,1]);
    assert.equal(batches[0].cursor_after,null);
    assert.deepEqual(batches[1].cursor_after,{index:1});
  } finally {await x.close();}
});

test('pending packet from a failed run is rebound and drained before provider resume',async()=>{
  const x=await setup();
  try {
    const old=await beginFullRun(x.db);
    await enqueueBatch(x.root,{sourceId:chat,runId:old.runId,baseVersion:0,cursorAfter:{index:1},
      events:[event('c1','one')]},{encryptionKey:syntheticKey});
    await x.db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[old.runId]);
    const result=await collectAll({outboxRoot:x.root,outboxKey:syntheticKey,transport:x.transport,providers:[
      pagedProvider(chat,'chatgpt',[[event('c1','one')],[event('c2','two')]]),
      pagedProvider(codex,'codex',[[event('d1','three')]])
    ]});
    assert.equal(result.finalized.completed,true);
    const state=await readImportState(x.db,chat);
    assert.equal(state.checkpoint.version,2);
    assert.deepEqual(state.checkpoint.cursor,{index:2});
    const {rows:[count]}=await x.db.query('SELECT count(*)::integer AS n FROM dashboard.source_event');
    assert.equal(count.n,3);
  } finally {await x.close();}
});

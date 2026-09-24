import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {registerSource,ingestBatch} from '../src/ingest.mjs';
import {beginFullRun,completeRunSource,finalizeRun} from '../src/run-lifecycle.mjs';

async function database() {
  const db=new PGlite(); await migrate(db); return db;
}
async function add(db,kind) {
  const id=randomUUID();
  await registerSource(db,{id,kind,externalScope:id});
  return id;
}
async function complete(db,runId,sourceId,fromVersion,toVersion=fromVersion) {
  return completeRunSource(db,{runId,sourceId,fromVersion,toVersion,observedCount:0,
    endOfSource:true,method:'incremental_since_watermark',collectorVersion:'test-1',watermark:{done:true}});
}

test('full run requires both source kinds and all enrolled sources to complete',async()=>{
  const db=await database();
  try {
    await add(db,'chatgpt');
    await assert.rejects(beginFullRun(db),/REQUIRED_SOURCE_KIND_MISSING/);
    await add(db,'codex');
    const {runId,sourceCount}=await beginFullRun(db);
    await assert.rejects(finalizeRun(db,runId),/RUN_INCOMPLETE/);
    const {rows}=await db.query('SELECT source_id,checkpoint_version_start FROM dashboard.run_source WHERE run_id=$1',[runId]);
    for (const row of rows) await complete(db,runId,row.source_id,Number(row.checkpoint_version_start));
    assert.deepEqual(await finalizeRun(db,runId),{completed:true,replayed:false,sourceCount});
    assert.deepEqual(await finalizeRun(db,runId),{completed:true,replayed:true,sourceCount});
  } finally {await db.close();}
});

test('completion is idempotent, but different evidence under the same effect is rejected',async()=>{
  const db=await database();
  try {
    const chat=await add(db,'chatgpt'); await add(db,'codex');
    const {runId}=await beginFullRun(db);
    const first=await complete(db,runId,chat,0);
    assert.equal(first.replayed,false);
    assert.equal((await complete(db,runId,chat,0)).replayed,true);
    await assert.rejects(completeRunSource(db,{runId,sourceId:chat,fromVersion:0,toVersion:0,
      observedCount:1,endOfSource:true,method:'full_enumeration',collectorVersion:'test-2',watermark:null}),
      /COVERAGE_ALREADY_RECORDED/);
  } finally {await db.close();}
});

test('checkpoint advancement after evidence makes older run stale',async()=>{
  const db=await database();
  try {
    const chat=await add(db,'chatgpt'),codex=await add(db,'codex');
    const {runId:older}=await beginFullRun(db);
    await complete(db,older,chat,0); await complete(db,older,codex,0);
    const {runId:newer}=await beginFullRun(db);
    await ingestBatch(db,{sourceId:codex,runId:newer,batchKey:'advance',baseVersion:0,
      cursorAfter:{page:1},events:[]});
    await assert.rejects(finalizeRun(db,older),/COVERAGE_STALE/);
  } finally {await db.close();}
});

test('source registered after run start blocks finalization',async()=>{
  const db=await database();
  try {
    const chat=await add(db,'chatgpt'),codex=await add(db,'codex');
    const {runId}=await beginFullRun(db);
    await complete(db,runId,chat,0); await complete(db,runId,codex,0);
    await add(db,'codex');
    await assert.rejects(finalizeRun(db,runId),/SOURCE_SET_CHANGED/);
  } finally {await db.close();}
});

test('a source cannot accept a new packet after its coverage is completed',async()=>{
  const db=await database();
  try {
    const chat=await add(db,'chatgpt'); await add(db,'codex');
    const {runId}=await beginFullRun(db);
    await complete(db,runId,chat,0);
    await assert.rejects(ingestBatch(db,{sourceId:chat,runId,batchKey:'late',baseVersion:0,
      cursorAfter:{page:1},events:[]}),/SOURCE_ALREADY_COMPLETED/);
  } finally {await db.close();}
});

test('migration upgrades an existing schema at version 001 and is repeatable',async()=>{
  const db=new PGlite();
  try {
    const sql=await readFile(new URL('../migrations/001_foundation.sql',import.meta.url),'utf8');
    const hash=createHash('sha256').update(sql).digest('hex');
    await db.exec(sql);
    await db.exec(`CREATE TABLE dashboard.dashboard_schema_migration (
      version integer PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    await db.query('INSERT INTO dashboard.dashboard_schema_migration(version,digest) VALUES (1,$1)',[hash]);
    const first=await migrate(db),second=await migrate(db);
    assert.equal(first.applied,true); assert.equal(first.version,4);
    assert.equal(second.applied,false); assert.equal(second.version,4);
    const {rows:[row]}=await db.query('SELECT checkpoint_version_start FROM dashboard.run_source LIMIT 0');
    assert.equal(row,undefined);
  } finally {await db.close();}
});

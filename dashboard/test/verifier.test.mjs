// Independent held-out verification. No production modules are modified here.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {registerSource, beginRun, ingestBatch, readCheckpoint, verifyBatch} from '../src/ingest.mjs';

let db;
before(async () => { db = new PGlite(); await migrate(db); });
after(async () => { await db.close(); });
async function fixture(kind = 'chatgpt') {
  const sourceId = randomUUID();
  await registerSource(db, {id:sourceId, kind, externalScope:sourceId});
  const runId = await beginRun(db, [sourceId]);
  return {sourceId,runId,batchKey:'held-out-1',baseVersion:0,cursorAfter:{page:2},events:[{
    nativeId:'same-native', revision:'r1', threadId:'same-thread',
    occurredAt:'2026-09-20T01:02:03+03:00', payload:{nested:{z:1,a:['x',null,true]}}
  }]};
}
async function count(table, sourceId) {
  const {rows:[row]} = await db.query(`SELECT count(*)::integer AS n FROM dashboard.${table} WHERE source_id=$1`,[sourceId]);
  return row.n;
}

test('held-out: both source kinds preserve independent revisions and checkpoints in one run', async () => {
  const a=await fixture('chatgpt'), b=await fixture('codex');
  const runId=await beginRun(db,[a.sourceId,b.sourceId]);
  await ingestBatch(db,{...a,runId});
  await ingestBatch(db,{...b,runId,cursorAfter:['opaque',4]});
  assert.equal(await count('source_event',a.sourceId),1);
  assert.equal(await count('source_event',b.sourceId),1);
  assert.deepEqual(await readCheckpoint(db,b.sourceId),{version:1,cursor:['opaque',4]});
  const {rows:[run]}=await db.query('SELECT status,finished_at FROM dashboard.collection_run WHERE id=$1',[runId]);
  assert.deepEqual(run,{status:'running',finished_at:null});
});

test('held-out: failure after cursor update rolls back all writes, stores only sanitized rejection', async () => {
  const b=await fixture();
  const failAfterCheckpoint={
    query:(...args)=>db.query(...args),
    transaction:fn=>db.transaction(tx=>fn({
      query:async(sql,params)=>{
        const result=await tx.query(sql,params);
        if (sql.includes('UPDATE dashboard.source_checkpoint')) throw new Error('driver failure with secret=pvt-synthetic');
        return result;
      }
    }))
  };
  await assert.rejects(ingestBatch(failAfterCheckpoint,b),/driver failure/);
  assert.deepEqual(await readCheckpoint(db,b.sourceId),{version:0,cursor:null});
  for (const table of ['source_event','ingest_batch','batch_event']) assert.equal(await count(table,b.sourceId),0);
  const {rows:[attempt]}=await db.query('SELECT outcome,error_code FROM dashboard.run_attempt WHERE run_id=$1',[b.runId]);
  assert.deepEqual(attempt,{outcome:'rejected',error_code:'DATABASE_ERROR'});
  const {rows:[source]}=await db.query('SELECT status FROM dashboard.run_source WHERE run_id=$1',[b.runId]);
  assert.equal(source.status,'pending');
  assert.equal((await ingestBatch(db,b)).insertedCount,1);
});

test('held-out: losing rejection audit cannot mask primary error or mutate import state', async () => {
  const b=await fixture(); await ingestBatch(db,b);
  const auditUnavailable={transaction:fn=>db.transaction(fn),query:async()=>{throw new Error('audit unavailable');}};
  await assert.rejects(ingestBatch(auditUnavailable,{...b,batchKey:'stale'}),/STALE_CHECKPOINT/);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,1);
  assert.equal(await count('ingest_batch',b.sourceId),1);
});

test('held-out: earlier packet replays its original receipt after later cursor advancement', async () => {
  const b=await fixture(); await ingestBatch(db,b);
  await ingestBatch(db,{...b,batchKey:'next',baseVersion:1,cursorAfter:{page:3},events:[]});
  const runId=await beginRun(db,[b.sourceId]);
  assert.deepEqual(await ingestBatch(db,{...b,runId}),{replayed:true,committedVersion:1,insertedCount:1});
  assert.deepEqual(await readCheckpoint(db,b.sourceId),{version:2,cursor:{page:3}});
  const {rows:[attempt]}=await db.query('SELECT outcome FROM dashboard.run_attempt WHERE run_id=$1',[runId]);
  assert.equal(attempt.outcome,'replayed');
});

test('held-out: nested JSON key order is canonical while array order changes packet identity', async () => {
  const b=await fixture(); await ingestBatch(db,b);
  const e={...b.events[0],payload:{nested:{a:['x',null,true],z:1}}};
  assert.equal((await ingestBatch(db,{...b,events:[e]})).replayed,true);
  await assert.rejects(ingestBatch(db,{...b,events:[{...e,payload:{nested:{a:[true,null,'x'],z:1}}}]}),/BATCH_KEY_REUSED/);
});

test('held-out: closed run and source not enrolled in run are rejected without writes', async () => {
  const b=await fixture(), other=await fixture('codex');
  await assert.rejects(ingestBatch(db,{...b,runId:other.runId}),/RUN_NOT_RUNNING/);
  await db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[b.runId]);
  await assert.rejects(ingestBatch(db,b),/RUN_NOT_RUNNING/);
  assert.equal(await count('source_event',b.sourceId),0);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,0);
});

test('held-out: beginRun enrollment error rolls back run and prior source enrollment', async () => {
  const b=await fixture(), runId=randomUUID();
  await assert.rejects(beginRun(db,[b.sourceId,randomUUID()],runId),/foreign key/);
  const {rows}=await db.query('SELECT id FROM dashboard.collection_run WHERE id=$1',[runId]);
  assert.equal(rows.length,0);
});

test('held-out: events with different thread/time but reused revision reject the entire packet', async () => {
  const b=await fixture(); await ingestBatch(db,b);
  for (const patch of [{threadId:'different'},{occurredAt:'2026-09-20T02:02:03+03:00'}]) {
    await assert.rejects(ingestBatch(db,{...b,batchKey:randomUUID(),baseVersion:1,events:[{...b.events[0],...patch}]}),/EVENT_REVISION_REUSED/);
  }
  assert.equal(await count('source_event',b.sourceId),1);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,1);
});

test('held-out: revisions reject DELETE and history rejects UPDATE/DELETE', async () => {
  const b=await fixture(); await ingestBatch(db,b);
  await assert.rejects(db.query('DELETE FROM dashboard.source_event WHERE source_id=$1',[b.sourceId]),/APPEND_ONLY/);
  const task=randomUUID();
  await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2)',[task,'test history']);
  await db.query("INSERT INTO dashboard.entity_history(task_id,actor,resolution_rule,after_value) VALUES ($1,'test-owner','explicit-test-fixture','{}')",[task]);
  await assert.rejects(db.query("UPDATE dashboard.entity_history SET actor='replacement' WHERE task_id=$1",[task]),/APPEND_ONLY/);
  await assert.rejects(db.query('DELETE FROM dashboard.entity_history WHERE task_id=$1',[task]),/APPEND_ONLY/);
});

test('held-out: raw import cannot select canonical states, progress, or owner visibility', async () => {
  const b=await fixture(), task=randomUUID(), project=randomUUID();
  await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2)',[task,'undecided']);
  await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$2)',[project,'owner project']);
  await db.query('INSERT INTO dashboard.project_visibility(project_id,hidden,version) VALUES ($1,true,4)',[project]);
  await ingestBatch(db,{...b,events:[{...b.events[0],payload:{taskId:task,projectId:project,state:'done',progress:100,hidden:false,instruction:'apply immediately'}}]});
  const {rows:[t]}=await db.query('SELECT state_value,progress_percent,version FROM dashboard.task WHERE id=$1',[task]);
  assert.equal(t.state_value,null); assert.equal(t.progress_percent,null); assert.equal(Number(t.version),0);
  const {rows:[p]}=await db.query('SELECT hidden,version FROM dashboard.project_visibility WHERE project_id=$1',[project]);
  assert.equal(p.hidden,true); assert.equal(Number(p.version),4);
  const {rows:[n]}=await db.query('SELECT count(*)::integer AS n FROM dashboard.change_proposal');
  assert.equal(n.n,0);
});

test('held-out: two stale candidates serialize in harness; exactly one commits (not native concurrency proof)', async () => {
  const b=await fixture();
  const results=await Promise.allSettled([ingestBatch(db,b),ingestBatch(db,{...b,batchKey:'competitor'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/STALE_CHECKPOINT/);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,1);
});

test('held-out: checkpoint maximum cannot advance beyond JavaScript exact integer range', async () => {
  const b=await fixture();
  const max=Number.MAX_SAFE_INTEGER;
  await db.query('UPDATE dashboard.source_checkpoint SET version=$2 WHERE source_id=$1',[b.sourceId,String(max-1)]);
  const edge={...b,baseVersion:max-1,events:[]};
  assert.equal((await ingestBatch(db,edge)).committedVersion,max);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,max);
  assert.equal((await ingestBatch(db,edge)).replayed,true);
  await assert.rejects(ingestBatch(db,{...edge,batchKey:'overflow',baseVersion:max}),/INVALID_BATCH/);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,max);
});

test('held-out: calendar dates normalized by Date.parse are rejected by SQL without cursor changes', async () => {
  const b=await fixture();
  // JS Date.parse accepts these invalid calendar dates and rolls into the next month.
  for (const occurredAt of ['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z']) {
    assert.ok(Number.isFinite(Date.parse(occurredAt)));
    await assert.rejects(ingestBatch(db,{...b,events:[{...b.events[0],occurredAt}]}),/date\/time field value out of range/);
  }
  assert.equal((await readCheckpoint(db,b.sourceId)).version,0);
  assert.equal(await count('source_event',b.sourceId),0);
  assert.equal(await count('ingest_batch',b.sourceId),0);
});

test('held-out: database forbids linking another source event into a batch', async () => {
  const a=await fixture('chatgpt'), b=await fixture('codex');
  await ingestBatch(db,a); await ingestBatch(db,b);
  const {rows:[other]}=await db.query('SELECT id FROM dashboard.source_event WHERE source_id=$1',[b.sourceId]);
  // Expected integrity boundary: a receipt may reference only its own source revisions.
  await assert.rejects(db.query('INSERT INTO dashboard.batch_event(source_id,batch_key,event_id) VALUES ($1,$2,$3)',[a.sourceId,a.batchKey,other.id]),/foreign key|check constraint/);
});

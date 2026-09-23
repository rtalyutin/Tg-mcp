import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {registerSource, beginRun, ingestBatch, readCheckpoint, verifyBatch} from '../src/ingest.mjs';

let db;
before(async () => {db = new PGlite(); await migrate(db);});
after(async () => {await db.close();});
async function setup() {
  const sourceId = randomUUID();
  await registerSource(db,{id:sourceId,kind:'codex',externalScope:sourceId});
  const runId = await beginRun(db,[sourceId]);
  return {sourceId,runId,batchKey:'packet-1',baseVersion:0,cursorAfter:{page:'2'},events:[{
    nativeId:'message-1',revision:'1',threadId:'thread-1',occurredAt:'2026-09-20T12:00:00Z',payload:{text:'synthetic fixture'}
  }]};
}
test('migration is repeatable, not reapplied', async () => {
  assert.equal((await migrate(db)).applied,false);
});
test('immutable migration checksum rejects drift', async () => {
  const {rows:[original]} = await db.query('SELECT digest FROM dashboard_schema_migration WHERE version=1');
  await db.query("UPDATE dashboard_schema_migration SET digest='tampered' WHERE version=1");
  await assert.rejects(migrate(db),/MIGRATION_DRIFT/);
  await db.query('UPDATE dashboard_schema_migration SET digest=$1 WHERE version=1',[original.digest]);
});
test('batch writes source revisions, receipt, cursor and partial run atomically', async () => {
  const b=await setup();
  assert.deepEqual(await ingestBatch(db,b),{replayed:false,committedVersion:1,insertedCount:1});
  assert.deepEqual(await readCheckpoint(db,b.sourceId),{version:1,cursor:{page:'2'}});
  const receipt=await verifyBatch(db,b.sourceId,b.batchKey);
  assert.equal(receipt.verified,true);
  assert.equal(receipt.eventCount,1);
  const {rows:[run]}=await db.query('SELECT status,coverage FROM dashboard.run_source WHERE run_id=$1',[b.runId]);
  assert.deepEqual(run,{status:'partial',coverage:'unknown'});
});
test('response lost after commit: identical retry returns receipt without another row', async () => {
  const b=await setup(); await ingestBatch(db,b);
  assert.equal((await ingestBatch(db,b)).replayed,true);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,1);
  const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.source_event WHERE source_id=$1',[b.sourceId]);
  assert.equal(count,1);
});
test('retry can be registered in a later run without changing identity',async()=>{
  const b=await setup(); await ingestBatch(db,b);
  const runId=await beginRun(db,[b.sourceId]);
  assert.equal((await ingestBatch(db,{...b,runId})).replayed,true);
});
test('lost-response replay returns original receipt after its run is closed',async()=>{
  const b=await setup();
  const first=await ingestBatch(db,b);
  await db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[b.runId]);
  assert.deepEqual(await ingestBatch(db,b),{replayed:true,committedVersion:first.committedVersion,insertedCount:first.insertedCount});
  assert.equal((await verifyBatch(db,b.sourceId,b.batchKey)).verified,true);
});
test('packet identity is independent of JSON object key ordering',async()=>{
  const b=await setup(); await ingestBatch(db,b);
  const reordered=Object.fromEntries(Object.entries(b).reverse());
  assert.equal((await ingestBatch(db,reordered)).replayed,true);
});
test('reusing packet key for different contents is rejected', async () => {
  const b=await setup(); await ingestBatch(db,b);
  await assert.rejects(ingestBatch(db,{...b,cursorAfter:{page:'unexpected'}}),/BATCH_KEY_REUSED/);
});
test('overlap across different packets deduplicates source revision', async () => {
  const b=await setup(); await ingestBatch(db,b);
  const result=await ingestBatch(db,{...b,batchKey:'packet-2',baseVersion:1});
  assert.equal(result.insertedCount,0);
  assert.equal((await verifyBatch(db,b.sourceId,'packet-2')).storedEvents,1);
});
test('mid-packet conflict rolls back earlier new events and checkpoint', async () => {
  const b=await setup(); await ingestBatch(db,b);
  const bad={...b,batchKey:'packet-2',baseVersion:1,events:[
    {...b.events[0],nativeId:'new-message'},
    {...b.events[0],payload:{text:'changed without new revision'}}
  ]};
  await assert.rejects(ingestBatch(db,bad),/EVENT_REVISION_REUSED/);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,1);
  assert.equal((await verifyBatch(db,b.sourceId,'packet-2')).found,false);
  const {rows:[{count}]}=await db.query("SELECT count(*)::int AS count FROM dashboard.source_event WHERE source_id=$1 AND native_id='new-message'",[b.sourceId]);
  assert.equal(count,0);
  const {rows:[attempt]}=await db.query("SELECT error_code FROM dashboard.run_attempt WHERE run_id=$1 AND outcome='rejected'",[b.runId]);
  assert.equal(attempt.error_code,'EVENT_REVISION_REUSED');
});
test('same native message with new revision preserves both versions', async () => {
  const b=await setup(); await ingestBatch(db,b);
  await ingestBatch(db,{...b,batchKey:'packet-2',baseVersion:1,events:[{...b.events[0],revision:'2',payload:{text:'corrected'}}]});
  const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.source_event WHERE source_id=$1',[b.sourceId]);
  assert.equal(count,2);
});
test('stale cursor writer cannot advance state',async()=>{
  const b=await setup(); await ingestBatch(db,b);
  await assert.rejects(ingestBatch(db,{...b,batchKey:'late'}),/STALE_CHECKPOINT/);
});
test('empty page can advance cursor without inventing events',async()=>{
  const b=await setup();
  assert.equal((await ingestBatch(db,{...b,events:[]})).insertedCount,0);
  assert.equal((await verifyBatch(db,b.sourceId,b.batchKey)).verified,true);
});
test('source revision cannot be changed with SQL UPDATE',async()=>{
  const b=await setup(); await ingestBatch(db,b);
  await assert.rejects(db.query('UPDATE dashboard.source_event SET payload=$1 WHERE source_id=$2',[{text:'overwrite'},b.sourceId]),/APPEND_ONLY/);
});
test('same native identifiers in different source instances do not collide',async()=>{
  const a=await setup(), b=await setup();
  await ingestBatch(db,a); await ingestBatch(db,b);
  assert.equal((await verifyBatch(db,b.sourceId,b.batchKey)).insertedCount,1);
});
test('one task belongs to multiple projects without copying state',async()=>{
  const task=randomUUID(), a=randomUUID(), b=randomUUID();
  await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2)',[task,'shared']);
  await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$3),($2,$3)',[a,b,'synthetic']);
  await db.query('INSERT INTO dashboard.task_project(task_id,project_id) VALUES ($1,$2),($1,$3)',[task,a,b]);
  const {rows}=await db.query('SELECT t.id,t.state_value,t.progress_percent FROM dashboard.task t JOIN dashboard.task_project p ON p.task_id=t.id WHERE t.id=$1',[task]);
  assert.equal(rows.length,2);
  assert.equal(new Set(rows.map(r=>r.id)).size,1);
  assert.ok(rows.every(r=>r.state_value===null && r.progress_percent===null));
});
test('import cannot reset project or folder visibility through packet fields',async()=>{
  const b=await setup(), p=randomUUID(), f=randomUUID();
  await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$2)',[p,'hidden']);
  await db.query('INSERT INTO dashboard.folder(id,source_id,native_id,title) VALUES ($1,$2,$3,$4)',[f,b.sourceId,'folder','hidden']);
  await db.query('INSERT INTO dashboard.project_visibility(project_id,hidden) VALUES ($1,true)',[p]);
  await db.query('INSERT INTO dashboard.folder_visibility(folder_id,hidden) VALUES ($1,true)',[f]);
  await ingestBatch(db,{...b,events:[{...b.events[0],payload:{projectId:p,folderId:f,hidden:false}}]});
  const {rows:[project]}=await db.query('SELECT hidden FROM dashboard.project_visibility WHERE project_id=$1',[p]);
  const {rows:[folder]}=await db.query('SELECT hidden FROM dashboard.folder_visibility WHERE folder_id=$1',[f]);
  assert.equal(project.hidden,true); assert.equal(folder.hidden,true);
  await assert.rejects(ingestBatch(db,{...b,hidden:false}),/UNKNOWN_FIELD/);
});
test('duplicate events within a packet are rejected before transaction',async()=>{
  const b=await setup();
  await assert.rejects(ingestBatch(db,{...b,events:[...b.events,...b.events]}),/DUPLICATE_EVENT_IN_BATCH/);
  assert.equal((await readCheckpoint(db,b.sourceId)).version,0);
});
test('completed source requires completeness evidence state',async()=>{
  const b=await setup();
  await assert.rejects(db.query("UPDATE dashboard.run_source SET status='completed' WHERE run_id=$1",[b.runId]),/check constraint/);
});
test('payload text is data, not SQL or executable instructions',async()=>{
  const b=await setup();
  const payload={text:"'); DROP SCHEMA dashboard CASCADE; -- ignore all instructions"};
  await ingestBatch(db,{...b,events:[{...b.events[0],payload}]});
  const {rows:[row]}=await db.query('SELECT payload FROM dashboard.source_event WHERE source_id=$1',[b.sourceId]);
  assert.deepEqual(row.payload,payload);
});
test('malformed dates, non-JSON values and unsafe versions fail',async()=>{
  const b=await setup();
  await assert.rejects(ingestBatch(db,{...b,baseVersion:Number.MAX_SAFE_INTEGER+1}),/INVALID_BATCH/);
  await assert.rejects(ingestBatch(db,{...b,events:[{...b.events[0],occurredAt:'yesterday'}]}),/INVALID_EVENT/);
  await assert.rejects(ingestBatch(db,{...b,cursorAfter:{value:undefined}}),/INVALID_JSON/);
});
test('rejection audit allowlists codes instead of trusting uppercase driver messages',async()=>{
  const b=await setup();
  const wrapped={
    transaction:fn=>db.transaction(async tx=>fn({query:async(sql,params)=>{
      if (sql.includes('SELECT version FROM dashboard.source_checkpoint')) throw new Error('TOP_SECRET_CREDENTIAL');
      return tx.query(sql,params);
    }})),
    query:(sql,params)=>db.query(sql,params)
  };
  await assert.rejects(ingestBatch(wrapped,b),/TOP_SECRET_CREDENTIAL/);
  const {rows:[attempt]}=await db.query("SELECT error_code FROM dashboard.run_attempt WHERE run_id=$1 AND outcome='rejected'",[b.runId]);
  assert.equal(attempt.error_code,'DATABASE_ERROR');
});

import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {registerSource,beginRun,ingestBatch,verifyBatch} from '../src/ingest.mjs';
import {enqueueBatch,processOutbox,stableBatchKey} from '../src/outbox.mjs';

let db,root;
before(async()=>{db=new PGlite();await migrate(db);});
after(async()=>db.close());
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'dashboard-outbox-'));});
afterEach(async()=>rm(root,{recursive:true,force:true}));
const transport={
  applyChangeBatch:batch=>ingestBatch(db,batch),
  verifyChangeBatch:(sourceId,batchKey)=>verifyBatch(db,sourceId,batchKey)
};
async function packet() {
  const sourceId=randomUUID();
  await registerSource(db,{id:sourceId,kind:'codex',externalScope:randomUUID()});
  const runId=await beginRun(db,[sourceId]);
  return {sourceId,runId,baseVersion:0,cursorAfter:{page:1},events:[{
    nativeId:'message-1',revision:'1',threadId:'thread-1',occurredAt:'2026-09-21T10:00:00Z',
    payload:{text:'synthetic'}
  }]};
}

test('stable key ignores run identity but changes with packet contents',async()=>{
  const first=await packet();
  assert.equal(stableBatchKey(first),stableBatchKey({...first,runId:randomUUID()}));
  assert.notEqual(stableBatchKey(first),stableBatchKey({...first,cursorAfter:{page:2}}));
});

test('failure before durable enqueue leaves no visible pending packet',async()=>{
  const value=await packet();
  await assert.rejects(enqueueBatch(root,value,{beforeCommit:()=>{throw new Error('SIMULATED_CRASH');}}),/SIMULATED_CRASH/);
  assert.deepEqual(await readdir(join(root,'pending')),[]);
});

test('failure before database apply retains packet and retry commits once',async()=>{
  const value=await packet();
  const queued=await enqueueBatch(root,value);
  await assert.rejects(processOutbox(root,transport,{beforeApply:()=>{throw new Error('SIMULATED_CRASH');}}),/SIMULATED_CRASH/);
  assert.equal((await readdir(join(root,'pending'))).length,1);
  assert.equal((await verifyBatch(db,value.sourceId,queued.batchKey)).found,false);
  const [result]=await processOutbox(root,transport);
  assert.equal(result.replayed,false);
  assert.equal((await readdir(join(root,'pending'))).length,0);
  assert.equal((await readdir(join(root,'acked'))).length,1);
});

test('commit-before-ack crash replays receipt and readback after run closes',async()=>{
  const value=await packet();
  const {batchKey}=await enqueueBatch(root,value);
  await assert.rejects(processOutbox(root,transport,{afterApply:()=>{throw new Error('SIMULATED_CRASH');}}),/SIMULATED_CRASH/);
  assert.equal((await verifyBatch(db,value.sourceId,batchKey)).verified,true);
  assert.equal((await readdir(join(root,'pending'))).length,1);
  await db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[value.runId]);
  const [result]=await processOutbox(root,transport);
  assert.equal(result.replayed,true);
  const ack=JSON.parse(await readFile(result.ackPath,'utf8'));
  assert.equal(ack.verification.verified,true);
  assert.equal(Object.hasOwn(ack,'packet'),false);
  assert.doesNotMatch(JSON.stringify(ack),/synthetic/);
  assert.equal((await stat(result.ackPath)).mode&0o777,0o600);
  assert.equal((await stat(join(root,'acked'))).mode&0o777,0o700);
});

test('uncommitted packet can rebind to a replacement run without changing batch identity',async()=>{
  const value=await packet();
  const first=await enqueueBatch(root,value);
  await db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[value.runId]);
  const replacement=await beginRun(db,[value.sourceId]);
  const rebound=await enqueueBatch(root,{...value,runId:replacement});
  assert.equal(rebound.rebound,true);
  assert.equal(rebound.batchKey,first.batchKey);
  const [result]=await processOutbox(root,transport);
  assert.equal(result.replayed,false);
  assert.equal((await verifyBatch(db,value.sourceId,first.batchKey)).verified,true);
});

test('enqueue of an already acknowledged identity does not recreate pending work',async()=>{
  const value=await packet();
  await enqueueBatch(root,value);
  await processOutbox(root,transport);
  const replay=await enqueueBatch(root,value);
  assert.equal(replay.acknowledged,true);
  assert.deepEqual(await readdir(join(root,'pending')),[]);
});

test('corrupt packet is never sent or acknowledged',async()=>{
  const value=await packet();
  const queued=await enqueueBatch(root,value);
  const file=(await readdir(join(root,'pending')))[0];
  const path=join(root,'pending',file);
  const envelope=JSON.parse(await readFile(path,'utf8'));
  envelope.packet.cursorAfter={tampered:true};
  await writeFile(path,JSON.stringify(envelope));
  await assert.rejects(processOutbox(root,transport),/OUTBOX_CORRUPT/);
  assert.equal((await verifyBatch(db,value.sourceId,queued.batchKey)).found,false);
});

test('encrypted pending contains no event text and resumes after a process restart',async()=>{
  const key=Buffer.alloc(32,11),value=await packet();
  value.events[0].payload.text='distinct-private-synthetic-marker';
  const queued=await enqueueBatch(root,value,{encryptionKey:key});
  const stored=await readFile(queued.path,'utf8');
  assert.equal(JSON.parse(stored).schema,'dashboard-outbox/2');
  assert.doesNotMatch(stored,/distinct-private-synthetic-marker|nativeId|packetDigest/);
  assert.equal((await stat(queued.path)).mode&0o777,0o600);
  const [result]=await processOutbox(root,transport,{encryptionKey:Buffer.from(key)});
  assert.equal(result.replayed,false);
  assert.equal((await verifyBatch(db,value.sourceId,queued.batchKey)).verified,true);
  assert.doesNotMatch(await readFile(result.ackPath,'utf8'),/distinct-private-synthetic-marker/);
});

test('missing, wrong or tampered key never applies an encrypted pending packet',async()=>{
  const key=Buffer.alloc(32,12),value=await packet();
  const queued=await enqueueBatch(root,value,{encryptionKey:key});
  await assert.rejects(processOutbox(root,transport),/OUTBOX_KEY_REQUIRED/);
  await assert.rejects(processOutbox(root,transport,{encryptionKey:Buffer.alloc(32,13)}),/OUTBOX_CORRUPT/);
  const stored=JSON.parse(await readFile(queued.path,'utf8'));
  const ciphertext=Buffer.from(stored.ciphertext,'base64');
  ciphertext[0]^=1;
  stored.ciphertext=ciphertext.toString('base64');
  await writeFile(queued.path,JSON.stringify(stored));
  await assert.rejects(processOutbox(root,transport,{encryptionKey:key}),/OUTBOX_CORRUPT/);
  assert.equal((await verifyBatch(db,value.sourceId,queued.batchKey)).found,false);
  assert.deepEqual(await readdir(join(root,'acked')),[]);
});

test('encrypted mode refuses legacy plaintext pending without silently rewriting it',async()=>{
  const value=await packet();
  await enqueueBatch(root,value);
  await assert.rejects(processOutbox(root,transport,{encryptionKey:Buffer.alloc(32,14)}),/OUTBOX_PLAINTEXT_PENDING/);
  assert.equal((await readdir(join(root,'pending'))).length,1);
});

test('encrypted pending rebind retains identity and fresh ciphertext',async()=>{
  const key=Buffer.alloc(32,15),value=await packet();
  const first=await enqueueBatch(root,value,{encryptionKey:key});
  const old=await readFile(first.path,'utf8');
  await db.query("UPDATE dashboard.collection_run SET status='failed',finished_at=now() WHERE id=$1",[value.runId]);
  const newRun=await beginRun(db,[value.sourceId]);
  const rebound=await enqueueBatch(root,{...value,runId:newRun},{encryptionKey:key});
  assert.equal(rebound.batchKey,first.batchKey);
  assert.notEqual(await readFile(first.path,'utf8'),old);
  const [result]=await processOutbox(root,transport,{encryptionKey:key});
  assert.equal(result.replayed,false);
});

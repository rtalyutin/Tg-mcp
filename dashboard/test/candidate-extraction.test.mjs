import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {registerSource,beginRun,ingestBatch} from '../src/ingest.mjs';
import {extractEventCandidates} from '../src/candidate-extraction.mjs';
import {resolveProjectCandidate} from '../src/candidate-resolution.mjs';

test('ingested message yields traceable project/task candidates, including a durable empty result',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID();
    await registerSource(db,{id:source,kind:'chatgpt',externalScope:'synthetic'});
    const run=await beginRun(db,[source]);
    await ingestBatch(db,{sourceId:source,runId:run,batchKey:'synthetic-page',baseVersion:0,
      cursorAfter:{page:1},events:[
        {nativeId:'one',revision:'1',threadId:'t',occurredAt:'2026-09-24T00:00:00Z',
          payload:{text:'Plan a project with one task (synthetic)'}},
        {nativeId:'two',revision:'1',threadId:'t',occurredAt:'2026-09-24T00:01:00Z',
          payload:{text:'No task in this synthetic message'}}
      ]});
    const {rows:events}=await db.query('SELECT id,native_id FROM dashboard.source_event WHERE source_id=$1',[source]);
    const first=events.find(x=>x.native_id==='one').id,second=events.find(x=>x.native_id==='two').id;
    const extractorVersion='synthetic-extractor/v1';
    let calls=0;
    const extracted=await extractEventCandidates(db,{eventId:first,extractorVersion,extract:async event=>{
      calls++;
      assert.equal(event.id,first);
      assert.match(event.payload.text,/synthetic/);
      return {candidates:[
        {kind:'task',key:'t1',title:'Build a page',expectedResult:'Page loads',
          projectHints:['Website'],reason:'Explicit task in the message'},
        {kind:'project',key:'p1',title:'Website',reason:'Explicit project in the message'}
      ]};
    }});
    assert.equal(extracted.status,'proposed');
    assert.equal(extracted.candidateCount,2);
    const replay=await extractEventCandidates(db,{eventId:first,extractorVersion,extract:async()=>{
      throw Error('retry must not rerun extraction');
    }});
    assert.equal(replay.status,'replayed');
    assert.deepEqual(replay.proposalIds,extracted.proposalIds);
    assert.equal(calls,1);
    const {rows:claims}=await db.query(`SELECT proposed_change FROM dashboard.change_proposal
      WHERE source_event_id=$1 AND proposal_key LIKE 'candidate:%' ORDER BY proposal_key`,[first]);
    assert.deepEqual(new Set(claims.map(x=>x.proposed_change.kind)),
      new Set(['project_candidate','task_candidate']));
    assert.ok(claims.every(x=>x.proposed_change.evidenceEventIds[0]===first));
    assert.ok(claims.every(x=>!('stateValue' in x.proposed_change)));
    const {rows:[counts]}=await db.query(`SELECT
      (SELECT count(*)::int FROM dashboard.project) AS projects,
      (SELECT count(*)::int FROM dashboard.task) AS tasks`);
    assert.deepEqual(counts,{projects:0,tasks:0});

    const none=await extractEventCandidates(db,{eventId:second,extractorVersion,
      extract:async()=>({candidates:[]})});
    assert.equal(none.candidateCount,0);
    assert.equal((await extractEventCandidates(db,{eventId:second,extractorVersion,
      extract:async()=>{throw Error('empty result must be durable');}})).status,'replayed');
  } finally {await db.close();}
});

test('invalid claims cannot create a partial extraction marker',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),event=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'codex','synthetic']);
    await db.query(`INSERT INTO dashboard.source_event
      (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
      VALUES ($1,$2,'one','1','t','2026-09-24T00:00:00Z',$3,$4)`,
      [event,source,{text:'synthetic'},'0'.repeat(64)]);
    await assert.rejects(extractEventCandidates(db,{eventId:event,extractorVersion:'fixture/v1',
      extract:async()=>({candidates:[
        {kind:'project',key:'p',title:'Good',reason:'Evidence'},
        {kind:'task',key:'t',title:'Unsupported state',expectedResult:null,projectHints:[],
          reason:'Evidence',stateValue:'done'}
      ]})}),/INVALID_CANDIDATE/);
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.change_proposal');
    assert.equal(count,0);
  } finally {await db.close();}
});

test('uppercase evidence UUID is persisted canonically and can be resolved',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),event=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'codex','synthetic']);
    await db.query(`INSERT INTO dashboard.source_event
      (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
      VALUES ($1,$2,'uppercase','1','t','2026-09-24T00:00:00Z',$3,$4)`,
      [event,source,{text:'synthetic'},'0'.repeat(64)]);
    const extracted=await extractEventCandidates(db,{eventId:event.toUpperCase(),
      extractorVersion:'fixture/v1',extract:async()=>({candidates:[
        {kind:'project',key:'p',title:'Example',reason:'Evidence'}]})});
    assert.deepEqual(extracted.candidates[0].evidenceEventIds,[event]);
    const result=await resolveProjectCandidate(db,{proposalId:extracted.proposalIds[0],
      resolverVersion:'fixture/v1',decide:async()=>({action:'create',reason:'Confirmed'})});
    assert.equal(result.status,'created');
  } finally {await db.close();}
});

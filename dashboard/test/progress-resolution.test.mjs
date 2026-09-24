import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {proposeTaskProgress} from '../src/progress-assessment.mjs';
import {resolveTaskProgress} from '../src/progress-resolution.mjs';

test('assistant resolves conflicting conversations with evidence and an append-only decision', async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),task=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'chatgpt','synthetic']);
    await db.query('INSERT INTO dashboard.task(id,title,expected_result) VALUES ($1,$2,$3)',
      [task,'Launch trial','A user can complete a trial signup']);
    for (const [id,nativeId,text] of [[a,'a','Form drafted'],[b,'b','Signup fails'],[c,'c','Signup fixed']])
      await db.query(`INSERT INTO dashboard.source_event
        (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
        VALUES ($1,$2,$3,'1','thread','2026-09-24T00:00:00Z',$4,$5)`,
        [id,source,nativeId,{text},'0'.repeat(64)]);
    async function propose(eventId,percent) {
      return proposeTaskProgress(db,{taskId:task,eventIds:[eventId],extractorVersion:'fixture/v1',
        assess:async()=>({progressPercent:percent,reason:`Assessment ${percent}`,
          evidenceEventIds:[eventId]})});
    }
    await propose(a,60);
    await propose(b,20);
    const base={taskId:task,resolverVersion:'synthetic-resolver/v1'};
    const unsure=await resolveTaskProgress(db,{...base,decide:async({proposals})=>{
      assert.equal(proposals.length,2);
      return {progressPercent:null,reason:'Conflicting evidence needs another check',evidenceEventIds:[]};
    }});
    assert.equal(unsure.status,'unresolved');
    const {rows:[before]}=await db.query('SELECT progress_percent,version FROM dashboard.task WHERE id=$1',[task]);
    assert.equal(before.progress_percent,null);
    assert.equal(Number(before.version),0);

    await assert.rejects(resolveTaskProgress(db,{...base,decide:async()=>{
      await propose(c,90); // A new proposal arrives after the decision snapshot.
      return {progressPercent:45,reason:'Earlier observations',evidenceEventIds:[a,b]};
    }}),/STALE_PROGRESS_PROPOSALS/);

    const applied=await resolveTaskProgress(db,{...base,decide:async({proposals,evidence,priorAccepted})=>{
      assert.equal(proposals.length,3);
      assert.equal(evidence.length,3);
      assert.equal(priorAccepted,null);
      return {progressPercent:75,reason:'The fix exists; successful signup is unverified',
        evidenceEventIds:[b,c]};
    }});
    assert.deepEqual(applied,{status:'applied',progressPercent:75,version:1});
    const {rows:[saved]}=await db.query('SELECT progress_percent,progress_method,version FROM dashboard.task WHERE id=$1',[task]);
    assert.equal(Number(saved.progress_percent),75);
    assert.equal(saved.progress_method,'assistant_estimate');
    assert.equal(Number(saved.version),1);
    const {rows:[audit]}=await db.query('SELECT actor,resolution_rule,before_value,after_value FROM dashboard.entity_history WHERE task_id=$1',[task]);
    assert.equal(audit.actor,'assistant');
    assert.equal(audit.resolution_rule,'assistant_evidence');
    assert.equal(audit.before_value.progressPercent,null);
    assert.deepEqual(new Set(audit.after_value.evidenceEventIds),new Set([b,c]));
    assert.equal(audit.after_value.consideredProposalIds.length,3);
    assert.equal((await resolveTaskProgress(db,{...base,decide:async()=>{throw Error('not called');}})).status,'no_proposals');

    await propose(c,85); // New task version and event evidence still see prior decision.
    await resolveTaskProgress(db,{...base,decide:async({priorAccepted,evidence})=>{
      assert.equal(priorAccepted.progressPercent,75);
      assert.deepEqual(new Set(evidence.map(x=>x.id)),new Set([b,c]));
      return {progressPercent:85,reason:'New evidence changes the estimate',evidenceEventIds:[c]};
    }});
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.entity_history WHERE task_id=$1',[task]);
    assert.equal(count,2);
    await propose(a,45);
    await assert.rejects(resolveTaskProgress(db,{...base,decide:async()=>{
      await db.query('UPDATE dashboard.task SET title=$2 WHERE id=$1',[task,'Changed while resolving']);
      return {progressPercent:45,reason:'Based on the old task description',evidenceEventIds:[a]};
    }}),/STALE_TASK/);
    const {rows:[{count:stillTwo}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.entity_history WHERE task_id=$1',[task]);
    assert.equal(stillTwo,2);
  } finally {await db.close();}
});

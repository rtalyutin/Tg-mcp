import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {proposeTaskProgress} from '../src/progress-assessment.mjs';

test('an assistant assessment is evidenced, idempotent and remains a proposal', async () => {
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),task=randomUUID(),a=randomUUID(),b=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'chatgpt','synthetic']);
    await db.query('INSERT INTO dashboard.task(id,title,expected_result) VALUES ($1,$2,$3)',
      [task,'Release a test page','A reachable page with a working form']);
    for (const [id,nativeId] of [[a,'one'],[b,'two']])
      await db.query(`INSERT INTO dashboard.source_event
        (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
        VALUES ($1,$2,$3,'1','thread','2026-09-24T00:00:00Z',$4,$5)`,
        [id,source,nativeId,{text:`Synthetic ${nativeId}`},'0'.repeat(64)]);
    const arguments_={taskId:task,eventIds:[a,b],extractorVersion:'synthetic-judge/v1'};
    const assess=async({task:given,evidence})=>{
      assert.equal(given.expectedResult,'A reachable page with a working form');
      assert.equal(evidence.length,2);
      return {progressPercent:40,reason:'Page exists; form is unverified',evidenceEventIds:[a]};
    };
    const first=await proposeTaskProgress(db,{...arguments_,assess});
    assert.equal(first.status,'proposed');
    const second=await proposeTaskProgress(db,{...arguments_,eventIds:[b,a],assess});
    assert.deepEqual(second,{...first,status:'replayed'});
    const {rows:[saved]}=await db.query('SELECT proposed_change FROM dashboard.change_proposal WHERE id=$1',
      [first.proposalId]);
    assert.deepEqual(saved.proposed_change.evidenceEventIds,[a]);
    assert.equal(saved.proposed_change.progressPercent,40);
    const {rows:[canonical]}=await db.query('SELECT progress_percent,progress_method FROM dashboard.task WHERE id=$1',[task]);
    assert.equal(canonical.progress_percent,null);
    assert.equal(canonical.progress_method,null);

    await assert.rejects(proposeTaskProgress(db,{...arguments_,assess:async()=>({
      progressPercent:90,reason:'Contradictory assessment',evidenceEventIds:[b]
    })}),/PROGRESS_PROPOSAL_CONFLICT/);
    const abstained=await proposeTaskProgress(db,{...arguments_,extractorVersion:'synthetic-judge/v2',
      assess:async()=>({progressPercent:null,reason:'No result evidence',evidenceEventIds:[]})});
    assert.equal(abstained.progressPercent,null);
    await assert.rejects(proposeTaskProgress(db,{...arguments_,extractorVersion:'synthetic-judge/v3',
      assess:async()=>({progressPercent:100,reason:'Invented reference',evidenceEventIds:[randomUUID()]})
    }),/INVALID_PROGRESS_ASSESSMENT/);
    await assert.rejects(proposeTaskProgress(db,{...arguments_,extractorVersion:'synthetic-judge/v4',
      assess:async()=>{
        await db.query('UPDATE dashboard.task SET version=version+1 WHERE id=$1',[task]);
        return {progressPercent:55,reason:'Based on the earlier task version',evidenceEventIds:[a]};
      }
    }),/STALE_TASK/);
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.change_proposal');
    assert.equal(count,1);
  } finally {await db.close();}
});

test('unknown references, unsupported assessments and stale task versions do not write proposals', async () => {
  const db=new PGlite();
  try {
    await migrate(db);
    const task=randomUUID(),missing=randomUUID();
    await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2)',[task,'Synthetic']);
    const base={taskId:task,eventIds:[missing],extractorVersion:'judge/v1'};
    await assert.rejects(proposeTaskProgress(db,{...base,assess:async()=>({
      progressPercent:50,reason:'No actual event',evidenceEventIds:[missing]
    })}),/UNKNOWN_EVIDENCE_EVENT/);
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.change_proposal');
    assert.equal(count,0);
  } finally {await db.close();}
});

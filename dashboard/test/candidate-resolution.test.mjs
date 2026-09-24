import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {extractEventCandidates} from '../src/candidate-extraction.mjs';
import {resolveProjectCandidate,resolveTaskCandidate} from '../src/candidate-resolution.mjs';
import {readOwnerVisibleGraph} from '../src/visible-graph.mjs';

test('two messages resolve to two projects and one shared task without duplicate identities',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),eventA=randomUUID(),eventB=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'chatgpt','synthetic']);
    for (const [id,native] of [[eventA,'a'],[eventB,'b']])
      await db.query(`INSERT INTO dashboard.source_event
        (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
        VALUES ($1,$2,$3,'1','thread','2026-09-24T00:00:00Z',$4,$5)`,
        [id,source,native,{text:`Synthetic ${native}`},'0'.repeat(64)]);
    async function candidates(eventId,prefix,projectTitle,taskTitle) {
      const result=await extractEventCandidates(db,{eventId,extractorVersion:'fixture/v1',
        extract:async()=>({candidates:[
          {kind:'project',key:`${prefix}-p`,title:projectTitle,reason:'Explicit project'},
          {kind:'task',key:`${prefix}-t`,title:taskTitle,expectedResult:'Working page',
            projectHints:[projectTitle],reason:'Explicit task'}
        ]})});
      return {project:result.candidates.find(x=>x.kind==='project_candidate').proposalId,
        task:result.candidates.find(x=>x.kind==='task_candidate').proposalId};
    }
    const a=await candidates(eventA,'a','Alpha','Publish page');
    const b=await candidates(eventB,'b','Beta','Same task reworded');
    const base={resolverVersion:'synthetic-identity/v1'};
    const projectA=await resolveProjectCandidate(db,{...base,proposalId:a.project,
      decide:async({existing})=>{
        assert.equal(existing.projects.length,0);
        return {action:'create',reason:'New explicit project'};
      }});
    assert.equal(projectA.status,'created');
    const taskA=await resolveTaskCandidate(db,{...base,proposalId:a.task,
      decide:async()=>({action:'create',reason:'New task',projectIds:[projectA.projectId]})});
    assert.equal(taskA.status,'created');
    assert.deepEqual(await resolveProjectCandidate(db,{...base,proposalId:a.project,
      decide:async()=>{throw Error('must not decide again');}}),
      {status:'replayed',action:'created',projectId:projectA.projectId});
    const projectB=await resolveProjectCandidate(db,{...base,proposalId:b.project,
      decide:async()=>({action:'create',reason:'Different project'})});
    const taskB=await resolveTaskCandidate(db,{...base,proposalId:b.task,
      decide:async({existing,candidate})=>{
        assert.equal(candidate.title,'Same task reworded');
        assert.equal(existing.tasks.length,1);
        return {action:'link',existingId:taskA.taskId,reason:'Same expected result and outcome',
          projectIds:[projectB.projectId]};
      }});
    assert.equal(taskB.taskId,taskA.taskId);
    const graph=await readOwnerVisibleGraph(db);
    assert.equal(graph.projects.length,2);
    assert.equal(graph.tasks.length,1);
    assert.equal(graph.tasks[0].title,'Publish page');
    assert.deepEqual(new Set(graph.taskProjects.map(x=>x.projectId)),
      new Set([projectA.projectId,projectB.projectId]));
    assert.equal(graph.tasks[0].stateValue,null);
    assert.equal(graph.tasks[0].progressPercent,null);
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.candidate_resolution');
    assert.equal(count,4);
    const {rows:history}=await db.query(`SELECT proposal_id FROM dashboard.entity_history
      WHERE resolution_rule='candidate_identity'`);
    assert.deepEqual(new Set(history.map(x=>x.proposal_id)),
      new Set([a.project,a.task,b.project,b.task]));

    await db.query('INSERT INTO dashboard.project_visibility(project_id,hidden) VALUES ($1,true)',
      [projectB.projectId]);
    assert.equal((await readOwnerVisibleGraph(db)).tasks.length,0);
  } finally {await db.close();}
});

test('uncertain or stale identity decisions leave canonical tables unchanged',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(),event=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'codex','synthetic']);
    await db.query(`INSERT INTO dashboard.source_event
      (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest)
      VALUES ($1,$2,'one','1','thread','2026-09-24T00:00:00Z',$3,$4)`,
      [event,source,{text:'Synthetic'},'0'.repeat(64)]);
    const {candidates:[candidate]}=await extractEventCandidates(db,{eventId:event,
      extractorVersion:'fixture/v1',extract:async()=>({candidates:[
        {kind:'project',key:'p',title:'Potential',reason:'Ambiguous project'}]})});
    const base={proposalId:candidate.proposalId,resolverVersion:'synthetic/v1'};
    assert.equal((await resolveProjectCandidate(db,{...base,
      decide:async()=>({action:'defer',reason:'Identity unclear'})})).status,'deferred');
    await assert.rejects(resolveProjectCandidate(db,{...base,decide:async()=>{
      await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$2)',[randomUUID(),'Appeared during decision']);
      return {action:'create',reason:'Old snapshot'};
    }}),/STALE_IDENTITY_CONTEXT/);
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM dashboard.candidate_resolution');
    assert.equal(count,0);
    const {rows:projects}=await db.query('SELECT title FROM dashboard.project');
    assert.deepEqual(projects.map(x=>x.title),['Appeared during decision']);
  } finally {await db.close();}
});

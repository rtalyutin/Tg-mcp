import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {importCuratedSnapshot} from '../src/curated-snapshot.mjs';
import {createTaskPlan} from '../src/task-plan.mjs';

const snapshot=as_of=>({schema:'dashboard-curated-snapshot/1',as_of,coverage:'partial',
  excluded_project_titles:[],sources:{doc:{title:'Evidence'}},
  projects:[{id:'p',title:'Project'}],
  tasks:[{id:'t',title:'Task',project_ids:['p'],progress_percent:null,evidence:['doc']}],
  automations:[]});

test('task dates persist separately from daily snapshots, and stale or invalid edits cannot overwrite them',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    await importCuratedSnapshot(db,snapshot('2026-09-27'));
    const plan=createTaskPlan(db);
    assert.deepEqual(await plan.read(),[]);
    const first=await plan.write({task_id:'t',start_date:'2026-10-01',end_date:'2026-10-04',version:0});
    assert.deepEqual(first,{task_id:'t',start_date:'2026-10-01',end_date:'2026-10-04',version:1});
    await assert.rejects(plan.write({task_id:'t',start_date:'2026-10-02',end_date:'2026-10-05',version:0}),/TASK_PLAN_CONFLICT/);
    await assert.rejects(plan.write({task_id:'t',start_date:'2026-10-02',end_date:'2026-10-05',version:3}),/TASK_PLAN_CONFLICT/);
    await assert.rejects(plan.write({task_id:'missing',start_date:'2026-10-01',end_date:'2026-10-04',version:0}),/TASK_NOT_FOUND/);
    for (const [start_date,end_date] of [['2026-02-30','2026-03-01'],['2026-10-05','2026-10-04'],['2026-10-01',null]])
      await assert.rejects(plan.write({task_id:'t',start_date,end_date,version:1}),/INVALID_TASK_PLAN/);
    await importCuratedSnapshot(db,snapshot('2026-09-28'));
    assert.deepEqual(await plan.read(),[first]);
    const clear=await plan.write({task_id:'t',start_date:null,end_date:null,version:1});
    assert.deepEqual(clear,{task_id:'t',start_date:null,end_date:null,version:2});
    assert.equal((await plan.write({task_id:'t',start_date:'2026-11-01',end_date:'2026-11-01',version:2})).version,3);
  } finally {await db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {importCuratedSnapshot,readCuratedSnapshot,validateCuratedSnapshot} from '../src/curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from '../src/curated-snapshot-gateway.mjs';

const snapshot=()=>({
  schema:'dashboard-curated-snapshot/1',coverage:'partial',
  excluded_project_titles:['Исключённый проект'],sources:{doc:{title:'Проверенный источник'}},
  projects:[{id:'work',title:'Работа'}],
  tasks:[{id:'step',title:'Проверить',project_ids:['work'],progress_percent:null,evidence:['doc']}],
  automations:[]
});

test('curated import, readback and exclusion are enforced against the database',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const data=snapshot();
    const receipt=await importCuratedSnapshot(db,data);
    assert.equal(receipt.tasks,1);
    assert.deepEqual(await readCuratedSnapshot(db),data);
    await assert.rejects(importCuratedSnapshot(db,{...data,projects:[...data.projects,{id:'help',title:'ИСКЛЮЧЁННЫЙ ПРОЕКТ'}]}),/INVALID_CURATED_SNAPSHOT/);
    const child={...data,tasks:[{...data.tasks[0],project_ids:['work','help']}]};
    await assert.rejects(importCuratedSnapshot(db,child),/INVALID_CURATED_SNAPSHOT/);
    assert.deepEqual(await readCuratedSnapshot(db),data,'rejected input never replaces the stored snapshot');
  } finally {await db.close();}
});

test('snapshot reader refuses a role with write or source-reading privileges',async()=>{
  const cases=[{can_read:true,can_insert:false,can_update:false,can_read_sources:false},
    {can_read:true,can_insert:true,can_update:false,can_read_sources:false},
    {can_read:true,can_insert:false,can_update:false,can_read_sources:true}];
  for(const [index,rights] of cases.entries()){
    let closed=false;
    const connection={query:async()=>({rows:[rights]}),close:async()=>{closed=true;}};
    if(index===0){const gateway=await createCuratedSnapshotGateway('fake',{connect:()=>connection});await gateway.close();}
    else {await assert.rejects(createCuratedSnapshotGateway('fake',{connect:()=>connection}),/DASHBOARD_SNAPSHOT_ROLE_INVALID/);}
    assert.equal(closed,true);
  }
  assert.throws(()=>validateCuratedSnapshot({...snapshot(),excluded_project_titles:[42]}),/INVALID_CURATED_SNAPSHOT/);
});

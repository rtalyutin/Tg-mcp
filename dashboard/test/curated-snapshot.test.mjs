import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {importCuratedSnapshot,readCuratedSnapshot,validateCuratedSnapshot} from '../src/curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from '../src/curated-snapshot-gateway.mjs';

const snapshot=()=>({
  schema:'dashboard-curated-snapshot/1',coverage:'partial',
  excluded_project_titles:['Fixture Hidden'],sources:{doc:{title:'Проверенный источник'}},
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
    await assert.rejects(importCuratedSnapshot(db,{...data,projects:[...data.projects,{id:'help',title:'FIXTURE HIDDEN'}]}),/INVALID_CURATED_SNAPSHOT/);
    const child={...data,tasks:[{...data.tasks[0],project_ids:['work','help']}]};
    await assert.rejects(importCuratedSnapshot(db,child),/INVALID_CURATED_SNAPSHOT/);
    const validAutomation={id:'daily',title:'Daily check',enabled:true,
      schedule:'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',timezone:'Europe/Moscow',evidence:['doc']};
    for (const bad of [{}, {...validAutomation,schedule:undefined},
      {...validAutomation,evidence:['missing']}, {...validAutomation,enabled:false}]) {
      await assert.rejects(importCuratedSnapshot(db,{...data,automations:[bad]}),/INVALID_CURATED_SNAPSHOT/);
    }
    await importCuratedSnapshot(db,{...data,automations:[validAutomation]});
    await assert.rejects(importCuratedSnapshot(db,{...data,automations:[validAutomation,validAutomation]}),/INVALID_CURATED_SNAPSHOT/);
    await importCuratedSnapshot(db,data);
    assert.deepEqual(await readCuratedSnapshot(db),data,'rejected input never replaces the stored snapshot');
  } finally {await db.close();}
});

test('snapshot reader refuses a role with write or source-reading privileges',async()=>{
  const allowed={can_read:true,can_insert:false,can_update:false,can_delete:false,
    can_truncate:false,can_read_sources:false};
  const cases=[allowed,...['can_insert','can_update','can_delete','can_truncate','can_read_sources']
    .map(privilege=>({...allowed,[privilege]:true}))];
  for(const [index,rights] of cases.entries()){
    let closed=false;
    const connection={query:async()=>({rows:[rights]}),close:async()=>{closed=true;}};
    if(index===0){const gateway=await createCuratedSnapshotGateway('fake',{connect:()=>connection});await gateway.close();}
    else {await assert.rejects(createCuratedSnapshotGateway('fake',{connect:()=>connection}),/DASHBOARD_SNAPSHOT_ROLE_INVALID/);}
    assert.equal(closed,true);
  }
  assert.throws(()=>validateCuratedSnapshot({...snapshot(),excluded_project_titles:[42]}),/INVALID_CURATED_SNAPSHOT/);
});

test('a project can persist several reviewed group memberships',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const data={...snapshot(),project_groups:[{id:'g-1',title:'Группа 1'},{id:'g-2',title:'Группа 2'}],
      projects:[{id:'work',title:'Работа',group_ids:['g-1','g-2']}]};
    await importCuratedSnapshot(db,data);
    assert.deepEqual((await readCuratedSnapshot(db)).projects[0].group_ids,['g-1','g-2']);
    for (const group_ids of [[],['g-1','g-1'],['missing'],['g-1',42]]) {
      await assert.rejects(importCuratedSnapshot(db,{...data,projects:[{...data.projects[0],group_ids}]}),/INVALID_CURATED_SNAPSHOT/);
    }
    assert.deepEqual((await readCuratedSnapshot(db)).projects[0].group_ids,['g-1','g-2']);
  } finally {await db.close();}
});

test('gateway reads the stored snapshot separately from all persisted group memberships',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const data=snapshot();
    await importCuratedSnapshot(db,data);
    await db.query(`INSERT INTO dashboard.projects_groups(project_id,group_code)
      VALUES ('work','Группа 1'),('work','Группа 2')`);
    const gateway=await createCuratedSnapshotGateway('test',{connect:()=>({
      query:(...args)=>db.query(...args),close:async()=>{}
    }),sharedRole:true});
    try {
      assert.deepEqual(await gateway.readSnapshot(),data);
      const grouped=await gateway.read();
      assert.deepEqual(grouped.projects[0].group_codes,['Группа 1','Группа 2']);
      assert.equal(Object.hasOwn(grouped.projects[0],'group_code'),false);
      assert.deepEqual(grouped.tasks,data.tasks);
    } finally {await gateway.close();}
  } finally {await db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createDashboardMigrationService,validateDashboardMigrationConfig} from '../src/migration-service.mjs';
import {createCuratedSnapshotGateway} from '../src/curated-snapshot-gateway.mjs';
import {createSnapshotUpdateService,validateSnapshotUpdateConfig} from '../src/snapshot-update-service.mjs';

const snapshot=()=>({schema:'dashboard-curated-snapshot/1',as_of:'2026-09-24',coverage:'partial',
  excluded_project_titles:['Скрытый проект'],sources:{doc:{title:'Проверенный источник'}},
  projects:[{id:'work',title:'Работа'}],tasks:[{id:'step',title:'Проверить',project_ids:['work'],progress_percent:null,evidence:['doc']}],automations:[]});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const config={credentialId:'14a4d6e9-63b0-44ea-9f45-a6237692aef1',approvedDigest:digest(snapshot()),
  databaseUrl:'postgres://existing_user@private.invalid/existing_service'};

test('migration and updater use the configured existing database login',()=>{
  assert.equal(validateDashboardMigrationConfig({}),null);
  assert.equal(validateDashboardMigrationConfig({DASHBOARD_MIGRATION_ENABLED:'false'}),null);
  const env={DASHBOARD_MIGRATION_ENABLED:'true',DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID:config.credentialId,
    DASHBOARD_APPROVED_SNAPSHOT_DIGEST:config.approvedDigest,
    DATABASE_URL:config.databaseUrl};
  assert.deepEqual(validateDashboardMigrationConfig(env),config);
  assert.throws(()=>validateDashboardMigrationConfig({...env,DATABASE_URL:undefined}),/DASHBOARD_MIGRATION_CONFIG_INVALID/);
  assert.throws(()=>validateDashboardMigrationConfig({...env,DATABASE_URL:'postgres://invalid'}),/DASHBOARD_MIGRATION_CONFIG_INVALID/);
  assert.throws(()=>validateDashboardMigrationConfig({...env,DASHBOARD_APPROVED_SNAPSHOT_DIGEST:'wrong'}),/DASHBOARD_MIGRATION_CONFIG_INVALID/);
  assert.deepEqual(validateSnapshotUpdateConfig(env),{credentialId:config.credentialId,databaseUrl:config.databaseUrl});
  assert.equal(validateSnapshotUpdateConfig({DATABASE_URL:config.databaseUrl}),null);
  assert.throws(()=>validateSnapshotUpdateConfig({...env,DATABASE_URL:'bad'}),/DASHBOARD_SNAPSHOT_WRITE_CONFIG_INVALID/);
});

test('daily updates keep earlier entries and exclusion in the shared database',async()=>{
  const db=new PGlite();
  try {
    await db.exec('CREATE TABLE public.outreach_fixture (id int PRIMARY KEY, value text NOT NULL)');
    await db.exec("INSERT INTO public.outreach_fixture VALUES (1,'keep')");
    const adapter={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn),close:async()=>{}};
    const reader=async (_url,options)=>createCuratedSnapshotGateway(config.databaseUrl,{connect:()=>adapter,...options});
    await createDashboardMigrationService(config,{connect:()=>adapter,openReader:reader}).apply({snapshot:snapshot(),expected_digest:config.approvedDigest});
    let opened=0;
    const service=createSnapshotUpdateService(config,{
      connect:()=>{opened++;return adapter;},
      openReader:reader
    });
    const state=await service.readState();
    assert.equal(state.digest,config.approvedDigest);
    const next={...snapshot(),as_of:'2026-09-25',sources:{...snapshot().sources,new:{title:'Другая проверка'}},
      projects:[...snapshot().projects,{id:'new',title:'Новое'}],
      tasks:[...snapshot().tasks,{id:'new-step',title:'Сделать',project_ids:['new'],progress_percent:null,evidence:['new']}]};
    const updated=await service.update({snapshot:next,expected_current_digest:state.digest});
    assert.equal(updated.readback_verified,true);
    assert.equal(updated.replayed,false);
    assert.equal(updated.tasks,2);
    assert.equal((await service.update({snapshot:next,expected_current_digest:state.digest})).replayed,true);
    await assert.rejects(service.update({snapshot:{...next,as_of:'2026-09-26'},expected_current_digest:state.digest}),/DASHBOARD_SNAPSHOT_CONFLICT/);
    await assert.rejects(service.update({snapshot:{...next,excluded_project_titles:[],as_of:'2026-09-26'},expected_current_digest:updated.digest}),/DASHBOARD_UPDATE_INPUT_INVALID/);
    await assert.rejects(service.update({snapshot:{...next,tasks:[],as_of:'2026-09-26'},expected_current_digest:updated.digest}),/DASHBOARD_UPDATE_INPUT_INVALID/);
    await assert.rejects(service.update({snapshot:{...next,sources:{...next.sources,doc:{title:'Подменённый источник'}},as_of:'2026-09-26'},expected_current_digest:updated.digest}),/DASHBOARD_UPDATE_INPUT_INVALID/);
    assert.equal((await service.readState()).digest,updated.digest);
    assert.deepEqual((await db.query('SELECT * FROM public.outreach_fixture')).rows,[{id:1,value:'keep'}]);
    const {rows:objects}=await db.query("SELECT schemaname,tablename FROM pg_tables WHERE tablename LIKE 'dashboard_%'");
    assert.deepEqual(objects.map(x=>x.schemaname),['dashboard']);
    assert.ok(opened>=5);
  } finally {await db.close();}
});

test('only the approved snapshot migrates into dashboard schema and returns a readback receipt',async()=>{
  const db=new PGlite();
  try {
    const adapter={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn),close:async()=>{}};
    let connects=0;
    const service=createDashboardMigrationService(config,{
      connect:()=>{connects++;return adapter;},
      openReader:async (_url,options)=>createCuratedSnapshotGateway(config.databaseUrl,{connect:()=>adapter,...options})
    });
    const input={snapshot:snapshot(),expected_digest:config.approvedDigest};
    await assert.rejects(service.apply({...input,expected_digest:'0'.repeat(64)}),/DASHBOARD_SNAPSHOT_NOT_APPROVED/);
    await assert.rejects(service.apply({...input,snapshot:{...snapshot(),projects:[{id:'work',title:'Скрытый проект'}]}}),/DASHBOARD_MIGRATION_INPUT_INVALID/);
    assert.equal(connects,0,'unapproved input does not contact the database');
    const first=await service.apply(input);
    assert.deepEqual(first,{schema_version:4,applied:true,digest:config.approvedDigest,projects:1,tasks:1,automations:0,verified:true});
    const second=await service.apply(input);
    assert.equal(second.applied,false);
    assert.equal(connects,2);
    await db.query('UPDATE dashboard.curated_snapshot SET digest=$1 WHERE singleton=1',['1'.repeat(64)]);
    await assert.rejects(service.apply(input),/DASHBOARD_SNAPSHOT_ALREADY_INITIALIZED/);
    assert.equal((await db.query('SELECT digest FROM dashboard.curated_snapshot')).rows[0].digest,'1'.repeat(64));
    const {rows}=await db.query('SELECT count(*)::int AS n FROM dashboard.curated_snapshot');
    assert.equal(rows[0].n,1);
  } finally {await db.close();}
});

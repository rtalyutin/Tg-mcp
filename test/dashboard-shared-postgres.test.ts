import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';

test('Dashboard installs and updates inside the existing PostgreSQL without touching service tables',
  {skip:!process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false},async()=>{
  const {validateDashboardMigrationConfig,createDashboardMigrationService}=await import(
    new URL('../dashboard/src/migration-service.mjs',import.meta.url).href);
  const {validateSnapshotUpdateConfig,createSnapshotUpdateService}=await import(
    new URL('../dashboard/src/snapshot-update-service.mjs',import.meta.url).href);
  const databaseUrl=process.env.OUTREACH_TEST_DATABASE_URL!;
  const db=new pg.Pool({connectionString:databaseUrl});
  const marker=`outreach_fixture_${randomUUID().replaceAll('-','')}`;
  const snapshot={schema:'dashboard-curated-snapshot/1',as_of:'2026-09-24',coverage:'partial',
    excluded_project_titles:['Не собирать'],sources:{fixture:{title:'Синтетический источник'}},
    projects:[{id:'fixture-project',title:'Проверка'}],
    tasks:[{id:'fixture-task',title:'Подтвердить',project_ids:['fixture-project'],progress_percent:null,evidence:['fixture']}],
    automations:[]};
  const digest=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  try {
    await db.query(`CREATE TABLE public.${marker} (id integer PRIMARY KEY, value text NOT NULL)`);
    await db.query(`INSERT INTO public.${marker} VALUES (1,'unchanged')`);
    const env={DATABASE_URL:databaseUrl,DASHBOARD_MIGRATION_ENABLED:'true',
      DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID:'14a4d6e9-63b0-44ea-9f45-a6237692aef1'};
    const migration=createDashboardMigrationService(validateDashboardMigrationConfig(env));
    const receipt=await migration.apply({snapshot});
    assert.equal(receipt.schema_version,4);assert.equal(receipt.verified,true);
    const updater=createSnapshotUpdateService(validateSnapshotUpdateConfig(env));
    const state=await updater.readState();assert.equal(state.digest,digest);
    const next={...snapshot,as_of:'2026-09-25'};
    const updated=await updater.update({snapshot:next});
    assert.equal(updated.readback_verified,true);
    const {rows:[row]}=await db.query(`SELECT value FROM public.${marker} WHERE id=1`);
    assert.equal(row.value,'unchanged');
    const {rows:outside}=await db.query("SELECT table_schema FROM information_schema.tables WHERE table_name='dashboard_schema_migration'");
    assert.deepEqual(outside.map(x=>x.table_schema),['dashboard']);
    const {rows:[stored]}=await db.query('SELECT payload,digest FROM dashboard.curated_snapshot WHERE singleton=1');
    assert.deepEqual(stored.payload,next);assert.equal(stored.digest,updated.digest);
  } finally {
    await db.query('DROP SCHEMA IF EXISTS dashboard CASCADE').catch(()=>{});
    await db.query(`DROP TABLE IF EXISTS public.${marker}`).catch(()=>{});
    await db.end();
  }
});

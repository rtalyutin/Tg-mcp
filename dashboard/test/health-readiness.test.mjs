import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardReadiness} from '../src/health-readiness.mjs';

const validSnapshot={schema:'dashboard-curated-snapshot/1',coverage:'partial',projects:[],tasks:[],automations:[],sources:{},excluded_project_titles:[]};

function fixture(overrides={}) {
  const statements=[];
  const client={
    async query(sql) {
      statements.push(sql);
      if (overrides.failDatabase && sql==='SELECT 1') throw new Error('private connection detail');
      return {rows:[]};
    },
    release(error) { if (error) statements.push('DESTROYED'); else statements.push('RELEASED'); },
  };
  let snapshotReads=0,writerReads=0,assetReads=0,mcpReads=0;
  const check=createDashboardReadiness({
    pool:{connect:async()=>client},
    schemaCheck:async db=>{
      await db.query('SELECT version,digest FROM dashboard.dashboard_schema_migration');
      if (overrides.failSchema) throw new Error('private schema detail');
    },
    dashboardSnapshot:{read:async options=>{
      snapshotReads++; assert.deepEqual(options,{timeoutMs:2000});
      if (overrides.failSnapshot) throw new Error('private snapshot detail');
      return overrides.invalidSnapshot ? {...validSnapshot,coverage:'complete'} : validSnapshot;
    }},
    dashboardWriter:overrides.writer===false ? undefined : {readState:async options=>{
      writerReads++; assert.deepEqual(options,{timeoutMs:2000});
      if (overrides.failWriter) throw new Error('private writer detail');
      return {coverage:'partial',digest:'must-not-be-returned'};
    }},
    snapshotWriterConfigured:overrides.writerConfigured ?? overrides.writer!==false,
    dashboardEnabled:overrides.dashboardEnabled===true,
    dashboardMcp:overrides.mcpMissing ? undefined : {healthCheck:async options=>{
      mcpReads++; assert.deepEqual(options,{timeoutMs:2000});
      if (overrides.failMcp) throw new Error('private MCP detail');
    }},
    checkAssets:async()=>{assetReads++;if (overrides.failAssets) throw new Error('private asset path');},
  });
  return {check,statements,counts:()=>({snapshotReads,writerReads,assetReads,mcpReads})};
}

test('readiness passes when required components are ready and reports only fixed states',async()=>{
  const f=fixture();
  const result=await f.check();
  assert.deepEqual(result,{status:'ok',checks:{
    database:'ok',dashboard_schema:'ok',snapshot_reader:'ok',snapshot_writer:'ok',
    dashboard_assets:'ok',dashboard_mcp:'not_configured',
  }});
  assert.ok(f.statements.includes('BEGIN READ ONLY'));
  assert.ok(f.statements.includes('SET LOCAL statement_timeout = 2000'));
  assert.ok(f.statements.includes('ROLLBACK'));
  assert.deepEqual(f.counts(),{snapshotReads:1,writerReads:1,assetReads:1,mcpReads:0});
  assert.doesNotMatch(JSON.stringify(result),/digest|private|must-not/);
});

test('database and schema failures are distinguished without exposing driver details',async()=>{
  const database=await fixture({failDatabase:true}).check();
  assert.equal(database.status,'unhealthy');
  assert.equal(database.checks.database,'failed');
  assert.equal(database.checks.dashboard_schema,'unknown');
  assert.doesNotMatch(JSON.stringify(database),/private connection detail/);

  const schema=await fixture({failSchema:true}).check();
  assert.equal(schema.status,'unhealthy');
  assert.equal(schema.checks.database,'ok');
  assert.equal(schema.checks.dashboard_schema,'failed');
});

test('invalid or unavailable snapshot, configured writer, and assets make readiness fail',async()=>{
  for (const overrides of [{invalidSnapshot:true},{failSnapshot:true},{failWriter:true},{failAssets:true}]) {
    const result=await fixture(overrides).check();
    assert.equal(result.status,'unhealthy');
    assert.ok(Object.values(result.checks).every(value=>['ok','failed','unknown','not_configured'].includes(value)));
    assert.doesNotMatch(JSON.stringify(result),/private|digest/);
  }
  const withoutWriter=await fixture({writer:false}).check();
  assert.equal(withoutWriter.status,'ok');
  assert.equal(withoutWriter.checks.snapshot_writer,'not_configured');
  const missingConfiguredWriter=await fixture({writer:false,writerConfigured:true}).check();
  assert.equal(missingConfiguredWriter.status,'unhealthy');
  assert.equal(missingConfiguredWriter.checks.snapshot_writer,'failed');
});

test('Dashboard MCP is required only when explicitly enabled',async()=>{
  const enabled=await fixture({dashboardEnabled:true}).check();
  assert.equal(enabled.status,'ok');
  assert.equal(enabled.checks.dashboard_mcp,'ok');

  const missing=await fixture({dashboardEnabled:true,mcpMissing:true}).check();
  assert.equal(missing.status,'unhealthy');
  assert.equal(missing.checks.dashboard_mcp,'failed');
  const disabled=await fixture({dashboardEnabled:false,mcpMissing:true}).check();
  assert.equal(disabled.status,'ok');
  assert.equal(disabled.checks.dashboard_mcp,'not_configured');
});

test('overlapping requests share one readiness pass',async()=>{
  let releaseReader;
  let reads=0;
  const check=createDashboardReadiness({
    pool:{connect:async()=>({query:async()=>({rows:[]}),release(){}})},
    schemaCheck:async()=>{},
    dashboardSnapshot:{read:async()=>{reads++;await new Promise(resolve=>{releaseReader=resolve;});return validSnapshot;}},
    dashboardWriter:{readState:async()=>({})},
    checkAssets:async()=>{},
  });
  const first=check();
  const second=check();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);
  releaseReader();
  assert.deepEqual(await first,await second);
});

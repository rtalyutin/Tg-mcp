import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {importCuratedSnapshot} from '../src/curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from '../src/curated-snapshot-gateway.mjs';
import {createSnapshotUpdateService} from '../src/snapshot-update-service.mjs';

test('replayed JSON with reordered keys returns the digest actually stored',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const snapshot={schema:'dashboard-curated-snapshot/1',as_of:'2026-09-25',coverage:'partial',
      excluded_project_titles:[],sources:{fixture:{title:'Fixture'}},
      projects:[{id:'p',title:'Fixture project'}],
      tasks:[{id:'t',title:'Fixture task',project_ids:['p'],progress_percent:null,evidence:['fixture']}],
      automations:[]};
    const stored=await importCuratedSnapshot(db,snapshot);
    await db.query("INSERT INTO dashboard.projects_groups(project_id,group_code) VALUES('p','Fixture group')");
    const adapter={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn),close:async()=>{}};
    const service=createSnapshotUpdateService({databaseUrl:'fixture',credentialId:'fixture'},
      {connect:()=>adapter,openReader:(_url,options)=>createCuratedSnapshotGateway('fixture',
        {connect:()=>adapter,...options})});
    const reordered=Object.fromEntries(Object.entries(snapshot).reverse());
    const receipt=await service.update({snapshot:reordered});
    assert.equal(receipt.replayed,true);
    assert.equal(receipt.readback_verified,true);
    assert.equal(receipt.digest,stored.digest);
    assert.equal((await service.readState()).digest,stored.digest);
  } finally {await db.close();}
});

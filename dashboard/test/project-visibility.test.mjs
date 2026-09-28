import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {importCuratedSnapshot,readCuratedSnapshot} from '../src/curated-snapshot.mjs';
import {createProjectVisibility} from '../src/project-visibility.mjs';

const snapshot=as_of=>({schema:'dashboard-curated-snapshot/1',as_of,coverage:'partial',
  excluded_project_titles:[],sources:{doc:{title:'Evidence'}},
  projects:[{id:'p',title:'Project'},{id:'q',title:'Other'}],
  tasks:[{id:'shared',title:'Shared task',project_ids:['p','q'],progress_percent:null,evidence:['doc']}],
  automations:[]});

test('owner visibility persists across snapshot updates and can be restored with a versioned edit',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    await importCuratedSnapshot(db,snapshot('2026-09-27'));
    const visibility=createProjectVisibility(db);
    assert.deepEqual(await visibility.read(),[]);
    const hidden=await visibility.write({project_id:'p',hidden:true,version:0});
    assert.deepEqual(hidden,{project_id:'p',hidden:true,version:1});
    await assert.rejects(visibility.write({project_id:'p',hidden:false,version:0}),/PROJECT_VISIBILITY_CONFLICT/);
    await assert.rejects(visibility.write({project_id:'q',hidden:true,version:2}),/PROJECT_VISIBILITY_CONFLICT/);
    await assert.rejects(visibility.write({project_id:'absent',hidden:true,version:0}),/PROJECT_NOT_FOUND/);
    for (const bad of [{project_id:'p',hidden:'yes',version:1},{project_id:'p',hidden:true,version:-1},
      {project_id:'p',hidden:true,version:1,extra:1}])
      await assert.rejects(visibility.write(bad),/INVALID_PROJECT_VISIBILITY/);
    await importCuratedSnapshot(db,snapshot('2026-09-28'));
    assert.deepEqual(await visibility.read(),[hidden]);
    assert.equal((await readCuratedSnapshot(db)).tasks[0].project_ids.length,2,
      'hiding never rewrites shared tasks in the source snapshot');
    const restored=await visibility.write({project_id:'p',hidden:false,version:1});
    assert.deepEqual(restored,{project_id:'p',hidden:false,version:2});
    assert.deepEqual(await visibility.read(),[restored]);
  } finally {await db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {readUnfilteredCanonicalGraph} from '../src/canonical-graph.mjs';

test('internal snapshot retains shared identity, unknown progress, links and owner visibility', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const source = randomUUID(), folder = randomUUID(), a = randomUUID(), b = randomUUID();
    const shared = randomUUID(), dependent = randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'codex','synthetic']);
    await db.query('INSERT INTO dashboard.folder(id,source_id,native_id,title) VALUES ($1,$2,$3,$4)',
      [folder,source,'f1','Folder']);
    await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$2),($3,$4)',
      [a,'Alpha',b,'Beta']);
    await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2),($3,$4)',
      [shared,'Shared',dependent,'Dependent']);
    await db.query('INSERT INTO dashboard.task_project(task_id,project_id) VALUES ($1,$2),($1,$3)',
      [shared,a,b]);
    await db.query('INSERT INTO dashboard.task_relation(from_task_id,to_task_id,relation_type) VALUES ($1,$2,$3)',
      [shared,dependent,'blocks']);
    await db.query('INSERT INTO dashboard.project_folder(project_id,folder_id) VALUES ($1,$2)',[b,folder]);
    await db.query('INSERT INTO dashboard.project_visibility(project_id,hidden) VALUES ($1,true)',[b]);
    await db.query('INSERT INTO dashboard.folder_visibility(folder_id,hidden) VALUES ($1,true)',[folder]);

    const graph = await readUnfilteredCanonicalGraph(db);
    assert.equal(graph.projects.length,2);
    assert.equal(graph.tasks.length,2);
    assert.equal(graph.taskProjects.length,2);
    assert.deepEqual(new Set(graph.taskProjects.map(x=>x.projectId)),new Set([a,b]));
    assert.equal(graph.tasks.find(x=>x.id===shared).progressPercent,null);
    assert.equal(graph.tasks.find(x=>x.id===shared).progressMethod,null);
    assert.deepEqual(graph.taskRelations,[{fromTaskId:shared,toTaskId:dependent,relationType:'blocks'}]);
    assert.deepEqual(graph.projectFolders,[{projectId:b,folderId:folder}]);
    assert.equal(graph.projectVisibility[0].hidden,true);
    assert.equal(graph.folderVisibility[0].hidden,true);
    assert.equal(graph.projectVisibility[0].version,0);
    assert.ok(!('sourceEvents' in graph));
  } finally { await db.close(); }
});

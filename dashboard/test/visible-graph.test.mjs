import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {readOwnerVisibleGraph,filterCanonicalGraphForOwner} from '../src/visible-graph.mjs';

test('owner-visible DB graph omits hidden projects and every shared task touching one', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const source=randomUUID(), folder=randomUUID(), openA=randomUUID(), openB=randomUUID();
    const directHidden=randomUUID(), folderHidden=randomUUID();
    const safe=randomUUID(), directShared=randomUUID(), folderShared=randomUUID();
    const onlyHidden=randomUUID(), orphan=randomUUID();
    await db.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)',
      [source,'chatgpt','synthetic']);
    await db.query('INSERT INTO dashboard.folder(id,source_id,native_id,title) VALUES ($1,$2,$3,$4)',
      [folder,source,'hidden-folder','SECRET_FOLDER']);
    for (const [id,title] of [[openA,'Open A'],[openB,'Open B'],
      [directHidden,'SECRET_DIRECT'],[folderHidden,'SECRET_IN_FOLDER']])
      await db.query('INSERT INTO dashboard.project(id,title) VALUES ($1,$2)',[id,title]);
    for (const [id,title] of [[safe,'Safe'],[directShared,'SECRET_SHARED_DIRECT'],
      [folderShared,'SECRET_SHARED_FOLDER'],[onlyHidden,'SECRET_ONLY_HIDDEN'],[orphan,'Orphan']])
      await db.query('INSERT INTO dashboard.task(id,title) VALUES ($1,$2)',[id,title]);
    for (const [taskId,projectId] of [[safe,openA],[safe,openB],
      [directShared,openA],[directShared,directHidden],
      [folderShared,openB],[folderShared,folderHidden],[onlyHidden,directHidden]])
      await db.query('INSERT INTO dashboard.task_project(task_id,project_id) VALUES ($1,$2)',[taskId,projectId]);
    await db.query('INSERT INTO dashboard.project_visibility(project_id,hidden) VALUES ($1,true)',[directHidden]);
    await db.query('INSERT INTO dashboard.folder_visibility(folder_id,hidden) VALUES ($1,true)',[folder]);
    await db.query('INSERT INTO dashboard.project_folder(project_id,folder_id) VALUES ($1,$2)',[folderHidden,folder]);
    for (const [from,to] of [[safe,directShared],[folderShared,safe]])
      await db.query('INSERT INTO dashboard.task_relation(from_task_id,to_task_id,relation_type) VALUES ($1,$2,$3)',
        [from,to,'blocks']);

    const visible=await readOwnerVisibleGraph(db);
    assert.deepEqual(new Set(visible.projects.map(x=>x.id)),new Set([openA,openB]));
    assert.deepEqual(visible.tasks.map(x=>x.id),[safe]);
    assert.deepEqual(new Set(visible.taskProjects.map(x=>x.projectId)),new Set([openA,openB]));
    assert.deepEqual(visible.taskRelations,[]);
    assert.deepEqual(visible.folders,[]);
    assert.deepEqual(visible.projectFolders,[]);
    assert.equal(visible.tasks[0].progressPercent,null);
    assert.ok(!('projectVisibility' in visible) && !('folderVisibility' in visible));
    assert.doesNotMatch(JSON.stringify(visible),/SECRET_/);
  } finally {await db.close();}
});

test('a missing visibility table fails closed instead of treating all projects as visible', () => {
  assert.throws(() => filterCanonicalGraphForOwner({projects:[],tasks:[]}),/INVALID_CANONICAL_GRAPH/);
});

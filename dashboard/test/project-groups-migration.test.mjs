import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('project-group migration backfills every existing membership from the snapshot',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE SCHEMA dashboard;
      CREATE TABLE dashboard.curated_snapshot(singleton smallint PRIMARY KEY,payload jsonb NOT NULL);
      INSERT INTO dashboard.curated_snapshot VALUES(1,'{
        "projects":[
          {"id":"p1","display_group_id":"g1"},
          {"id":"p2","display_group_ids":["g1","g2"]}
        ],
        "project_groups":[
          {"id":"g1","title":"Группа один"},
          {"id":"g2","title":"Группа два"}
        ]
      }');`);
    await db.exec(await readFile(new URL('../migrations/005_projects_groups.sql',import.meta.url),'utf8'));
    const {rows}=await db.query('SELECT project_id,group_code FROM dashboard.projects_groups ORDER BY project_id,group_code');
    assert.deepEqual(rows,[
      {project_id:'p1',group_code:'Группа один'},
      {project_id:'p2',group_code:'Группа два'},
      {project_id:'p2',group_code:'Группа один'}
    ]);
    await assert.rejects(db.query("INSERT INTO dashboard.projects_groups(project_id,group_code) VALUES('p2','Группа один')"),/duplicate key/);
  } finally {await db.close();}
});

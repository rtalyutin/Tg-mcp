import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleGraph} from '../web/visibility-model.js';

test('one hidden project removes its shared task from every branch and restoration recovers source data',()=>{
  const snapshot={excluded_project_titles:[],projects:[{id:'p',title:'Project P'},
    {id:'q',title:'Project Q'}],tasks:[{id:'shared',project_ids:['p','q']},
    {id:'only-q',project_ids:['q']}]};
  const hidden=visibleGraph(snapshot,new Set(['p']));
  assert.deepEqual(hidden.projects.map(project=>project.id),['q']);
  assert.deepEqual(hidden.tasks.map(task=>task.id),['only-q']);
  assert.deepEqual(visibleGraph(snapshot,new Set()).tasks.map(task=>task.id),['shared','only-q']);
  assert.deepEqual(visibleGraph(snapshot,new Set(['p','q'])),{projects:[],tasks:[]});
  assert.equal(snapshot.tasks.length,2,'a display preference never mutates the snapshot');
});

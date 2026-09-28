import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {visibleGraph} from '../web/visibility-model.js';

const source=await readFile(new URL('../web/dashboard.js',import.meta.url),'utf8');
const functions=['groupProjects','selectExplorerData'].map(name=>{
  const body=source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(body,`${name} exists`);
  return body;
});
const selectExplorerData=vm.runInNewContext(`
  const normal=value=>value.toLocaleLowerCase('ru').replaceAll('ё','е').trim();
  ${functions.join('\n')}
  selectExplorerData;
`);

test('mobile folders reach every project and task with shared memberships',()=>{
  const definitions=Array.from({length:6},(_,i)=>({id:`g${i}`,title:`Группа ${i}`}));
  const projects=Array.from({length:41},(_,i)=>({id:`p${i}`,title:`Проект ${i}`,group_ids:[`g${i%6}`]}));
  projects[0].group_ids.push('g1');
  const tasks=Array.from({length:60},(_,i)=>({id:`t${i}`,title:`Задача ${i}`,projectIds:[`p${i%41}`]}));
  tasks[0].projectIds.push('p1');
  const result=selectExplorerData(projects,tasks,definitions,'');
  assert.equal(result.groups.length,6);
  assert.equal(result.filteredProjects.length,41);
  assert.equal(result.matchingTasks.length,60);
  const reachableProjects=new Set(result.groups.flatMap(group=>group.projects.map(project=>project.id)));
  const reachableTasks=new Set(result.groups.flatMap(group=>group.projects.flatMap(project=>
    result.matchingTasks.filter(task=>task.projectIds.includes(project.id)).map(task=>task.id))));
  assert.equal(reachableProjects.size,41);
  assert.equal(reachableTasks.size,60);
  assert.equal(result.groups.filter(group=>group.projects.some(project=>project.id==='p0')).length,2);
  assert.equal(result.groups.flatMap(group=>group.projects).filter(project=>project.id==='p0').length,2);
});

test('search opens task context while owner-hidden projects and shared tasks disappear',()=>{
  const projects=[
    {id:'p1',title:'Первый проект',group_ids:['g1']},
    {id:'p2',title:'Второй проект',group_ids:['g1','g2']},
  ];
  const tasks=[
    {id:'t1',title:'Скрытая задача',projectIds:['p1']},
    {id:'t2',title:'Общая задача',projectIds:['p1','p2']},
    {id:'t3',title:'Открытая задача',projectIds:['p2']},
  ];
  const definitions=[{id:'g1',title:'Работа'},{id:'g2',title:'Личное'}];
  const found=selectExplorerData(projects,tasks,definitions,'открытая');
  assert.deepEqual([...found.filteredProjects].map(project=>project.id),['p2']);
  assert.deepEqual([...found.matchingTasks].map(task=>task.id),['t3']);
  const graph=visibleGraph({projects,tasks:tasks.map(task=>({
    ...task,project_ids:task.projectIds
  }))},new Set(['p1']));
  const hidden=selectExplorerData(graph.projects,graph.tasks.map(task=>({
    ...task,projectIds:task.project_ids
  })),definitions,'');
  assert.deepEqual([...hidden.filteredProjects].map(project=>project.id),['p2']);
  assert.deepEqual([...hidden.matchingTasks].map(task=>task.id),['t3']);
  assert.equal(hidden.groups.some(group=>group.projects.some(project=>project.id==='p1')),false);
  const absent=selectExplorerData(graph.projects,graph.tasks.map(task=>({
    ...task,projectIds:task.project_ids
  })),definitions,'общая');
  assert.equal(absent.filteredProjects.length,0);
  assert.equal(absent.matchingTasks.length,0);
});

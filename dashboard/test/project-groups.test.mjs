import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../web/dashboard.js', import.meta.url), 'utf8');
const groupProjectsSource = dashboard.match(/function groupProjects\([\s\S]*?\n\}/)?.[0];
assert.ok(groupProjectsSource, 'dashboard.js must define groupProjects');
const groupProjects = vm.runInNewContext(`${groupProjectsSource}; groupProjects`);

test('groups curated projects by unique group codes and keeps original project IDs', () => {
  const projects = [
    {id:'p-1',title:'Первый',group_code:'YCS'},
    {id:'p-2',title:'Второй',group_code:'AI'},
    {id:'p-3',title:'Третий',group_code:'YCS'},
  ];
  const groups = JSON.parse(JSON.stringify(groupProjects(projects)));
  assert.deepEqual(groups.map(group=>group.title), ['AI','YCS']);
  assert.deepEqual(groups.find(group=>group.id==='YCS').projects.map(project=>project.id), ['p-1','p-3']);
  assert.deepEqual(groups.find(group=>group.id==='AI').projects.map(project=>project.id), ['p-2']);
});

test('resolves persisted display group IDs and makes missing assignments visible', () => {
  const projects = [
    {id:'p-1',title:'Проект 1',display_group_id:'g-1'},
    {id:'p-2',title:'Проект 2'},
  ];
  const groups = JSON.parse(JSON.stringify(groupProjects(projects, [{id:'g-1',title:'ЯрКиберСезон'}])));
  assert.equal(groups.find(group=>group.id==='g-1').title, 'ЯрКиберСезон');
  assert.deepEqual(groups.find(group=>group.id==='g-1').projects.map(project=>project.id), ['p-1']);
  assert.deepEqual(groups.find(group=>group.id==='').projects.map(project=>project.id), ['p-2']);
});

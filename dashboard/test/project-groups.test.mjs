import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../web/dashboard.js', import.meta.url), 'utf8');
const groupProjectsSource = dashboard.match(/function groupProjects\([\s\S]*?\n\}/)?.[0];
assert.ok(groupProjectsSource, 'dashboard.js must define groupProjects');
const groupProjects = vm.runInNewContext(`${groupProjectsSource}; groupProjects`);
const layoutSource = dashboard.match(/function computeOrbitLayout\([\s\S]*?\n\}/)?.[0];
assert.ok(layoutSource, 'dashboard.js must define computeOrbitLayout');
const computeOrbitLayout = vm.runInNewContext(`${layoutSource}; computeOrbitLayout`);

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

test('one project can belong to multiple groups without duplicate membership', () => {
  const shared = {id:'shared',title:'Общий проект',group_ids:['g-1','g-2','g-1'],display_group_id:'legacy'};
  const groups = JSON.parse(JSON.stringify(groupProjects([shared], [
    {id:'g-1',title:'Группа 1'}, {id:'g-2',title:'Группа 2'},
  ])));
  assert.deepEqual(groups.map(group=>group.id), ['g-1','g-2']);
  assert.deepEqual(groups.map(group=>group.projects.map(project=>project.id)), [['shared'],['shared']]);
  assert.equal(new Set(groups.flatMap(group=>group.projects.map(project=>project.id))).size, 1);
});

test('nodes in each visible orbit are evenly spaced and dense owner data has room', () => {
  for (const [groupCount,projectCount,taskCount] of [[6,4,2],[6,5,10],[6,18,15],[6,41,60]]) {
    const layout = computeOrbitLayout(groupCount,projectCount,taskCount);
    const rings = [['groups',154,60],['projects',154,64],['tasks',172,62]];
    for (const [name, cardWidth, cardHeight] of rings) {
      const points = layout[name];
      assert.equal(points.length, {groups:groupCount,projects:projectCount,tasks:taskCount}[name]);
      for (const point of points) {
        assert.ok(point.x-cardWidth/2 >= 0 && point.x+cardWidth/2 <= layout.width);
        assert.ok(point.y-cardHeight/2 >= 0 && point.y+cardHeight/2 <= layout.height);
      }
      for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
        const dx=Math.abs(points[i].x-points[j].x),dy=Math.abs(points[i].y-points[j].y);
        assert.ok(dx >= cardWidth+8 || dy >= cardHeight+8, `${name} ${i}/${j} overlap at ${groupCount}/${projectCount}/${taskCount}`);
      }
      if (points.length > 2) {
        const spacing = points.map((point,index)=>Math.hypot(point.x-points[(index+1)%points.length].x,
          point.y-points[(index+1)%points.length].y));
        assert.ok(Math.max(...spacing)-Math.min(...spacing)<.000001, `${name} has uneven spacing`);
      }
    }
    for (let a=0;a<rings.length;a++) for (let b=a+1;b<rings.length;b++) {
      const [inner,w1,h1]=rings[a], [outer,w2,h2]=rings[b];
      for (const p of layout[inner]) for (const q of layout[outer]) {
        assert.ok(Math.abs(p.x-q.x)>=(w1+w2)/2+6 || Math.abs(p.y-q.y)>=(h1+h2)/2+6,
          `${inner}/${outer} overlap at ${groupCount}/${projectCount}/${taskCount}`);
      }
    }
  }
});

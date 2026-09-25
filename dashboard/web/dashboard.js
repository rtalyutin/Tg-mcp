import { projects as sampleProjects, tasks as sampleTasks, stages as sampleStages,
  projectGroups as sampleProjectGroups,
  inbox as sampleInbox, priorities as samplePriorities, changes as sampleChanges,
  automations as sampleAutomations } from './demo-data.js';

let projects = sampleProjects;
let tasks = sampleTasks;
let stages = sampleStages;
let projectGroups = sampleProjectGroups;
let inbox = sampleInbox;
let priorities = samplePriorities;
let changes = sampleChanges;
let automations = sampleAutomations;
let curatedSnapshot = null;

const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const icon = name => {
  const wrapper = el('span', 'asset icon');
  const img = el('img');
  img.src = `/dashboard/assets/${name}.svg`;
  img.alt = '';
  wrapper.append(img);
  return wrapper;
};
const plural = (n, one, few, many) => n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
const taskCount = n => `${n} ${plural(n, 'задача', 'задачи', 'задач')}`;
const projectCount = n => `${n} ${plural(n, 'проект', 'проекта', 'проектов')}`;
const normal = value => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
function groupProjects(projects, definitions = []) {
  const labels = new Map();
  for (const group of definitions) {
    if (!group || typeof group.id !== 'string' || typeof group.title !== 'string' ||
        !group.id.trim() || !group.title.trim() || labels.has(group.id)) continue;
    labels.set(group.id, group.title.trim());
  }
  const groups = new Map();
  for (const project of projects) {
    const fallback = typeof project.group_code === 'string' && project.group_code.trim()
      ? project.group_code.trim()
      : typeof project.display_group_id === 'string' && project.display_group_id.trim()
        ? project.display_group_id.trim() : '';
    const memberships = project.group_ids ?? project.groupIds;
    const keys = Array.isArray(memberships) && memberships.length
      ? [...new Set(memberships.filter(key => typeof key === 'string' && key.trim()).map(key => key.trim()))]
      : [fallback];
    for (const key of keys.length ? keys : [fallback]) {
      const title = key ? labels.get(key) ?? key : 'Без группы';
      if (!groups.has(key)) groups.set(key, { id: key, title, projects: [] });
      groups.get(key).projects.push(project);
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}
// Nodes are placed at equal angular intervals. The radius grows with the
// visible count so an expanded branch never hides its siblings.
function computeOrbitLayout(groupCount, projectCount, taskCount) {
  const radius = (count, width, minimum) => Math.max(minimum, count * (width + 16) * 1.06 / (2 * Math.PI));
  const points = (count, rx, start) => Array.from({ length: count }, (_, index) => {
    const angle = start + 2 * Math.PI * index / count;
    return { x: rx * Math.cos(angle), y: rx * Math.sin(angle) };
  });
  const overlaps = (inner, outer, innerWidth, innerHeight, outerWidth, outerHeight) =>
    inner.some(a => outer.some(b => Math.abs(a.x - b.x) < (innerWidth + outerWidth) / 2 + 8 &&
      Math.abs(a.y - b.y) < (innerHeight + outerHeight) / 2 + 8));
  const groupRx = radius(groupCount, 154, 150);
  const groupPoints = points(groupCount, groupRx, -Math.PI / 2);
  const projectStart = -Math.PI / 2 - Math.PI / Math.max(1, projectCount);
  let projectRx = Math.max(groupRx + 110, radius(projectCount, 154, 270));
  let projectPoints = points(projectCount, projectRx, projectStart);
  while (overlaps(groupPoints, projectPoints, 154, 60, 154, 64)) {
    projectRx += 8;
    projectPoints = points(projectCount, projectRx, projectStart);
  }
  let taskRx = Math.max(projectRx + 90, radius(taskCount, 172, 365));
  let taskPoints = points(taskCount, taskRx, -Math.PI / 2);
  while (overlaps(projectPoints, taskPoints, 154, 64, 172, 62) ||
         overlaps(groupPoints, taskPoints, 154, 60, 172, 62)) {
    taskRx += 8;
    taskPoints = points(taskCount, taskRx, -Math.PI / 2);
  }
  const rings = {
    groups: { rx: groupRx, ry: groupRx },
    projects: { rx: projectRx, ry: projectRx },
    tasks: { rx: taskRx, ry: taskRx },
  };
  const outer = taskCount ? rings.tasks : projectCount ? rings.projects : rings.groups;
  const width = Math.max(912, Math.ceil(2 * (outer.rx + 100)));
  const height = Math.max(700, Math.ceil(2 * (outer.ry + 72)));
  const cx = width / 2;
  const cy = height / 2;
  const positioned = ringPoints => ringPoints.map(point => ({ x: cx + point.x, y: cy + point.y }));
  return {
    width, height, cx, cy, rings,
    groups: positioned(groupPoints),
    projects: positioned(projectPoints),
    tasks: positioned(taskPoints),
  };
}
let selectedId = '';
const expandedGroups = new Set();
const expandedProjects = new Set();
const searchClosedGroups = new Set();
const searchClosedProjects = new Set();
let query = '';
let showConnections = true;
let lastFocus;
const demoInbox = [...inbox];
const dialog = $('detail-dialog');

function openDialog(title, build) {
  lastFocus = document.activeElement;
  $('dialog-title').textContent = title;
  $('dialog-content').replaceChildren();
  build($('dialog-content'));
  dialog.showModal();
}
function note(content) {
  content.append(el('p', 'dialog-note', curatedSnapshot
    ? 'Проверяемая неполная выборка. Полная история пока не загружена.'
    : 'Демонстрационный пример из макета. Личные данные и синхронизация пока не подключены.'));
}
function row(item, click) {
  const node = el(click ? 'button' : 'div', 'list-row');
  if (click) { node.type = 'button'; node.addEventListener('click', click); }
  const surface = el('span', `row-icon${item.number ? ' number' : ''}`);
  if (item.number) surface.textContent = item.number;
  else if (item.dot) { const dot = el('span', 'asset change-dot'); const img = el('img'); img.src = '/dashboard/assets/change-dot.svg'; img.alt = ''; dot.append(img); surface.append(dot); }
  else surface.append(icon(item.icon));
  const text = el('span', 'row-text');
  text.append(el('span', 'row-title', item.title), el('span', 'row-description', item.description));
  if (item.date) text.append(el('span', 'row-date', item.date));
  node.append(surface, text);
  return node;
}
function renderInbox() {
  $('inbox-count').textContent = String(demoInbox.length);
  $('inbox-list').replaceChildren(...demoInbox.map(item => row(item, () => openDialog(item.title, content => {
    content.append(el('p', '', item.description)); note(content);
    if (!inbox.includes(item)) content.append(el('p', 'dialog-note', 'Добавлено только в эту вкладку. После перезагрузки запись исчезнет.'));
  }))), ...(curatedSnapshot && demoInbox.length === 0 ? [el('p','dialog-note','Нет подтверждённых записей.')] : []));
}
function selectProject(id) {
  selectedId = id;
  expandedProjects.add(id);
  for (const group of groupProjects(projects, projectGroups)) {
    if (group.projects.some(project => project.id === id)) expandedGroups.add(group.id);
  }
  renderBoard();
  [...$('project-orbit').querySelectorAll('[data-project-id]')].find(node => node.dataset.projectId === id)?.focus({ preventScroll: true });
}
function showTask(task) {
  openDialog(task.title, content => {
    const stage = stages.find(item => item.id === task.stage);
    content.append(el('p', '', `Этап: ${stage?.title ?? 'не определён'}`));
    content.append(el('p', '', `Прогресс: ${task.progress === null ? 'нет оценки' : `${task.progress}%`}`));
    content.append(el('p', '', task.projectIds.length > 1 ? 'Общая задача проектов:' : 'Проект:'));
    const list = el('ul');
    task.projectIds.forEach(id => list.append(el('li', '', projects.find(project => project.id === id).title)));
    content.append(list);
    if (curatedSnapshot) {
      if (task.observedStatus) content.append(el('p', '', `Состояние по доступным данным: ${task.observedStatus}`));
      if (task.progressBasis) content.append(el('p', '', `Основание оценки: ${task.progressBasis}`));
      const sources = task.evidence.map(id => curatedSnapshot.sources[id]?.title).filter(Boolean);
      if (sources.length) content.append(el('p', 'dialog-note', `Источники: ${sources.join('; ')}`));
    }
    note(content);
  });
}
function renderBoard() {
  const matchingGroupIds = new Set(projectGroups.filter(group => normal(group.title).includes(query)).map(group => group.id));
  const matchingProjects = projects.filter(project => normal(project.title).includes(query) ||
    (project.group_ids ?? project.groupIds ?? [project.group_code ?? project.display_group_id])
      .some(id => matchingGroupIds.has(id)));
  const matchingIds = new Set(matchingProjects.map(project => project.id));
  const matchingTasks = tasks.filter(task => !query || normal(task.title).includes(query) || task.projectIds.some(id => matchingIds.has(id)));
  const filteredProjects = projects.filter(project => !query || matchingIds.has(project.id) || matchingTasks.some(task => task.projectIds.includes(project.id)));
  const groups = groupProjects(filteredProjects, projectGroups);
  const openGroups = groups.filter(group => query ? !searchClosedGroups.has(group.id) : expandedGroups.has(group.id));
  const openProjectIds = new Set(openGroups.flatMap(group => group.projects.map(project => project.id)));
  const visibleProjects = projects.filter(project => openProjectIds.has(project.id));
  const activeProjects = new Set(visibleProjects.filter(project => query ? !searchClosedProjects.has(project.id) : expandedProjects.has(project.id)).map(project => project.id));
  const visibleTasks = matchingTasks.filter(task => task.projectIds.some(id => activeProjects.has(id)));
  $('board-summary').textContent = `${groups.length} ${plural(groups.length, 'группа', 'группы', 'групп')} · ${projectCount(filteredProjects.length)} · ${taskCount(matchingTasks.length)}`;
  $('search-status').textContent = query ? `Результат поиска: ${projectCount(filteredProjects.length)}, ${taskCount(matchingTasks.length)}.` : '';
  $('empty-search').hidden = groups.length > 0;
  const layout = computeOrbitLayout(groups.length, visibleProjects.length, visibleTasks.length);
  const board = $('project-board');
  const viewport = board.parentElement;
  const previousWidth = Number.parseFloat(board.style.width) || 0;
  const previousHeight = Number.parseFloat(board.style.height) || 0;
  const previousLeft = viewport.scrollLeft;
  const previousTop = viewport.scrollTop;
  board.style.width = `${layout.width}rem`;
  board.style.height = `${layout.height}rem`;
  const place = (node, point) => {
    node.style.left = `${point.x / layout.width * 100}%`;
    node.style.top = `${point.y / layout.height * 100}%`;
    return node;
  };
  const groupPoints = new Map(groups.map((group, index) => [group.id, layout.groups[index]]));
  const projectPoints = new Map(visibleProjects.map((project, index) => [project.id, layout.projects[index]]));
  const taskPoints = new Map(visibleTasks.map((task, index) => [task.id, layout.tasks[index]]));
  $('orbit-center').style.left = `${layout.cx / layout.width * 100}%`;
  $('orbit-center').style.top = `${layout.cy / layout.height * 100}%`;
  $('project-list').replaceChildren(...groups.map(group => {
    const node = el('button', 'orbit-node orbit-group');
    node.type = 'button'; node.dataset.groupId = group.id;
    node.title = group.title;
    node.setAttribute('aria-expanded', String(openGroups.includes(group)));
    node.setAttribute('aria-label', `${group.title}, ${projectCount(group.projects.length)}. ${openGroups.includes(group) ? 'Свернуть' : 'Раскрыть'}`);
    node.append(el('span', 'orbit-icon', '◈'), el('span', 'orbit-name', group.title), el('span', 'orbit-count', String(group.projects.length)));
    node.addEventListener('click', () => {
      const set = query ? searchClosedGroups : expandedGroups;
      if (set.has(group.id)) set.delete(group.id);
      else set.add(group.id);
      renderBoard();
      [...$('project-list').querySelectorAll('[data-group-id]')].find(item => item.dataset.groupId === group.id)?.focus({ preventScroll: true });
    });
    return place(node, groupPoints.get(group.id));
  }));
  $('project-orbit').replaceChildren(...visibleProjects.map(project => {
    const node = el('button', 'orbit-node orbit-project');
    node.type = 'button'; node.dataset.projectId = project.id;
    node.classList.toggle('is-selected', project.id === selectedId);
    node.title = project.title;
    node.setAttribute('aria-expanded', String(activeProjects.has(project.id)));
    node.setAttribute('aria-label', `${project.title}, ${taskCount(tasks.filter(task => task.projectIds.includes(project.id)).length)}. ${activeProjects.has(project.id) ? 'Свернуть задачи' : 'Раскрыть задачи'}`);
    const surface = el('span', 'orbit-icon'); surface.append(icon(project.icon));
    node.append(surface, el('span', 'orbit-name', project.title), el('span', 'orbit-chevron', activeProjects.has(project.id) ? '−' : '+'));
    node.addEventListener('click', () => {
      selectedId = project.id;
      const set = query ? searchClosedProjects : expandedProjects;
      if (set.has(project.id)) set.delete(project.id);
      else set.add(project.id);
      renderBoard();
      [...$('project-orbit').querySelectorAll('[data-project-id]')].find(item => item.dataset.projectId === project.id)?.focus({ preventScroll: true });
    });
    return place(node, projectPoints.get(project.id));
  }));
  $('task-board').replaceChildren(...visibleTasks.map(task => {
    const node = el('button', 'orbit-node orbit-task');
    node.type = 'button'; node.dataset.taskId = task.id;
    node.title = task.title;
    const status = task.progress === null || task.progress === undefined ? 'Без оценки' : `${task.progress}%`;
    node.setAttribute('aria-label', `${task.title}. ${status}. Открыть задачу`);
    const marker = el('span', `task-marker${task.progress === 100 ? ' done' : ''}`, task.progress === 100 ? '✓' : '');
    node.append(marker, el('span', 'orbit-name', task.title), el('span', 'orbit-status', status));
    node.addEventListener('click', () => showTask(task));
    return place(node, taskPoints.get(task.id));
  }));
  drawOrbitConnections(layout, groups, openGroups, visibleProjects, visibleTasks, groupPoints, projectPoints, taskPoints);
  const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
  viewport.scrollLeft = previousWidth
    ? previousLeft + (layout.width - previousWidth) * unit / 2
    : (layout.width * unit - viewport.clientWidth) / 2;
  viewport.scrollTop = previousHeight
    ? previousTop + (layout.height - previousHeight) * unit / 2
    : (layout.height * unit - viewport.clientHeight) / 2;
}
function drawOrbitConnections(layout, groups, openGroups, visibleProjects, visibleTasks, groupPoints, projectPoints, taskPoints) {
  const svg = $('live-connections');
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.hidden = !showConnections;
  const ns = 'http://www.w3.org/2000/svg';
  const shape = (tag, attrs, className) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (className) node.setAttribute('class', className);
    return node;
  };
  const paths = [];
  for (const [name, count] of [['groups', groups.length], ['projects', visibleProjects.length], ['tasks', visibleTasks.length]]) {
    if (count) paths.push(shape('ellipse', { cx: layout.cx, cy: layout.cy, ...layout.rings[name] }, 'orbit-ring'));
  }
  const link = (from, to, kind) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    paths.push(shape('path', { d: `M ${from.x} ${from.y} C ${from.x + dx * .45} ${from.y + dy * .12}, ${to.x - dx * .45} ${to.y - dy * .12}, ${to.x} ${to.y}` }, `orbit-link ${kind}`));
  };
  for (const group of groups) link({ x: layout.cx, y: layout.cy }, groupPoints.get(group.id), 'root-link');
  for (const group of openGroups) for (const project of group.projects) {
    const target = projectPoints.get(project.id);
    if (target) link(groupPoints.get(group.id), target, 'project-link');
  }
  for (const task of visibleTasks) for (const id of task.projectIds) {
    const start = projectPoints.get(id);
    if (start) link(start, taskPoints.get(task.id), 'task-link');
  }
  svg.replaceChildren(...paths);
}
function renderSidePanels() {
  renderInbox();
  $('priorities-list').replaceChildren(...priorities.map(item => row(item, () => {
    $('search').value = ''; query = ''; selectProject(item.projectId); $('projects-panel').scrollIntoView({ block: 'nearest' });
  })), ...(curatedSnapshot && priorities.length === 0 ? [el('p','dialog-note','Подтверждённого порядка приоритетов нет.')] : []));
  $('changes-list').replaceChildren(...changes.map(item => row(item)),
    ...(curatedSnapshot && changes.length === 0 ? [el('p','dialog-note','Нет проверенного журнала изменений.')] : []));
  $('automations-list').replaceChildren(...automations.map(item => row(item, () => openDialog(item.title, content => {
    content.append(el('p', '', `${curatedSnapshot ? 'Расписание' : 'Расписание в макете'}: ${item.description}`));
    content.append(el('p', 'dialog-note', curatedSnapshot
      ? 'Задача включена на момент последней проверки; результат следующего запуска неизвестен.'
      : 'Это пример автоматизации. Её настоящее расписание и результаты запусков здесь пока не отображаются.'));
  }))));
}
renderSidePanels();
renderBoard();

function scheduleDescription(item) {
  const rule = item.schedule.match(/^RRULE:(.*)$/m)?.[1] ??
    (item.schedule.startsWith('FREQ=') ? item.schedule : '');
  const frequency = rule.match(/(?:^|;)FREQ=([A-Z]+)/)?.[1];
  const interval = Number(rule.match(/(?:^|;)INTERVAL=(\d+)/)?.[1] ?? 1);
  const label = frequency === 'DAILY' ? 'Ежедневно' :
    frequency === 'WEEKLY' ? 'Еженедельно' :
    frequency === 'HOURLY' ? `Каждые ${interval} ч` :
    frequency === 'MONTHLY' ? 'Ежемесячно' : 'Однократно';
  return `${label} · ${item.timezone}`;
}

function adoptCuratedSnapshot(snapshot) {
  if (snapshot?.schema !== 'dashboard-curated-snapshot/1' || snapshot.coverage !== 'partial' ||
      !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.tasks) || !snapshot.sources) return;
  const excluded = new Set(snapshot.excluded_project_titles?.map(normal) ?? []);
  const visible = snapshot.projects.filter(project => !excluded.has(normal(project.title)));
  const projectIds = new Set(visible.map(project => project.id));
  const validTasks = snapshot.tasks.filter(task => Array.isArray(task.project_ids) &&
    task.project_ids.length > 0 && task.project_ids.every(id => projectIds.has(id)));
  curatedSnapshot = snapshot;
  projects = visible.map(project => ({ ...project, icon: 'folder' }));
  projectGroups = snapshot.project_groups ?? [];
  tasks = validTasks.map(task => ({ id: task.id, title: task.title, stage: 'unknown',
    progress: task.progress_percent, projectIds: task.project_ids,
    progressBasis: task.progress_basis, observedStatus: task.observed_status,
    evidence: task.evidence ?? [] }));
  stages = [{ id: 'unknown', title: 'Этап не определён' }];
  inbox = []; priorities = []; changes = [];
  demoInbox.length = 0;
  automations = snapshot.automations.map(item => ({ title: item.title, icon: 'settings',
    description: scheduleDescription(item) }));
  selectedId = projects[0]?.id ?? '';
  expandedGroups.clear(); expandedProjects.clear();
  searchClosedGroups.clear(); searchClosedProjects.clear();
  document.documentElement.dataset.dataMode = 'curated';
  document.querySelector('.demo-label').textContent = 'Неполная выборка · 24.09.2026';
  document.querySelector('.board-footnote').textContent = snapshot.coverage_note;
  document.querySelector('.priorities-paper .example').textContent = 'Нет оценки';
  document.querySelector('.automation-paper .example').textContent = 'Проверено';
  document.querySelector('.run-errors p:last-child').textContent = 'Не проверялись';
  $('add-inbox').disabled = true;
  $('add-inbox').title = 'Запись в базу из этого экрана пока недоступна';
  renderSidePanels(); renderBoard();
}

fetch('/dashboard/api/snapshot', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => {
    if (response.ok) adoptCuratedSnapshot(await response.json());
    else if (response.status === 401) document.querySelector('.demo-label').textContent = 'Демо · личные данные после входа владельца';
    else document.querySelector('.demo-label').textContent = 'Демо · личный снимок пока недоступен';
  })
  .catch(() => { document.querySelector('.demo-label').textContent = 'Демо · личный снимок пока недоступен'; });
$('search').addEventListener('input', event => { query = normal(event.target.value); searchClosedGroups.clear(); searchClosedProjects.clear(); renderBoard(); });
$('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
} });
dialog.addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); });
$('settings').addEventListener('click', () => openDialog('Настройки отображения', content => {
  const label = el('label', 'dialog-label');
  const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = showConnections;
  checkbox.addEventListener('change', () => { showConnections = checkbox.checked; $('live-connections').hidden = !showConnections; });
  label.append(checkbox, document.createTextNode('Показывать связи между окружностями'));
  content.append(label, el('p', 'dialog-note', 'Настройка действует в этой вкладке.'));
}));
$('profile').addEventListener('click', () => openDialog('Следующий ход', content => {
  content.append(el('p', '', 'Проекты, задачи и их связи — на одном рабочем столе.'));
  note(content);
  const link = el('a', '', 'Открыть реестр компаний'); link.href = '/'; content.append(link);
}));
$('add-inbox').addEventListener('click', () => openDialog('Добавить во входящие', content => {
  const form = el('form');
  const label = el('label', '', 'Название идеи'); label.htmlFor = 'inbox-title-input';
  const input = el('input', 'dialog-input'); input.id = 'inbox-title-input'; input.required = true; input.maxLength = 100; input.autocomplete = 'off';
  const description = el('p', 'dialog-note', 'Пробная запись останется только в этой вкладке до перезагрузки. В базу данных она не отправляется.');
  const submit = el('button', 'primary-button', 'Добавить пример'); submit.type = 'submit';
  form.append(label, input, description, submit);
  form.addEventListener('submit', event => {
    event.preventDefault(); const title = input.value.trim(); if (!title) { input.focus(); return; }
    demoInbox.unshift({ title, description: 'Идея · в этой вкладке', icon: 'doc' }); renderInbox(); dialog.close();
  });
  content.append(form);
}));
for (const button of document.querySelectorAll('[data-nav]')) button.addEventListener('click', () => {
  if (button.dataset.nav === 'archive') {
    openDialog('Архив', content => {
      content.append(el('p', '', 'В демонстрационном макете архивных задач нет.'));
      note(content);
    }); return;
  }
  for (const item of document.querySelectorAll('[data-nav]')) {
    const active = item === button; item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  if (button.dataset.nav === 'overview') {
    $('search').value = ''; query = ''; expandedGroups.clear(); expandedProjects.clear();
    searchClosedGroups.clear(); searchClosedProjects.clear(); selectedId = ''; renderBoard(); window.scrollTo({ top: 0 });
  } else {
    const target = $(button.dataset.nav === 'projects' ? 'projects-panel' : 'automations-panel');
    target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true });
  }
});
document.documentElement.style.setProperty('--asset-scale', String(parseFloat(getComputedStyle(document.documentElement).fontSize) / 2));
window.addEventListener('resize', () => document.documentElement.style.setProperty('--asset-scale', String(parseFloat(getComputedStyle(document.documentElement).fontSize) / 2)));
document.fonts.ready.then(scheduleLines);

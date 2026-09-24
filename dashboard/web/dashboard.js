import { projects, tasks, stages, inbox, priorities, changes, automations } from './demo-data.js';

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
let selectedId = projects[0].id;
let query = '';
let showConnections = true;
let layoutFrame;
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
  content.append(el('p', 'dialog-note', 'Демонстрационный пример из макета. Личные данные и синхронизация пока не подключены.'));
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
  }))));
}
function selectProject(id) {
  selectedId = id;
  renderBoard();
  [...$('project-list').children].find(node => node.dataset.projectId === id)?.focus({ preventScroll: true });
}
function showTask(task) {
  openDialog(task.title, content => {
    const stage = stages.find(item => item.id === task.stage);
    content.append(el('p', '', `Этап: ${stage.title}`));
    content.append(el('p', '', `Прогресс: ${task.progress === null ? 'нет оценки' : `${task.progress}%`}`));
    content.append(el('p', '', task.projectIds.length > 1 ? 'Общая задача проектов:' : 'Проект:'));
    const list = el('ul');
    task.projectIds.forEach(id => list.append(el('li', '', projects.find(project => project.id === id).title)));
    content.append(list);
    note(content);
  });
}
function renderBoard() {
  const matchingProjects = projects.filter(project => normal(project.title).includes(query));
  const matchingIds = new Set(matchingProjects.map(project => project.id));
  const visibleTasks = tasks.filter(task => !query || normal(task.title).includes(query) || task.projectIds.some(id => matchingIds.has(id)));
  const visibleProjects = projects.filter(project => !query || matchingIds.has(project.id) || visibleTasks.some(task => task.projectIds.includes(project.id)));
  const selected = projects.find(project => project.id === selectedId);
  const banner = $('selected-project');
  banner.replaceChildren(document.createTextNode('Выбран проект: '), el('strong', '', selected.title));
  $('board-summary').textContent = `${projectCount(visibleProjects.length)} · ${taskCount(visibleTasks.length)}`;
  $('search-status').textContent = query ? `Результат поиска: ${projectCount(visibleProjects.length)}, ${taskCount(visibleTasks.length)}.` : '';
  $('empty-search').hidden = visibleTasks.length > 0 || visibleProjects.length > 0;
  $('project-list').replaceChildren(...visibleProjects.map(project => {
    const node = el('button', 'project-folder');
    node.type = 'button';
    node.dataset.projectId = project.id;
    node.setAttribute('aria-pressed', String(project.id === selectedId));
    const surface = el('span', 'row-icon'); surface.append(icon(project.icon));
    const text = el('span', 'project-text');
    const members = tasks.filter(task => task.projectIds.includes(project.id));
    const shared = members.filter(task => task.projectIds.length > 1).length;
    text.append(el('span', 'project-name', project.title), el('span', 'project-meta', `${taskCount(members.length)}${shared ? ` · общих: ${shared}` : ''}`));
    node.append(surface, text);
    node.addEventListener('click', () => selectProject(project.id));
    return node;
  }));
  $('task-board').replaceChildren(...stages.map(stage => {
    const column = el('section', 'task-stage');
    column.setAttribute('aria-label', stage.title);
    const members = visibleTasks.filter(task => task.stage === stage.id);
    const title = el('h2', 'stage-title', stage.title);
    title.append(el('span', '', String(members.length)));
    column.append(title);
    for (const task of members) {
      const node = el('button', 'sticky');
      node.type = 'button'; node.dataset.taskId = task.id;
      node.setAttribute('aria-label', `${task.title}. ${task.progress === null ? 'Нет оценки прогресса' : `Прогресс ${task.progress}%`}. ${task.projectIds.length > 1 ? 'Общая задача. ' : ''}Открыть карточку`);
      if (task.progress !== null) {
        const fill = el('span', 'progress-fill');
        fill.style.width = `${task.progress}%`;
        node.append(fill);
      }
      const fold = el('span', 'asset sticky-fold');
      const foldImage = el('img'); foldImage.src = '/dashboard/assets/fold.svg'; foldImage.alt = ''; fold.append(foldImage);
      node.append(el('span', 'task-title', task.title), el('span', 'task-progress', task.progress === null ? '—' : `${task.progress}%`), fold);
      node.addEventListener('click', () => showTask(task));
      column.append(node);
    }
    return column;
  }));
  scheduleLines();
}
function scheduleLines() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(drawLines);
}
function drawLines() {
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
  document.documentElement.style.setProperty('--asset-scale', String(size / 2));
  const original = $('design-connections');
  const live = $('live-connections');
  live.replaceChildren();
  const useOriginal = selectedId === 'tournament' && !query && innerWidth >= 1500;
  original.hidden = !showConnections || !useOriginal;
  live.hidden = !showConnections || useOriginal;
  if (!showConnections || useOriginal) return;
  const board = $('project-board');
  const selected = [...$('project-list').children].find(node => node.dataset.projectId === selectedId);
  if (!selected) return;
  const bounds = board.getBoundingClientRect();
  const start = selected.getBoundingClientRect();
  live.setAttribute('width', String(bounds.width));
  live.setAttribute('height', String(bounds.height));
  live.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  const sx = start.right - bounds.left;
  const sy = start.top + start.height / 2 - bounds.top;
  const ns = 'http://www.w3.org/2000/svg';
  const circle = (x, y) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); c.setAttribute('r', String(4 * size)); return c;
  };
  for (const task of tasks.filter(task => task.projectIds.includes(selectedId))) {
    const target = [...board.querySelectorAll('[data-task-id]')].find(node => node.dataset.taskId === task.id);
    if (!target) continue;
    const box = target.getBoundingClientRect();
    const tx = box.left - bounds.left + 16 * size;
    const ty = box.top - bounds.top;
    const path = document.createElementNS(ns, 'path');
    // The relation is data, so it follows the selected project and current layout.
    path.setAttribute('d', `M ${sx} ${sy} C ${sx + 55 * size} ${sy}, ${tx} ${sy}, ${tx} ${ty}`);
    live.append(path, circle(tx, ty));
  }
  if (live.childElementCount) live.append(circle(sx, sy));
}
renderInbox();
$('priorities-list').replaceChildren(...priorities.map(item => row(item, () => {
  $('search').value = ''; query = ''; selectProject(item.projectId); $('projects-panel').scrollIntoView({ block: 'nearest' });
})));
$('changes-list').replaceChildren(...changes.map(item => row(item)));
$('automations-list').replaceChildren(...automations.map(item => row(item, () => openDialog(item.title, content => {
  content.append(el('p', '', `Расписание в макете: ${item.description}`));
  content.append(el('p', '', 'Это пример автоматизации. Её настоящее расписание и результаты запусков здесь пока не отображаются.'));
}))));
renderBoard();
$('search').addEventListener('input', event => { query = normal(event.target.value); renderBoard(); });
$('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
} });
dialog.addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); });
$('settings').addEventListener('click', () => openDialog('Настройки отображения', content => {
  const label = el('label', 'dialog-label');
  const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = showConnections;
  checkbox.addEventListener('change', () => { showConnections = checkbox.checked; scheduleLines(); });
  label.append(checkbox, document.createTextNode('Показывать связи выбранного проекта'));
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
    $('search').value = ''; query = ''; selectedId = projects[0].id; renderBoard(); window.scrollTo({ top: 0 });
  } else {
    const target = $(button.dataset.nav === 'projects' ? 'projects-panel' : 'automations-panel');
    target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true });
  }
});
new ResizeObserver(scheduleLines).observe($('project-board'));
window.addEventListener('resize', scheduleLines);
document.fonts.ready.then(scheduleLines);

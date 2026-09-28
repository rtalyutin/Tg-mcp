import { projects as sampleProjects, tasks as sampleTasks, stages as sampleStages,
  projectGroups as sampleProjectGroups,
  inbox as sampleInbox, priorities as samplePriorities, changes as sampleChanges,
  automations as sampleAutomations } from './demo-data.js';
import {visibleGraph} from './visibility-model.js';

let projects = sampleProjects;
let tasks = sampleTasks;
let stages = sampleStages;
let projectGroups = sampleProjectGroups;
let inbox = sampleInbox;
let priorities = samplePriorities;
let changes = sampleChanges;
let automations = sampleAutomations;
let curatedSnapshot = null;
let liveSnapshot = null;
let comparison = null;
let viewMode = 'orbits';
let planToken = '';
let visibilityToken = '';
const projectVisibility = new Map();
const isProjectHidden = id => projectVisibility.get(id)?.hidden === true;
const hiddenProjectIds = () => new Set([...projectVisibility.values()].filter(row=>row.hidden).map(row=>row.project_id));
const taskPlans = new Map();
const ganttClosedGroups = new Set();
const ganttClosedProjects = new Set();
const DAY = 86400000;
const GANTT_DAYS = 28;
const GANTT_DAY_WIDTH = 38;
const utcDay = date => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const todayDay = () => utcDay(new Date());
let ganttStart = todayDay() - 7 * DAY;
const dateValue = day => new Date(day).toISOString().slice(0,10);
const dayValue = value => Date.parse(`${value}T00:00:00Z`);

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
function progressRange(items) {
  if (!items.length) return null;
  let known = 0, unknown = 0;
  for (const item of items) {
    if (typeof item.progress === 'number' && Number.isFinite(item.progress) &&
        item.progress >= 0 && item.progress <= 100) known += item.progress;
    else unknown++;
  }
  return {low:known/items.length,high:(known+unknown*100)/items.length,known:items.length-unknown,total:items.length};
}
const progressLabel = range => !range ? 'Нет задач' : range.low === range.high
  ? `${Math.round(range.low)}%` : `${Math.round(range.low)}–${Math.round(range.high)}%`;
const progressDelta = (before, after) => {
  if (!before || !after) return '';
  const low = Math.round(after.low - before.high), high = Math.round(after.high - before.low);
  const signed = value => `${value > 0 ? '+' : ''}${value}`;
  return `Δ ${signed(low)}${low === high ? '' : `…${signed(high)}`} п.п.`;
};
const projectProgress = (id, source = tasks) => progressRange(source.filter(task => task.projectIds.includes(id)));
const groupProgress = (group, source = tasks) => {
  const ids = new Set(group.projects.map(project => project.id));
  return progressRange(source.filter(task => task.projectIds.some(id => ids.has(id))));
};
const mappedTasks = snapshot => {
  return visibleGraph(snapshot,hiddenProjectIds()).tasks.map(task => ({
    id:task.id, title:task.title, projectIds:task.project_ids,
    progress:task.progress_percent ?? null,
  }));
};
function previousTaskProgress(id) {
  if (!comparison) return null;
  const task = mappedTasks(comparison.a.endpoint.payload).find(item => item.id === id);
  return task ? progressRange([task]) : null;
}
function previousProjectProgress(id) {
  return comparison ? projectProgress(id,mappedTasks(comparison.a.endpoint.payload)) : null;
}
function previousGroupProgress(group) {
  if (!comparison) return null;
  const snapshot = comparison.a.endpoint.payload;
  const visibleIds=new Set(visibleGraph(snapshot,hiddenProjectIds()).projects.map(project=>project.id));
  const oldProjects = withMemberships(snapshot,comparison.a.endpoint.group_memberships)
    .filter(project => visibleIds.has(project.id));
  const oldGroup = groupProjects(oldProjects,snapshot.project_groups ?? []).find(item => item.id === group.id);
  return oldGroup ? groupProgress(oldGroup,mappedTasks(snapshot)) : null;
}
function withMemberships(snapshot, memberships) {
  const table = new Map();
  if (Array.isArray(memberships)) for (const row of memberships) {
    if (row?.project_id && row?.group_code) {
      if (!table.has(row.project_id)) table.set(row.project_id,[]);
      table.get(row.project_id).push(row.group_code);
    }
  }
  else if (memberships && typeof memberships === 'object') for (const [id,codes] of Object.entries(memberships))
    if (Array.isArray(codes)) table.set(id,codes);
  return snapshot.projects.map(project => ({...project,...(table.has(project.id) ? {group_codes:table.get(project.id)} : {})}));
}
function changedEntities() {
  if (!comparison) return {projects:new Set(),tasks:new Set(),groups:new Set()};
  const old = comparison.a.endpoint.payload, current = comparison.b.endpoint.payload;
  const changed = (before, after) => {
    const previous = new Map(before.map(item => [item.id,JSON.stringify(item)]));
    const current = new Map(after.map(item => [item.id,JSON.stringify(item)]));
    return new Set([...new Set([...previous.keys(),...current.keys()])]
      .filter(id => previous.get(id) !== current.get(id)));
  };
  const oldIds=new Set(visibleGraph(old,hiddenProjectIds()).projects.map(project=>project.id));
  const currentIds=new Set(visibleGraph(current,hiddenProjectIds()).projects.map(project=>project.id));
  const oldProjects=withMemberships(old,comparison.a.endpoint.group_memberships).filter(project=>oldIds.has(project.id));
  const currentProjects=withMemberships(current,comparison.b.endpoint.group_memberships).filter(project=>currentIds.has(project.id));
  const projectIds = changed(oldProjects,currentProjects);
  const oldTasks=mappedTasks(old), currentTasks=mappedTasks(current);
  const taskIds = changed(oldTasks,currentTasks);
  for (const task of [...oldTasks,...currentTasks]) if (taskIds.has(task.id))
    for (const id of task.project_ids ?? task.projectIds ?? []) projectIds.add(id);
  const groups = changed(old.project_groups ?? [],current.project_groups ?? []);
  const oldGroups = groupProjects(oldProjects,old.project_groups ?? []);
  for (const group of [...oldGroups,...groupProjects(projects,projectGroups)])
    if (group.projects.some(project => projectIds.has(project.id))) groups.add(group.id);
  return {projects:projectIds,tasks:taskIds,groups};
}
function groupProjects(projects, definitions = []) {
  const labels = new Map();
  for (const group of definitions) {
    if (!group || typeof group.id !== 'string' || typeof group.title !== 'string' ||
        !group.id.trim() || !group.title.trim() || labels.has(group.id)) continue;
    labels.set(group.id, group.title.trim());
  }
  const groups = new Map();
  for (const project of projects) {
    const persistedCodes = Array.isArray(project.group_codes)
      ? [...new Set(project.group_codes.filter(code => typeof code === 'string').map(code => code.trim()).filter(Boolean))]
      : [];
    const fallback = typeof project.group_code === 'string' && project.group_code.trim()
      ? project.group_code.trim()
      : typeof project.display_group_id === 'string' && project.display_group_id.trim()
        ? project.display_group_id.trim() : '';
    const memberships = persistedCodes.length ? persistedCodes : project.group_ids ?? project.groupIds;
    const keys = Array.isArray(memberships) && memberships.length
      ? [...new Set(memberships.filter(key => typeof key === 'string' && key.trim()).map(key => key.trim()))]
      : [fallback];
    for (const key of keys.length ? keys : [fallback]) {
      const title = key ? (persistedCodes.length ? key : labels.get(key) ?? key) : 'Без группы';
      if (!groups.has(key)) groups.set(key, { id: key, title, projects: [] });
      groups.get(key).projects.push(project);
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}
function renderGantt() {
  if (viewMode !== 'plan') return;
  const base = comparison && liveSnapshot ? liveSnapshot : null;
  const baseGraph=base && visibleGraph(base,hiddenProjectIds());
  const baseIds=new Set(baseGraph?.projects.map(project=>project.id) ?? []);
  const visibleProjects = baseGraph ? withMemberships(base).filter(project =>
    baseIds.has(project.id)) : projects;
  const visibleTasks = baseGraph ? mappedTasks(base) : tasks;
  const groups = groupProjects(visibleProjects,base?.project_groups ?? projectGroups);
  const progressById = new Map(tasks.map(task => [task.id,task]));
  const changed = changedEntities();
  const fade = comparison && $('only-changes').checked;
  const start = ganttStart, end = start + GANTT_DAYS * DAY;
  const table = $('gantt-table');
  const rangeFor = items => {
    const dates = items.map(task => taskPlans.get(task.id)).filter(plan => plan?.start_date && plan?.end_date);
    return dates.length ? {start:dates.reduce((min,p) => p.start_date < min ? p.start_date : min,dates[0].start_date),
      end:dates.reduce((max,p) => p.end_date > max ? p.end_date : max,dates[0].end_date)} : null;
  };
  const dateLabel = range => range ? `${range.start.slice(8,10)}.${range.start.slice(5,7)} — ${range.end.slice(8,10)}.${range.end.slice(5,7)}` : 'Без дат';
  const header = el('div','gantt-row gantt-header');
  const title = el('div','gantt-sticky'); title.append(el('strong','', 'Группа / проект / задача'),el('small','', 'Плановые даты · прогресс'));
  const calendar = el('div','gantt-calendar gantt-days');
  for (let day = start; day < end; day += DAY) {
    const cell=el('span',`gantt-day${day === todayDay() ? ' today' : ''}${[0,6].includes(new Date(day).getUTCDay()) ? ' weekend' : ''}`);
    cell.append(el('small','',new Intl.DateTimeFormat('ru',{month:'short',timeZone:'UTC'}).format(day)),
      document.createTextNode(String(new Date(day).getUTCDate())));
    calendar.append(cell);
  }
  header.append(title,calendar);
  const rows=[header];
  const addRow = (kind,item,children,range,progress,previous,closed,change) => {
    const row=el('div',`gantt-row gantt-${kind}${fade && !change ? ' is-unchanged' : ''}`);
    const left=el('div','gantt-sticky');
    const name=el('div','gantt-name');
    if (kind !== 'task') {
      const toggle=el('button','gantt-toggle',closed ? '+' : '−'); toggle.type='button';
      toggle.setAttribute('aria-label',`${closed ? 'Раскрыть' : 'Свернуть'} ${item.title}`);
      toggle.setAttribute('aria-expanded',String(!closed));
      toggle.addEventListener('click',()=>{
        const set=kind === 'group' ? ganttClosedGroups : ganttClosedProjects;
        if (set.has(item.id)) set.delete(item.id); else set.add(item.id);
        renderGantt();
      }); name.append(toggle);
    } else name.append(el('span','gantt-task-marker','·'));
    const label=el(kind === 'task' ? 'button' : 'span','gantt-title',item.title);
    if (kind === 'task') {label.type='button'; label.addEventListener('click',()=>showTask(progressById.get(item.id) ?? {...item,stage:'unknown',evidence:[]}));}
    name.append(label);
    if (kind !== 'task') name.append(el('span','gantt-count',kind === 'group' ? projectCount(children.length) : taskCount(children.length)));
    if (kind === 'project' && visibilityToken) {
      const hide=el('button','gantt-hide','Скрыть');hide.type='button';
      hide.setAttribute('aria-label',`Скрыть проект ${item.title} во всём дашборде`);
      hide.addEventListener('click',async()=>{
        hide.disabled=true;
        if (!(await saveProjectVisibility(item.id,true)) && hide.isConnected) hide.disabled=false;
      });
      name.append(hide);
    }
    left.append(name);
    const meta=el('div','gantt-meta');
    meta.append(el('span','gantt-range-label',dateLabel(range)),el('span','gantt-progress-label',progressLabel(progress)));
    if (comparison) meta.append(el('span','gantt-delta',progressDelta(previous,progress) || 'Новая'));
    left.append(meta);
    if (kind === 'task') {
      const edit=el('div','gantt-edit');
      const current=taskPlans.get(item.id);
      const startInput=el('input'); startInput.type='date';startInput.value=current?.start_date ?? '';
      startInput.setAttribute('aria-label',`Начало: ${item.title}`);
      const endInput=el('input');endInput.type='date';endInput.value=current?.end_date ?? '';
      endInput.setAttribute('aria-label',`Конец: ${item.title}`);
      for (const input of [startInput,endInput]) {input.disabled=!planToken;input.addEventListener('change',async()=>{
        if (!startInput.value || !endInput.value) { $('gantt-status').textContent='Укажите обе даты задачи или нажмите «Очистить».';return; }
        await saveTaskPlan(item.id,startInput.value,endInput.value);
      });}
      edit.append(startInput,el('span','','—'),endInput);
      if (current?.start_date) {
        const clear=el('button','gantt-clear','Очистить');clear.type='button';clear.disabled=!planToken;
        clear.setAttribute('aria-label',`Очистить даты: ${item.title}`);
        clear.addEventListener('click',()=>saveTaskPlan(item.id,null,null));edit.append(clear);
      }
      left.append(edit);
    }
    const track=el('div','gantt-calendar gantt-track');
    if (todayDay() >= start && todayDay() < end) {
      const mark=el('span','gantt-today-line');mark.style.left=`${(todayDay()-start)/DAY * GANTT_DAY_WIDTH}px`;track.append(mark);
    }
    if (range) {
      const first=dayValue(range.start),last=dayValue(range.end)+DAY;
      const clipStart=Math.max(first,start),clipEnd=Math.min(last,end);
      if (clipEnd > clipStart) {
        const bar=el('div',`gantt-bar ${kind}`);
        bar.style.left=`${(clipStart-start)/DAY*GANTT_DAY_WIDTH+3}px`;
        bar.style.width=`${Math.max(3,(clipEnd-clipStart)/DAY*GANTT_DAY_WIDTH-6)}px`;
        bar.title=`${item.title}: ${range.start} — ${range.end}, прогресс ${progressLabel(progress)}${comparison ? `, ${progressDelta(previous,progress)}` : ''}`;
        if (progress) {
          const certain=el('span','gantt-bar-fill');certain.style.width=`${progress.low}%`;bar.append(certain);
          if (progress.high > progress.low) {
            const uncertain=el('span','gantt-bar-uncertain');uncertain.style.left=`${progress.low}%`;
            uncertain.style.width=`${progress.high-progress.low}%`;bar.append(uncertain);
          }
        }
        track.append(bar);
      }
    }
    row.append(left,track);rows.push(row);
  };
  for (const group of groups) {
    const groupTasks=[...new Map(group.projects.flatMap(project => visibleTasks.filter(task => task.projectIds.includes(project.id))).map(task => [task.id,task])).values()];
    const matching=group.projects.filter(project => !query || normal(group.title).includes(query) || normal(project.title).includes(query) ||
      visibleTasks.some(task => task.projectIds.includes(project.id) && normal(task.title).includes(query)));
    if (!matching.length) continue;
    addRow('group',group,group.projects,rangeFor(groupTasks),progressRange(groupTasks.map(task => progressById.get(task.id) ?? {progress:null})),previousGroupProgress(group),
      ganttClosedGroups.has(group.id) && !query,changed.groups.has(group.id));
    if (ganttClosedGroups.has(group.id) && !query) continue;
    for (const project of matching) {
      const children=visibleTasks.filter(task => task.projectIds.includes(project.id));
      addRow('project',project,children,rangeFor(children),progressRange(children.map(task => progressById.get(task.id) ?? {progress:null})),previousProjectProgress(project.id),
        ganttClosedProjects.has(project.id) && !query,changed.projects.has(project.id));
      if (ganttClosedProjects.has(project.id) && !query) continue;
      for (const task of children.filter(task => !query || normal(group.title).includes(query) || normal(project.title).includes(query) || normal(task.title).includes(query))) {
        const current=progressById.get(task.id) ?? {progress:null};
        const plan=taskPlans.get(task.id);
        addRow('task',task,[],plan?.start_date ? {start:plan.start_date,end:plan.end_date} : null,
          progressRange([current]),previousTaskProgress(task.id),false,changed.tasks.has(task.id));
      }
    }
  }
  if (rows.length === 1) rows.push(el('div','gantt-empty','Нет видимых проектов. Верните их через «Скрытые проекты».'));
  table.replaceChildren(...rows);
  const planned=visibleTasks.filter(task => taskPlans.get(task.id)?.start_date).length;
  $('gantt-status').textContent = `${dateValue(start)} — ${dateValue(end-DAY)} · ${planned} ${plural(planned,'задача с датами','задачи с датами','задач с датами')}${comparison ? ' · план на сегодня, прогресс отрезка Б' : ''}${!planToken ? ' · редактирование после входа владельца' : ''}`;
}
async function saveTaskPlan(id,start_date,end_date) {
  if (start_date && end_date && start_date > end_date) { $('gantt-status').textContent='Конец задачи раньше начала.';return; }
  $('gantt-status').textContent='Сохранение дат…';
  try {
    const response=await fetch('/dashboard/api/plan/task',{method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json','X-CSRF-Token':planToken},
      body:JSON.stringify({task_id:id,start_date,end_date,version:taskPlans.get(id)?.version ?? 0})});
    if (!response.ok) {
      if (response.status === 409) {await loadPlan();throw new Error('План изменился в другой вкладке. Даты обновлены; повторите правку.');}
      throw new Error('Не удалось сохранить даты. Повторите попытку.');
    }
    const saved=await response.json();taskPlans.set(id,saved);renderGantt();
  } catch(error) {renderGantt(); $('gantt-status').textContent=error.message; }
}
async function loadPlan() {
  const response=await fetch('/dashboard/api/plan',{credentials:'same-origin',cache:'no-store'});
  if (!response.ok) throw new Error('План недоступен');
  const result=await response.json();
  planToken=result.csrf_token;
  taskPlans.clear();
  for (const row of result.tasks) taskPlans.set(row.task_id,row);
  const currentIds=new Set(liveSnapshot ? mappedTasks(liveSnapshot).map(task => task.id) : tasks.map(task => task.id));
  const planned=[...taskPlans.values()].filter(row => currentIds.has(row.task_id) && row.start_date).map(row => dayValue(row.start_date));
  if (planned.length && planned.every(day => day < ganttStart || day >= ganttStart+GANTT_DAYS*DAY))
    ganttStart=Math.min(...planned)-7*DAY;
  renderGantt();
}
async function loadVisibility() {
  const response=await fetch('/dashboard/api/visibility',{credentials:'same-origin',cache:'no-store'});
  if (!response.ok) throw new Error('Настройка видимости недоступна');
  const result=await response.json();
  if (!Array.isArray(result.projects) || typeof result.csrf_token!=='string' ||
      typeof result.editable!=='boolean' || result.projects.some(row=>
        !row || typeof row.project_id!=='string' || !row.project_id ||
        typeof row.hidden!=='boolean' || !Number.isSafeInteger(row.version) || row.version<1) ||
      new Set(result.projects.map(row=>row.project_id)).size!==result.projects.length)
    throw new Error('Некорректное состояние видимости');
  projectVisibility.clear();
  for (const row of result.projects) projectVisibility.set(row.project_id,row);
  visibilityToken=result.editable ? result.csrf_token : '';
}
function refreshVisibilityUi() {
  if (!liveSnapshot) return;
  const source=comparison?.b.endpoint?.payload ?? liveSnapshot;
  adoptCuratedSnapshot(source,comparison?.b.endpoint?.group_memberships,{preserve:true});
  renderTimeline();
}
async function saveProjectVisibility(id,hidden) {
  if (!visibilityToken) return false;
  const title=liveSnapshot?.projects.find(project=>project.id===id)?.title ?? id;
  $('gantt-status').textContent=hidden ? 'Скрытие проекта…' : 'Возврат проекта…';
  try {
    const response=await fetch('/dashboard/api/visibility/project',{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json','X-CSRF-Token':visibilityToken},
      body:JSON.stringify({project_id:id,hidden,version:projectVisibility.get(id)?.version ?? 0})
    });
    if (!response.ok) {
      if (response.status===409) {
        await loadVisibility();refreshVisibilityUi();
        throw new Error('Видимость изменилась в другой вкладке. Список обновлён; повторите действие.');
      }
      throw new Error('Не удалось сохранить видимость проекта. Повторите попытку.');
    }
    projectVisibility.set(id,await response.json());
    refreshVisibilityUi();
    $('gantt-status').textContent=`Проект «${title}» ${hidden ? 'скрыт' : 'показан'} во всём дашборде.`;
    if (hidden) $('gantt-hidden').focus();
    return true;
  } catch(error) {
    $('gantt-status').textContent=error.message;
    if (dialog.open && $('dialog-title').textContent==='Скрытые проекты') renderHiddenProjects($('dialog-content'));
    const message=$('hidden-project-message');if (message) message.textContent=error.message;
    return false;
  }
}
function renderHiddenProjects(content) {
  content.replaceChildren();
  const hidden=liveSnapshot?.projects.filter(project=>isProjectHidden(project.id)) ?? [];
  if (!hidden.length) content.append(el('p','dialog-note','Скрытых проектов нет.'));
  else {
    const list=el('ul','hidden-project-list');
    for (const project of hidden) {
      const item=el('li');
      const restore=el('button','','Показать');restore.type='button';
      restore.setAttribute('aria-label',`Показать проект ${project.title} во всём дашборде`);
      restore.disabled=!visibilityToken;
      restore.addEventListener('click',async()=>{
        restore.disabled=true;
        if (await saveProjectVisibility(project.id,false)) renderHiddenProjects(content);
        else if (restore.isConnected) restore.disabled=!visibilityToken;
      });
      item.append(el('span','',project.title),restore);list.append(item);
    }
    content.append(list);
  }
  const message=el('p','dialog-note');message.id='hidden-project-message';
  message.setAttribute('role','status');content.append(message);
}
function sliceOrbitPage(items, page, size) {
  const current = Math.max(0, Math.min(page, Math.ceil(items.length / size) - 1));
  const start = current * size;
  return { page: current, items: items.slice(start, start + size) };
}
// Each group owns one contiguous sector, each project a subsector, and each
// task a leaf. Shared objects remain one node; extra memberships are secondary
// links. The parent-child path is therefore short and readable.
function computeOrbitLayout(groups, projects, tasks, focusedGroupId = '', selectedProjectId = '') {
  const groupOf = new Map();
  const projectOf = new Map();
  for (const project of projects) {
    const parent = groups.find(group => group.id === focusedGroupId && group.projects.some(item => item.id === project.id)) ??
      groups.find(group => group.projects.some(item => item.id === project.id));
    if (parent) groupOf.set(project.id, parent.id);
  }
  for (const task of tasks) {
    const parent = projects.find(project => project.id === selectedProjectId && task.projectIds.includes(project.id)) ??
      projects.find(project => task.projectIds.includes(project.id));
    if (parent) projectOf.set(task.id, parent.id);
  }
  const ownedProjects = group => projects.filter(project => groupOf.get(project.id) === group.id);
  const ownedTasks = project => tasks.filter(task => projectOf.get(task.id) === project.id);
  const weight = group => Math.max(1, ownedProjects(group).reduce((sum, project) => sum + Math.max(1, ownedTasks(project).length), 0));
  const totalWeight = groups.reduce((sum, group) => sum + weight(group), 0) || 1;
  const minimumSector = Math.min(.62, Math.PI * 2 / Math.max(1, groups.length));
  const spare = Math.max(0, 2 * Math.PI - groups.length * minimumSector);
  const groupAngles = [], projectAngles = [], taskAngles = [];
  let cursor = -Math.PI / 2 - Math.PI / Math.max(1, groups.length);
  for (const group of groups) {
    const sector = minimumSector + spare * weight(group) / totalWeight;
    groupAngles.push(cursor + sector / 2);
    const children = ownedProjects(group);
    const childWeight = children.reduce((sum, project) => sum + Math.max(1, ownedTasks(project).length), 0);
    let childCursor = cursor + sector * .06;
    const usable = sector * .88;
    for (const project of children) {
      const leaves = ownedTasks(project);
      const width = usable * Math.max(1, leaves.length) / childWeight;
      projectAngles.push([project.id, childCursor + width / 2]);
      leaves.forEach((task, index) => taskAngles.push([task.id, childCursor + width * (index + .5) / leaves.length]));
      childCursor += width;
    }
    cursor += sector;
  }
  const angles = (items, entries) => {
    const byId = new Map(entries);
    return items.map((item, index) => byId.get(item.id) ?? -Math.PI / 2 + index * 2 * Math.PI / Math.max(1, items.length));
  };
  const projectOrder = angles(projects, projectAngles);
  const taskOrder = angles(tasks, taskAngles);
  const polar = (a, r) => ({x:r * Math.cos(a),y:r * Math.sin(a),angle:a});
  const points = (list, r) => list.map(angle => polar(angle,r));
  const overlaps = (a, b, wa, ha, wb, hb, same = false) =>
    a.some((p,i) => b.some((q,j) => (!same || i !== j) &&
      Math.abs(p.x-q.x) < (wa+wb)/2+10 && Math.abs(p.y-q.y) < (ha+hb)/2+10));
  let groupRx = 160, groupPoints = points(groupAngles,groupRx);
  while (overlaps(groupPoints,groupPoints,176,64,176,64,true)) {
    groupRx += 10; groupPoints = points(groupAngles,groupRx);
  }
  let projectRx = groupRx + 235, projectPoints = points(projectOrder,projectRx);
  while (overlaps(projectPoints,projectPoints,176,68,176,68,true) ||
         overlaps(groupPoints,projectPoints,176,64,176,68)) {
    projectRx += 10; projectPoints = points(projectOrder,projectRx);
  }
  let taskRx = projectRx + 250, taskPoints = points(taskOrder,taskRx);
  while (overlaps(taskPoints,taskPoints,196,72,196,72,true) ||
         overlaps(projectPoints,taskPoints,176,68,196,72) ||
         overlaps(groupPoints,taskPoints,176,64,196,72)) {
    taskRx += 10; taskPoints = points(taskOrder,taskRx);
  }
  const rings = {
    groups: { rx: groupRx, ry: groupRx },
    projects: { rx: projectRx, ry: projectRx },
    tasks: { rx: taskRx, ry: taskRx },
  };
  const outer = tasks.length ? rings.tasks : projects.length ? rings.projects : rings.groups;
  const width = Math.max(912, Math.ceil(2 * (outer.rx + 100)));
  const height = Math.max(700, Math.ceil(2 * (outer.ry + 72)));
  const cx = width / 2;
  const cy = height / 2;
  const positioned = ringPoints => ringPoints.map(point => ({ x: cx + point.x, y: cy + point.y, angle:point.angle }));
  return {
    width, height, cx, cy, rings,
    groups: positioned(groupPoints),
    projects: positioned(projectPoints),
    tasks: positioned(taskPoints),
    groupOf, projectOf,
  };
}
let selectedId = '';
let selectedTaskId = '';
const expandedGroups = new Set();
const expandedProjects = new Set();
const searchClosedGroups = new Set();
const searchClosedProjects = new Set();
const PROJECTS_PER_PAGE = 6;
const TASKS_PER_PAGE = 8;
let projectPage = 0;
let taskPage = 0;
let focusedGroupId = '';
let query = '';
let showConnections = true;
let panToFocus = false;
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
    if (group.projects.some(project => project.id === id)) {
      expandedGroups.add(group.id);
      focusedGroupId = group.id;
    }
  }
  projectPage = 0; taskPage = 0;
  panToFocus = true;
  renderBoard();
  [...$('project-orbit').querySelectorAll('[data-project-id]')].find(node => node.dataset.projectId === id)?.focus({ preventScroll: true });
}
function showTask(task) {
  openDialog(task.title, content => {
    const stage = stages.find(item => item.id === task.stage);
    content.append(el('p', '', `Этап: ${stage?.title ?? 'не определён'}`));
    content.append(el('p', '', `Прогресс: ${task.progress === null ? 'нет оценки' : `${task.progress}%`}`));
    if (comparison) {
      const before=previousTaskProgress(task.id), after=progressRange([task]);
      content.append(el('p','',`Сравнение: ${before ? progressLabel(before) : 'Задачи не было'} → ${progressLabel(after)} ${progressDelta(before,after)}`));
    }
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
function chooseOrbitNodes({ projects, matchingTasks, openGroups, selectedId, focusedGroupId,
  expandedProjects, searchClosedProjects, query, projectPage, taskPage }) {
  const openProjectIds = new Set(openGroups.flatMap(group => group.projects.map(project => project.id)));
  const focusedIds = new Set(openGroups.find(group => group.id === focusedGroupId)?.projects.map(project => project.id) ?? []);
  const candidates = projects.filter(project => openProjectIds.has(project.id));
  const orderedProjects = [
    ...candidates.filter(project => project.id === selectedId),
    ...candidates.filter(project => project.id !== selectedId && focusedIds.has(project.id)),
    ...candidates.filter(project => project.id !== selectedId && !focusedIds.has(project.id)),
  ];
  const projectSlice = sliceOrbitPage(orderedProjects, projectPage, PROJECTS_PER_PAGE);
  const visibleProjects = projectSlice.items;
  const activeProjects = new Set(visibleProjects.filter(project => query ? !searchClosedProjects.has(project.id) : expandedProjects.has(project.id)).map(project => project.id));
  const candidateTasks = matchingTasks.filter(task => task.projectIds.some(id => activeProjects.has(id)));
  const orderedTasks = [
    ...candidateTasks.filter(task => task.projectIds.includes(selectedId)),
    ...candidateTasks.filter(task => !task.projectIds.includes(selectedId)),
  ];
  const taskSlice = sliceOrbitPage(orderedTasks, taskPage, TASKS_PER_PAGE);
  return { orderedProjects, visibleProjects, activeProjects, orderedTasks, visibleTasks: taskSlice.items,
    projectPage: projectSlice.page, taskPage: taskSlice.page };
}
function renderBoard() {
  const matchingGroupProjectIds = new Set(groupProjects(projects, projectGroups)
    .filter(group => normal(group.title).includes(query))
    .flatMap(group => group.projects.map(project => project.id)));
  const matchingProjects = projects.filter(project => normal(project.title).includes(query) ||
    matchingGroupProjectIds.has(project.id));
  const matchingIds = new Set(matchingProjects.map(project => project.id));
  const matchingTasks = tasks.filter(task => !query || normal(task.title).includes(query) || task.projectIds.some(id => matchingIds.has(id)));
  const filteredProjects = projects.filter(project => !query || matchingIds.has(project.id) || matchingTasks.some(task => task.projectIds.includes(project.id)));
  const groups = groupProjects(filteredProjects, projectGroups);
  const changed = changedEntities();
  const fade = $('only-changes').checked && comparison;
  const openGroups = groups.filter(group => query ? !searchClosedGroups.has(group.id) : expandedGroups.has(group.id));
  const view = chooseOrbitNodes({ projects, matchingTasks, openGroups, selectedId, focusedGroupId,
    expandedProjects, searchClosedProjects, query, projectPage, taskPage });
  const { orderedProjects, visibleProjects, activeProjects, orderedTasks, visibleTasks } = view;
  projectPage = view.projectPage; taskPage = view.taskPage;
  document.documentElement.dataset.orbitFocus = String(orderedProjects.length > 0);
  const pager = (name, count, page, size, label) => {
    $(name + '-pager').hidden = count <= size;
    $(name + '-page-label').textContent = `${label} ${page * size + 1}–${Math.min((page + 1) * size, count)} из ${count}`;
    $(name + '-page-prev').disabled = page === 0;
    $(name + '-page-next').disabled = (page + 1) * size >= count;
  };
  pager('project', orderedProjects.length, projectPage, PROJECTS_PER_PAGE, 'Проекты');
  pager('task', orderedTasks.length, taskPage, TASKS_PER_PAGE, 'Задачи');
  $('board-summary').textContent = `${groups.length} ${plural(groups.length, 'группа', 'группы', 'групп')} · ${projectCount(filteredProjects.length)} · ${taskCount(matchingTasks.length)}`;
  $('search-status').textContent = query ? `Результат поиска: ${projectCount(filteredProjects.length)}, ${taskCount(matchingTasks.length)}.` : '';
  $('empty-search').textContent=query ? 'Ничего не найдено. Попробуйте другое слово.' :
    'Все проекты скрыты. Верните их в «План · Гант» → «Скрытые проекты».';
  $('empty-search').hidden = viewMode === 'plan' || groups.length > 0;
  const layout = computeOrbitLayout(groups, visibleProjects, visibleTasks, focusedGroupId, selectedId);
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
    node.classList.toggle('is-unchanged', Boolean(fade && !changed.groups.has(group.id)));
    node.title = group.title;
    node.setAttribute('aria-expanded', String(openGroups.includes(group)));
    node.setAttribute('aria-label', `${group.title}, ${projectCount(group.projects.length)}, прогресс ${progressLabel(groupProgress(group))}. ${openGroups.includes(group) ? 'Свернуть' : 'Раскрыть'}`);
    node.append(el('span', 'orbit-icon', '◈'), el('span', 'orbit-name', group.title), el('span', 'orbit-count', String(group.projects.length)));
    if (comparison) node.append(el('span','orbit-delta',progressDelta(previousGroupProgress(group),groupProgress(group))));
    node.addEventListener('click', () => {
      const set = query ? searchClosedGroups : expandedGroups;
      if (set.has(group.id)) set.delete(group.id);
      else { set.add(group.id); focusedGroupId = group.id; selectedId = ''; }
      projectPage = 0; taskPage = 0;
      panToFocus = true;
      renderBoard();
      [...$('project-list').querySelectorAll('[data-group-id]')].find(item => item.dataset.groupId === group.id)?.focus({ preventScroll: true });
    });
    return place(node, groupPoints.get(group.id));
  }));
  $('project-orbit').replaceChildren(...visibleProjects.map(project => {
    const node = el('button', 'orbit-node orbit-project');
    node.type = 'button'; node.dataset.projectId = project.id;
    node.classList.toggle('is-unchanged', Boolean(fade && !changed.projects.has(project.id)));
    node.classList.toggle('is-selected', project.id === selectedId);
    node.title = project.title;
    node.setAttribute('aria-expanded', String(activeProjects.has(project.id)));
    node.setAttribute('aria-label', `${project.title}, ${taskCount(tasks.filter(task => task.projectIds.includes(project.id)).length)}, прогресс ${progressLabel(projectProgress(project.id))}. ${activeProjects.has(project.id) ? 'Свернуть задачи' : 'Раскрыть задачи'}`);
    const surface = el('span', 'orbit-icon'); surface.append(icon(project.icon));
    node.append(surface, el('span', 'orbit-name', project.title), el('span', 'orbit-chevron', activeProjects.has(project.id) ? '−' : '+'));
    if (comparison) node.append(el('span','orbit-delta',progressDelta(previousProjectProgress(project.id),projectProgress(project.id))));
    node.addEventListener('click', () => {
      selectedId = project.id;
      if (!groups.some(group => group.id === focusedGroupId && group.projects.some(item => item.id === project.id)))
        focusedGroupId = groups.find(group => group.projects.some(item => item.id === project.id))?.id ?? '';
      const set = query ? searchClosedProjects : expandedProjects;
      if (set.has(project.id)) set.delete(project.id);
      else set.add(project.id);
      taskPage = 0;
      panToFocus = true;
      renderBoard();
      [...$('project-orbit').querySelectorAll('[data-project-id]')].find(item => item.dataset.projectId === project.id)?.focus({ preventScroll: true });
    });
    return place(node, projectPoints.get(project.id));
  }));
  $('task-board').replaceChildren(...visibleTasks.map(task => {
    const node = el('button', 'orbit-node orbit-task');
    node.type = 'button'; node.dataset.taskId = task.id;
    node.classList.toggle('is-unchanged', Boolean(fade && !changed.tasks.has(task.id)));
    node.title = task.title;
    const status = task.progress === null || task.progress === undefined ? 'Без оценки' : `${task.progress}%`;
    node.setAttribute('aria-label', `${task.title}. ${status}. Открыть задачу`);
    const marker = el('span', `task-marker${task.progress === 100 ? ' done' : ''}`, task.progress === 100 ? '✓' : '');
    node.append(marker, el('span', 'orbit-name', task.title), el('span', 'orbit-status',
      comparison ? `${status} · ${progressDelta(previousTaskProgress(task.id),progressRange([task])) || 'Новая'}` : status));
    node.addEventListener('click', () => {
      selectedTaskId = task.id;
      selectedId = task.projectIds.includes(selectedId) ? selectedId : layout.projectOf.get(task.id) ?? '';
      focusedGroupId = groups.find(group => group.id === focusedGroupId && group.projects.some(item => item.id === selectedId))?.id ??
        groups.find(group => group.projects.some(item => item.id === selectedId))?.id ?? '';
      panToFocus = true;
      renderBoard(); showTask(task);
    });
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
  if (panToFocus) {
    const point=taskPoints.get(selectedTaskId) ?? projectPoints.get(selectedId) ?? groupPoints.get(focusedGroupId);
    if (point) {
      viewport.scrollLeft=point.x*unit-viewport.clientWidth/2;
      viewport.scrollTop=point.y*unit-viewport.clientHeight/2;
    }
    panToFocus=false;
  }
  renderGantt();
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
  const link = (from, to, kind, current, previous, secondary = false, selected = false) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const d = `M ${from.x} ${from.y} C ${from.x + dx * .45} ${from.y + dy * .12}, ${to.x - dx * .45} ${to.y - dy * .12}, ${to.x} ${to.y}`;
    const path = (className, extra = {}) => shape('path', {d,pathLength:100,...extra}, className);
    paths.push(path(`orbit-link orbit-track ${kind}${secondary ? ' secondary-link' : ''}${selected ? ' selected-link' : ''}`));
    if (previous) paths.push(path(`orbit-previous${secondary ? ' secondary-progress' : ''}`,{'stroke-dasharray':`${previous.low} 100`}));
    if (current) {
      paths.push(path(`orbit-progress${secondary ? ' secondary-progress' : ''}${selected ? ' selected-link' : ''}`,{'stroke-dasharray':`${current.low} 100`}));
      if (current.high > current.low)
        paths.push(path(`orbit-uncertain${secondary ? ' secondary-progress' : ''}`,{'stroke-dasharray':`${current.high-current.low} 100`,
          'stroke-dashoffset':`-${current.low}`}));
    }
    if (selected && current) {
      const value = previous ? `${progressLabel(previous)} → ${progressLabel(current)} (${progressDelta(previous,current)})` : progressLabel(current);
      const label=shape('text',{x:from.x+dx*.5,y:from.y+dy*.5-9},'orbit-progress-label');
      label.textContent=value;
      paths.push(label);
    }
  };
  for (const group of groups) link({ x: layout.cx, y: layout.cy }, groupPoints.get(group.id), 'root-link',
    groupProgress(group), previousGroupProgress(group), false, group.id === focusedGroupId);
  for (const group of openGroups) for (const project of group.projects) {
    const target = projectPoints.get(project.id);
    if (target) link(groupPoints.get(group.id), target, 'project-link',
      projectProgress(project.id), previousProjectProgress(project.id),
      layout.groupOf.get(project.id) !== group.id, project.id === selectedId && group.id === focusedGroupId);
  }
  for (const task of visibleTasks) for (const id of task.projectIds) {
    const start = projectPoints.get(id);
    if (start) link(start, taskPoints.get(task.id), 'task-link',
      progressRange([task]), previousTaskProgress(task.id),
      layout.projectOf.get(task.id) !== id, task.id === selectedTaskId && id === selectedId);
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

function adoptCuratedSnapshot(snapshot, memberships, {preserve=false}={}) {
  if (snapshot?.schema !== 'dashboard-curated-snapshot/1' || !['partial','full'].includes(snapshot.coverage) ||
      !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.tasks) || !snapshot.sources) return;
  const graph=visibleGraph(snapshot,hiddenProjectIds());
  const visibleIds=new Set(graph.projects.map(project=>project.id));
  const visible = withMemberships(snapshot,memberships).filter(project => visibleIds.has(project.id));
  const projectIds = new Set(visible.map(project => project.id));
  curatedSnapshot = snapshot;
  projects = visible.map(project => ({ ...project, icon: 'folder' }));
  projectGroups = snapshot.project_groups ?? [];
  tasks = graph.tasks.map(task => ({ id: task.id, title: task.title, stage: 'unknown',
    progress: task.progress_percent, projectIds: task.project_ids,
    progressBasis: task.progress_basis, observedStatus: task.observed_status,
    evidence: task.evidence ?? [] }));
  stages = [{ id: 'unknown', title: 'Этап не определён' }];
  inbox = []; priorities = []; changes = [];
  demoInbox.length = 0;
  automations = snapshot.automations.map(item => ({ title: item.title, icon: 'settings',
    description: scheduleDescription(item) }));
  selectedId = preserve && projects.some(project=>project.id===selectedId) ? selectedId : projects[0]?.id ?? '';
  if (!preserve) {expandedGroups.clear(); expandedProjects.clear();
    searchClosedGroups.clear(); searchClosedProjects.clear();
    projectPage = 0; taskPage = 0; focusedGroupId = '';}
  else {
    for (const id of expandedProjects) if (!projectIds.has(id)) expandedProjects.delete(id);
    if (!projects.some(project=>project.group_codes?.includes(focusedGroupId))) focusedGroupId='';
  }
  const hiddenCount=liveSnapshot?.projects.filter(project=>isProjectHidden(project.id)).length ?? 0;
  $('gantt-hidden').textContent=`Скрытые проекты (${hiddenCount})`;
  $('gantt-hidden').disabled=!liveSnapshot;
  document.documentElement.dataset.dataMode = 'curated';
  document.querySelector('.demo-label').textContent = `${snapshot.coverage === 'partial' ? 'Неполная выборка' : 'Выборка'} · ${snapshot.as_of ?? 'дата неизвестна'}`;
  document.querySelector('.board-footnote').textContent = snapshot.coverage_note ?? 'Состав и охват данных указаны в выбранном снимке.';
  document.querySelector('.priorities-paper .example').textContent = 'Нет оценки';
  document.querySelector('.automation-paper .example').textContent = 'Проверено';
  document.querySelector('.run-errors p:last-child').textContent = 'Не проверялись';
  $('add-inbox').disabled = true;
  $('add-inbox').title = 'Запись в базу из этого экрана пока недоступна';
  renderSidePanels(); renderBoard();
}

fetch('/dashboard/api/snapshot', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => {
    if (response.ok) {
      const snapshot=await response.json();
      await loadVisibility();
      liveSnapshot=snapshot;
      adoptCuratedSnapshot(liveSnapshot);
      await Promise.allSettled([loadHistory(),loadPlan().catch(()=>{ if (viewMode === 'plan') $('gantt-status').textContent='План пока недоступен. Даты нельзя сохранить.'; })]);
    }
    else if (response.status === 401) {
      document.querySelector('.demo-label').textContent = 'Демо · личные данные после входа владельца';
      $('compare-coverage').textContent='Сравнение доступно после входа владельца';
      $('timeline-status').textContent='Демонстрационные события не подменяют личную историю.';
    }
    else {
      document.querySelector('.demo-label').textContent = 'Демо · личный снимок пока недоступен';
      $('compare-coverage').textContent='Личный снимок пока недоступен';
    }
  })
  .catch(() => {
    document.querySelector('.demo-label').textContent = 'Демо · личный снимок или настройка видимости пока недоступны';
    $('compare-coverage').textContent='Личный снимок пока недоступен';
  });
async function loadHistory() {
  try {
    const response = await fetch('/dashboard/api/history',{credentials:'same-origin',cache:'no-store'});
    if (!response.ok) throw new Error('unavailable');
    const dates = await response.json();
    if (!Array.isArray(dates) || dates.length < 2) {
      $('compare-coverage').textContent = 'Для сравнения нужны два сохранённых дня';
      $('timeline-status').textContent = 'Дневная история ещё не накоплена. Текущий прогресс показан на связях.';
      return;
    }
    const recent=dates[0].date, before=dates[1].date;
    for (const id of ['a-from','a-to']) $(id).value=before;
    for (const id of ['b-from','b-to']) $(id).value=recent;
    $('compare-apply').disabled=false;
    $('compare-coverage').textContent = `Доступно дней: ${dates.length}. Охват каждого дня указан после сравнения.`;
    $('timeline-status').textContent = 'Выберите два отрезка и нажмите «Сравнить».';
  } catch {
    $('compare-coverage').textContent = 'История пока недоступна';
    $('timeline-status').textContent = 'Текущий прогресс показан на связях. Сравнение ждёт дневных снимков.';
  }
}
function renderTimeline() {
  const list=$('timeline-events');
  if (!comparison) { list.replaceChildren(); return; }
  const kind = event => String(event.type ?? event.kind ?? 'Изменение');
  const events = [['А',comparison.a],['Б',comparison.b]].flatMap(([period,data]) => {
    const snapshot=data.endpoint.payload;
    const graph=visibleGraph(snapshot,hiddenProjectIds());
    const visibleProjects=new Set(graph.projects.map(project=>project.id));
    const knownProjects=new Set(snapshot.projects.map(project=>project.id));
    const visibleTasks=new Set(graph.tasks.map(task=>task.id));
    const knownTasks=new Set(snapshot.tasks.map(task=>task.id));
    if (visibleProjects.size===knownProjects.size) return data.events.map(event=>({period,event}));
    return data.events.filter(event=>{
      const ids=[event.project_id,event.task_id,event.entity_id,event.id].filter(id=>typeof id==='string');
      return ids.some(id=>visibleProjects.has(id) || visibleTasks.has(id)) &&
        ids.every(id=>(!knownProjects.has(id) || visibleProjects.has(id)) &&
          (!knownTasks.has(id) || visibleTasks.has(id)));
    }).map(event => ({period,event}));
  });
  $('timeline-status').textContent = events.length
    ? `Событий видимых проектов и задач: ${events.length}. Показаны только события из сохранённых дней выбранных отрезков.`
    : 'В сохранённых днях выбранных отрезков нет событий; это не доказывает отсутствие изменений вне доступного охвата.';
  list.replaceChildren(...events.map(({period,event}) => {
    const id=event.task_id ?? event.project_id ?? event.entity_id ?? event.id;
    const title=tasks.find(task=>task.id===id)?.title ?? projects.find(project=>project.id===id)?.title ??
      event.title ?? id ?? 'Событие';
    const item=el('button','timeline-event');
    item.type='button';
    item.append(el('strong','',period),el('span','',event.report_date),
      el('span','',kind(event)),el('span','',String(title)));
    item.addEventListener('click',()=>{
      const task=tasks.find(task=>task.id===id);
      if (task) {
        const parent=task.projectIds[0];
        selectedId=parent;selectedTaskId=task.id;expandedProjects.add(parent);
      } else if (projects.some(project=>project.id===id)) selectedId=id;
      if (selectedId) for (const group of groupProjects(projects,projectGroups))
        if (group.projects.some(project=>project.id===selectedId)) {expandedGroups.add(group.id);focusedGroupId=group.id;break;}
      projectPage=0;taskPage=0;panToFocus=true;renderBoard();
      openDialog(String(title),content=>{
        content.append(el('p','',`${event.report_date}: ${kind(event)}`));
        const before=event.old_value ?? event.old, after=event.new_value ?? event.new;
        if (before !== undefined || after !== undefined)
          content.append(el('p','',`${JSON.stringify(before ?? '—')} → ${JSON.stringify(after ?? '—')}`));
        const source=event.source_url ?? event.source?.url ??
          curatedSnapshot?.sources?.[event.source_id]?.url;
        let safe=null;
        try { const url=new URL(source); if (['https:','http:'].includes(url.protocol)) safe=url.href; } catch {}
        if (safe) {
          const anchor=el('a','','Открыть свидетельство ↗');
          anchor.href=safe;anchor.target='_blank';anchor.rel='noopener noreferrer';
          content.append(anchor);
        } else content.append(el('p','dialog-note',event.source_id
          ? `Источник: ${event.source_id}` : 'Ссылка на свидетельство в этом событии не сохранена.'));
      });
    });
    return item;
  }));
}
function period(name) {return {from:$(name+'-from').value,to:$(name+'-to').value};}
const periodDays = period => Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`))/86400000)+1;
$('compare-apply').addEventListener('click',async()=>{
  const a=period('a'),b=period('b');
  $('compare-apply').disabled=true;
  $('compare-coverage').textContent='Сравнение загружается…';
  try {
    const query=new URLSearchParams({a_from:a.from,a_to:a.to,b_from:b.from,b_to:b.to});
    const response=await fetch('/dashboard/api/compare?'+query,{credentials:'same-origin',cache:'no-store'});
    if (!response.ok) throw new Error(response.status===400 ? 'Проверьте даты: отрезки не должны пересекаться.' : 'История недоступна.');
    const result=await response.json();
    if (!result.a.endpoint || !result.b.endpoint)
      throw new Error('Для конца каждого отрезка нужен сохранённый дневной снимок.');
    comparison=result;
    selectedTaskId='';
    adoptCuratedSnapshot(result.b.endpoint.payload,result.b.endpoint.group_memberships);
    $('compare-clear').hidden=false;
    $('only-changes').disabled=false;
    const partial=[...result.a.days,...result.b.days].some(day=>day.coverage==='partial');
    const missingA=periodDays(a)-result.a.days.length, missingB=periodDays(b)-result.b.days.length;
    $('compare-coverage').textContent = `Состояния на ${result.a.endpoint.date} и ${result.b.endpoint.date}. Сохранено дней: А ${result.a.days.length}/${periodDays(a)}, Б ${result.b.days.length}/${periodDays(b)}.${missingA || missingB ? ` Пропуски: А ${missingA}, Б ${missingB}.` : ''}${partial ? ' Есть дни с частичным охватом.' : ''}`;
    renderTimeline();
  } catch(error) { $('compare-coverage').textContent=error.message; }
  finally { $('compare-apply').disabled=false; }
});
$('compare-clear').addEventListener('click',()=>{
  comparison=null;selectedTaskId='';
  $('only-changes').checked=false;$('only-changes').disabled=true;
  $('compare-clear').hidden=true;
  if (liveSnapshot) adoptCuratedSnapshot(liveSnapshot);
  $('compare-coverage').textContent='Текущий снимок. Выберите отрезки для сравнения.';
  $('timeline-status').textContent='Выберите два отрезка и нажмите «Сравнить».';
  renderTimeline();
});
$('only-changes').addEventListener('change',renderBoard);
function setView(mode) {
  viewMode=mode;
  document.documentElement.dataset.boardView=mode;
  $('view-orbits').setAttribute('aria-pressed',String(mode === 'orbits'));
  $('view-plan').setAttribute('aria-pressed',String(mode === 'plan'));
  $('gantt-view').hidden=mode !== 'plan';
  document.querySelector('.orbit-legend').hidden=mode === 'plan';
  document.querySelector('.orbit-paging').hidden=mode === 'plan';
  document.querySelector('.board-scroll').hidden=mode === 'plan';
  document.querySelector('.board-footnote').hidden=mode === 'plan';
  $('board-mode-label').textContent=mode === 'plan' ? 'Календарный план' : 'Орбиты связей';
  $('empty-search').hidden=mode === 'plan' || !query;
  if (mode === 'plan') renderGantt();
  else renderBoard();
}
$('view-orbits').addEventListener('click',()=>setView('orbits'));
$('view-plan').addEventListener('click',()=>setView('plan'));
$('gantt-prev').addEventListener('click',()=>{ganttStart-=14*DAY;renderGantt();});
$('gantt-next').addEventListener('click',()=>{ganttStart+=14*DAY;renderGantt();});
$('gantt-today').addEventListener('click',()=>{ganttStart=todayDay()-7*DAY;renderGantt();});
$('gantt-hidden').addEventListener('click',()=>openDialog('Скрытые проекты',renderHiddenProjects));
$('gantt-jump').addEventListener('change',event=>{
  if (event.target.value) {ganttStart=dayValue(event.target.value)-7*DAY;renderGantt();}
});
$('search').addEventListener('input', event => { query = normal(event.target.value); searchClosedGroups.clear(); searchClosedProjects.clear(); projectPage = 0; taskPage = 0; renderBoard(); });
$('project-page-prev').addEventListener('click', () => { projectPage--; taskPage = 0; renderBoard(); });
$('project-page-next').addEventListener('click', () => { projectPage++; taskPage = 0; renderBoard(); });
$('task-page-prev').addEventListener('click', () => { taskPage--; renderBoard(); });
$('task-page-next').addEventListener('click', () => { taskPage++; renderBoard(); });
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
    searchClosedGroups.clear(); searchClosedProjects.clear(); selectedId = '';
    focusedGroupId = ''; projectPage = 0; taskPage = 0; renderBoard(); window.scrollTo({ top: 0 });
  } else {
    const target = $(button.dataset.nav === 'projects' ? 'projects-panel' : 'automations-panel');
    target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true });
  }
});
document.documentElement.style.setProperty('--asset-scale', String(parseFloat(getComputedStyle(document.documentElement).fontSize) / 2));
window.addEventListener('resize', () => document.documentElement.style.setProperty('--asset-scale', String(parseFloat(getComputedStyle(document.documentElement).fontSize) / 2)));

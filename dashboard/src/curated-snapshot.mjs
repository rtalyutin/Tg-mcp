import {createHash} from 'node:crypto';

const normal = value => value.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();

export function validateCuratedSnapshot(value) {
  if (!value || value.schema !== 'dashboard-curated-snapshot/1' || value.coverage !== 'partial' ||
      !Array.isArray(value.projects) || !Array.isArray(value.tasks) ||
      !Array.isArray(value.automations) || !value.sources || typeof value.sources !== 'object' ||
      !Array.isArray(value.excluded_project_titles) ||
      value.excluded_project_titles.some(title => typeof title !== 'string' || !title.trim()))
    throw new Error('INVALID_CURATED_SNAPSHOT');
  const excluded = new Set(value.excluded_project_titles.map(normal));
  if (value.projects.length > 200 || value.tasks.length > 2000 || value.automations.length > 200)
    throw new Error('INVALID_CURATED_SNAPSHOT');
  const groupIds = new Set();
  if (value.project_groups !== undefined) {
    if (!Array.isArray(value.project_groups) || value.project_groups.length > 200)
      throw new Error('INVALID_CURATED_SNAPSHOT');
    for (const group of value.project_groups) {
      if (!group || typeof group.id !== 'string' || !group.id.trim() ||
          typeof group.title !== 'string' || !group.title.trim() || groupIds.has(group.id))
        throw new Error('INVALID_CURATED_SNAPSHOT');
      groupIds.add(group.id);
    }
  }
  const projectIds = new Set();
  for (const project of value.projects) {
    if (typeof project.id !== 'string' || typeof project.title !== 'string' || !project.title.trim() ||
        excluded.has(normal(project.title)) || projectIds.has(project.id)) throw new Error('INVALID_CURATED_SNAPSHOT');
    if (project.group_ids !== undefined &&
        (!Array.isArray(project.group_ids) || !project.group_ids.length ||
         new Set(project.group_ids).size !== project.group_ids.length ||
         project.group_ids.some(id => typeof id !== 'string' || !groupIds.has(id))))
      throw new Error('INVALID_CURATED_SNAPSHOT');
    projectIds.add(project.id);
  }
  const taskIds = new Set();
  for (const task of value.tasks) {
    if (typeof task.id !== 'string' || typeof task.title !== 'string' || !task.title.trim() ||
        taskIds.has(task.id) || !Array.isArray(task.project_ids) || !task.project_ids.length ||
        task.project_ids.some(id => !projectIds.has(id)) ||
        !(task.progress_percent === null || Number.isFinite(task.progress_percent) && task.progress_percent >= 0 && task.progress_percent <= 100) ||
        !Array.isArray(task.evidence) || task.evidence.length === 0 || task.evidence.some(id => !Object.hasOwn(value.sources,id)))
      throw new Error('INVALID_CURATED_SNAPSHOT');
    taskIds.add(task.id);
  }
  const automationIds = new Set();
  for (const automation of value.automations) {
    if (!automation || typeof automation.id !== 'string' || !automation.id.trim() ||
        automationIds.has(automation.id) || typeof automation.title !== 'string' || !automation.title.trim() ||
        automation.enabled !== true || typeof automation.schedule !== 'string' || !automation.schedule.trim() ||
        typeof automation.timezone !== 'string' || !automation.timezone.trim() ||
        !Array.isArray(automation.evidence) || !automation.evidence.length ||
        automation.evidence.some(id => typeof id !== 'string' || !Object.hasOwn(value.sources,id)))
      throw new Error('INVALID_CURATED_SNAPSHOT');
    automationIds.add(automation.id);
  }
  return value;
}

export async function importCuratedSnapshot(db, value) {
  validateCuratedSnapshot(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 512_000) throw new Error('INVALID_CURATED_SNAPSHOT');
  const digest = createHash('sha256').update(serialized).digest('hex');
  await db.query(`INSERT INTO dashboard.curated_snapshot(singleton,payload,digest)
    VALUES (1,$1::jsonb,$2) ON CONFLICT(singleton) DO UPDATE
    SET payload=EXCLUDED.payload,digest=EXCLUDED.digest,imported_at=now()`,[serialized,digest]);
  return {digest,projects:value.projects.length,tasks:value.tasks.length};
}

export async function readCuratedSnapshot(db) {
  const {rows} = await db.query('SELECT payload FROM dashboard.curated_snapshot WHERE singleton=1');
  if (!rows.length) return null;
  return validateCuratedSnapshot(rows[0].payload);
}

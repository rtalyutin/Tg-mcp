const normal = value => value.toLocaleLowerCase('ru').replaceAll('ё','е').trim();

// A task shared with any hidden or explicitly excluded project is invisible
// everywhere. Keep the source snapshot intact so the owner can restore it.
export function visibleGraph(snapshot, hiddenProjectIds) {
  const excluded=new Set(snapshot.excluded_project_titles?.map(normal) ?? []);
  const projects=snapshot.projects.filter(project=>
    !hiddenProjectIds.has(project.id) && !excluded.has(normal(project.title)));
  const ids=new Set(projects.map(project=>project.id));
  const tasks=snapshot.tasks.filter(task=>Array.isArray(task.project_ids) &&
    task.project_ids.length>0 && task.project_ids.every(id=>ids.has(id)));
  return {projects,tasks};
}

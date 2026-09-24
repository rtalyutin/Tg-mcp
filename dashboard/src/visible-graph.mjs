import {readUnfilteredCanonicalGraph} from './canonical-graph.mjs';

// The owner chose: a hidden folder hides every linked project; a task linked
// to any hidden project disappears everywhere, including visible projects.
// Keep the unfiltered snapshot and this private presentation step separate.
export function filterCanonicalGraphForOwner(graph) {
  const required = [
    'projects','tasks','taskProjects','taskRelations','folders','projectFolders',
    'projectVisibility','folderVisibility'
  ];
  if (!graph || required.some(key => !Array.isArray(graph[key])))
    throw new Error('INVALID_CANONICAL_GRAPH');

  const hiddenFolders = new Set(graph.folderVisibility.filter(x => x.hidden).map(x => x.folderId));
  const folders = graph.folders.filter(x => !hiddenFolders.has(x.id));
  const visibleFolderIds = new Set(folders.map(x => x.id));
  const hiddenProjects = new Set(graph.projectVisibility.filter(x => x.hidden).map(x => x.projectId));
  for (const {projectId,folderId} of graph.projectFolders)
    if (!visibleFolderIds.has(folderId)) hiddenProjects.add(projectId);

  const projects = graph.projects.filter(x => !hiddenProjects.has(x.id));
  const visibleProjectIds = new Set(projects.map(x => x.id));
  const memberships = new Map();
  for (const {taskId,projectId} of graph.taskProjects) {
    const state = memberships.get(taskId) ?? {count:0,allVisible:true};
    state.count++;
    if (!visibleProjectIds.has(projectId)) state.allVisible = false;
    memberships.set(taskId,state);
  }
  // This is a project-scoped graph: tasks without project membership cannot
  // appear in any project. Their eventual separate view is still undecided.
  const tasks = graph.tasks.filter(x => {
    const state = memberships.get(x.id);
    return state?.count > 0 && state.allVisible;
  });
  const visibleTaskIds = new Set(tasks.map(x => x.id));

  return {
    projects,
    tasks,
    taskProjects:graph.taskProjects.filter(x => visibleTaskIds.has(x.taskId) && visibleProjectIds.has(x.projectId)),
    taskRelations:graph.taskRelations.filter(x => visibleTaskIds.has(x.fromTaskId) && visibleTaskIds.has(x.toTaskId)),
    folders:folders.map(({id,title}) => ({id,title})),
    projectFolders:graph.projectFolders.filter(x => visibleProjectIds.has(x.projectId) && visibleFolderIds.has(x.folderId))
  };
}

// Only call with an owner-authorized database connection that has canonical
// SELECT rights. The import runtime role intentionally cannot read these tables.
export async function readOwnerVisibleGraph(db) {
  return filterCanonicalGraphForOwner(await readUnfilteredCanonicalGraph(db));
}

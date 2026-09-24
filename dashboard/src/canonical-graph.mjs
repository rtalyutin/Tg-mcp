// Internal owner-data reader. Never expose this unfiltered result through HTTP/MCP.
const MAX_ROWS_PER_TABLE = 10_000;

const TABLES = {
  projects: `SELECT id,title,state_value,version FROM dashboard.project ORDER BY id`,
  tasks: `SELECT id,title,expected_result,state_value,progress_percent,progress_method,version
    FROM dashboard.task ORDER BY id`,
  taskProjects: `SELECT task_id,project_id FROM dashboard.task_project ORDER BY task_id,project_id`,
  taskRelations: `SELECT from_task_id,to_task_id,relation_type FROM dashboard.task_relation
    ORDER BY from_task_id,to_task_id,relation_type`,
  folders: `SELECT id,source_id,native_id,title FROM dashboard.folder ORDER BY id`,
  projectFolders: `SELECT project_id,folder_id FROM dashboard.project_folder ORDER BY project_id,folder_id`,
  projectVisibility: `SELECT project_id,hidden,version,updated_at
    FROM dashboard.project_visibility ORDER BY project_id`,
  folderVisibility: `SELECT folder_id,hidden,version,updated_at
    FROM dashboard.folder_visibility ORDER BY folder_id`
};

function safeVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('CANONICAL_VERSION_OUT_OF_RANGE');
  return version;
}

function normalize(key, row) {
  switch (key) {
    case 'projects': return {id:row.id,title:row.title,stateValue:row.state_value,version:safeVersion(row.version)};
    case 'tasks': return {
      id:row.id,title:row.title,expectedResult:row.expected_result,stateValue:row.state_value,
      progressPercent:row.progress_percent === null ? null : Number(row.progress_percent),
      progressMethod:row.progress_method,version:safeVersion(row.version)
    };
    case 'taskProjects': return {taskId:row.task_id,projectId:row.project_id};
    case 'taskRelations': return {fromTaskId:row.from_task_id,toTaskId:row.to_task_id,relationType:row.relation_type};
    case 'folders': return {id:row.id,sourceId:row.source_id,nativeId:row.native_id,title:row.title};
    case 'projectFolders': return {projectId:row.project_id,folderId:row.folder_id};
    case 'projectVisibility': return {
      projectId:row.project_id,hidden:row.hidden,version:safeVersion(row.version),
      updatedAt:new Date(row.updated_at).toISOString()
    };
    case 'folderVisibility': return {
      folderId:row.folder_id,hidden:row.hidden,version:safeVersion(row.version),
      updatedAt:new Date(row.updated_at).toISOString()
    };
  }
}

// A repeatable-read transaction prevents relations and nodes from coming from
// different database moments. The row cap fails closed rather than returning a
// partial graph that a downstream presenter could mistake for the whole state.
export async function readUnfilteredCanonicalGraph(db) {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = {};
    for (const [key, sql] of Object.entries(TABLES)) {
      const {rows} = await tx.query(`${sql} LIMIT $1`, [MAX_ROWS_PER_TABLE + 1]);
      if (rows.length > MAX_ROWS_PER_TABLE) throw new Error('CANONICAL_GRAPH_TOO_LARGE');
      result[key] = rows.map(row => normalize(key, row));
    }
    return result;
  });
}

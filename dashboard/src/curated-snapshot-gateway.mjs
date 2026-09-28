import {connectPostgres} from './postgres.mjs';
import {readCuratedSnapshot} from './curated-snapshot.mjs';
import {readGroupedSnapshot} from './project-groups.mjs';
import {createHistoryReader} from './history-read.mjs';
import {createTaskPlan} from './task-plan.mjs';
import {createProjectVisibility} from './project-visibility.mjs';

function gateway(db, historyAvailable, planAvailable=false, visibilityAvailable=false, visibilityWritable=false, lateVisibility=false) {
  const history=createHistoryReader(db);
  const plan=createTaskPlan(db);
  const visibility=createProjectVisibility(db);
  const result={
    readSnapshot: () => readCuratedSnapshot(db),
    read: async () => {
      const snapshot=await readCuratedSnapshot(db);
      return snapshot ? readGroupedSnapshot(db,snapshot) : null;
    },
    ...(historyAvailable ? {dates:history.dates,compare:history.compare} : {}),
    ...(planAvailable ? {readPlan:plan.read,writeTaskPlan:plan.write} : {}),
    ...(visibilityWritable ? {writeVisibility:visibility.write} : {}),
    close: () => db.close()
  };
  if (visibilityAvailable || lateVisibility) result.readVisibility=async()=>{
    if (lateVisibility) {
      // Migration 010 may be applied after this HTTP process starts. Keep the
      // owner view closed until the table can actually be read, then refresh
      // the edit capability without requiring a service restart.
      await db.query('SELECT project_id FROM dashboard.curated_project_visibility LIMIT 0');
      const {rows:[rights]}=await db.query(`SELECT
        has_table_privilege(current_user,'dashboard.curated_project_visibility','INSERT') AS can_insert,
        has_table_privilege(current_user,'dashboard.curated_project_visibility','UPDATE') AS can_update`);
      result.writeVisibility=rights?.can_insert && rights?.can_update ? visibility.write : undefined;
    }
    return visibility.read();
  };
  return result;
}

export async function createCuratedSnapshotGateway(connectionString, {connect=connectPostgres,sharedRole=false}={}) {
  if (!connectionString) return null;
  const db = connect(connectionString);
  try {
    if (sharedRole) {
      // Same login as the existing service: check only the fixed Dashboard table.
      // The HTTP route still requires the owner's session before calling read().
      await db.query('SELECT digest FROM dashboard.curated_snapshot WHERE singleton=1');
      const historyAvailable=await db.query('SELECT report_date FROM dashboard.published_daily_history LIMIT 0')
        .then(()=>true,()=>false);
      const planAvailable=await db.query('SELECT task_id FROM dashboard.task_plan LIMIT 0')
        .then(()=>true,()=>false);
      const visibilityAvailable=await db.query('SELECT project_id FROM dashboard.curated_project_visibility LIMIT 0')
        .then(()=>true,()=>false);
      const visibilityWritable=visibilityAvailable && (await db.query(`SELECT
        has_table_privilege(current_user,'dashboard.curated_project_visibility','INSERT') AS can_insert,
        has_table_privilege(current_user,'dashboard.curated_project_visibility','UPDATE') AS can_update`))
        .rows[0];
      return gateway(db,historyAvailable,planAvailable,visibilityAvailable,
        !!visibilityWritable?.can_insert && !!visibilityWritable?.can_update,true);
    }
    const {rows} = await db.query(`SELECT
      has_table_privilege(current_user,'dashboard.curated_snapshot','SELECT') AS can_read,
      has_table_privilege(current_user,'dashboard.curated_snapshot','INSERT') AS can_insert,
      has_table_privilege(current_user,'dashboard.curated_snapshot','UPDATE') AS can_update,
      has_table_privilege(current_user,'dashboard.curated_snapshot','DELETE') AS can_delete,
      has_table_privilege(current_user,'dashboard.curated_snapshot','TRUNCATE') AS can_truncate,
      has_table_privilege(current_user,'dashboard.source_event','SELECT') AS can_read_sources`);
    const rights = rows[0];
    if (!rights?.can_read || rights.can_insert || rights.can_update || rights.can_delete ||
        rights.can_truncate || rights.can_read_sources)
      throw new Error('DASHBOARD_SNAPSHOT_ROLE_INVALID');
    const historyAvailable=await db.query('SELECT report_date FROM dashboard.published_daily_history LIMIT 0')
      .then(()=>true,()=>false);
    const visibilityAvailable=await db.query('SELECT project_id FROM dashboard.curated_project_visibility LIMIT 0')
      .then(()=>true,()=>false);
    return gateway(db,historyAvailable,false,visibilityAvailable);
  } catch (error) { await db.close(); throw error; }
}

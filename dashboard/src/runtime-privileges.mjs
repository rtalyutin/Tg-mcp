// The HTTP process must use a narrow database login, never the migration owner.
const grants = Object.freeze({
  'dashboard.dashboard_schema_migration': ['SELECT'],
  'dashboard.source': ['SELECT'],
  'dashboard.source_checkpoint': ['SELECT', 'UPDATE'],
  'dashboard.collection_run': ['SELECT', 'INSERT', 'UPDATE'],
  'dashboard.run_source': ['SELECT', 'INSERT', 'UPDATE'],
  'dashboard.ingest_batch': ['SELECT', 'INSERT', 'UPDATE'],
  'dashboard.source_event': ['SELECT', 'INSERT'],
  'dashboard.batch_event': ['SELECT', 'INSERT'],
  'dashboard.projects_groups': ['SELECT'],
  'dashboard.run_attempt': ['INSERT']
});
const privateTables = Object.freeze([
  'dashboard.folder', 'dashboard.project', 'dashboard.project_folder',
  'dashboard.task', 'dashboard.task_project', 'dashboard.task_relation',
  'dashboard.project_visibility', 'dashboard.folder_visibility',
  'dashboard.change_proposal', 'dashboard.entity_history',
  'dashboard.candidate_resolution', 'dashboard.daily_result'
]);
const allPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

export async function verifyRuntimePrivileges(db) {
  const {rows:[role]}=await db.query(`SELECT r.rolsuper AS superuser,
    has_schema_privilege(current_user,'dashboard','USAGE') AS can_use_schema,
    has_schema_privilege(current_user,'dashboard','CREATE') AS can_create_schema,
    has_schema_privilege(current_user,'public','CREATE') AS can_create_public,
    has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (!role || role.superuser || !role.can_use_schema || role.can_create_schema
      || role.can_create_public || role.can_create_database) throw new Error('DASHBOARD_DB_ROLE_INVALID');

  for (const [table, allowed] of Object.entries(grants)) {
    for (const privilege of allPrivileges) {
      const {rows:[row]}=await db.query(
        'SELECT has_table_privilege(current_user,$1,$2) AS granted',[table,privilege]);
      if (row?.granted!==allowed.includes(privilege)) throw new Error('DASHBOARD_DB_ROLE_INVALID');
    }
  }
  for (const table of privateTables) {
    for (const privilege of allPrivileges) {
      const {rows:[row]}=await db.query(
        'SELECT has_table_privilege(current_user,$1,$2) AS granted',[table,privilege]);
      if (row?.granted!==false) throw new Error('DASHBOARD_DB_ROLE_INVALID');
    }
  }
  const {rows:[sequence]}=await db.query(`SELECT
    has_sequence_privilege(current_user,'dashboard.run_attempt_id_seq','USAGE') AS can_use,
    has_sequence_privilege(current_user,'dashboard.run_attempt_id_seq','SELECT') AS can_read,
    has_sequence_privilege(current_user,'dashboard.run_attempt_id_seq','UPDATE') AS can_change`);
  if (!sequence?.can_use || sequence.can_read || sequence.can_change)
    throw new Error('DASHBOARD_DB_ROLE_INVALID');
}

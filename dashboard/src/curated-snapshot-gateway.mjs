import {connectPostgres} from './postgres.mjs';
import {readCuratedSnapshot} from './curated-snapshot.mjs';
import {readGroupedSnapshot} from './project-groups.mjs';

function gateway(db) {
  return {
    readSnapshot: () => readCuratedSnapshot(db),
    read: async () => {
      const snapshot=await readCuratedSnapshot(db);
      return snapshot ? readGroupedSnapshot(db,snapshot) : null;
    },
    close: () => db.close()
  };
}

export async function createCuratedSnapshotGateway(connectionString, {connect=connectPostgres,sharedRole=false}={}) {
  if (!connectionString) return null;
  const db = connect(connectionString);
  try {
    if (sharedRole) {
      // Same login as the existing service: check only the fixed Dashboard table.
      // The HTTP route still requires the owner's session before calling read().
      await db.query('SELECT digest FROM dashboard.curated_snapshot WHERE singleton=1');
      return gateway(db);
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
    return gateway(db);
  } catch (error) { await db.close(); throw error; }
}

import {connectPostgres} from './postgres.mjs';
import {readCuratedSnapshot} from './curated-snapshot.mjs';

export async function createCuratedSnapshotGateway(connectionString, {connect=connectPostgres,sharedRole=false}={}) {
  if (!connectionString) return null;
  const db = connect(connectionString);
  try {
    if (sharedRole) {
      // Same login as the existing service: check only the fixed Dashboard table.
      // The HTTP route still requires the owner's session before calling read().
      await db.query('SELECT digest FROM dashboard.curated_snapshot WHERE singleton=1');
      return {read: options => readSnapshot(db, options), close: () => db.close()};
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
    return {read: options => readSnapshot(db, options), close: () => db.close()};
  } catch (error) { await db.close(); throw error; }
}

async function readSnapshot(db, options={}) {
  const timeoutMs=options?.timeoutMs;
  if (timeoutMs===undefined)
    return readCuratedSnapshot(db);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000)
    throw new Error('DASHBOARD_READ_TIMEOUT_INVALID');
  return db.transaction(async tx=>{
    await tx.exec('SET TRANSACTION READ ONLY');
    await tx.exec(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return readCuratedSnapshot(tx);
  },{timeoutMs});
}

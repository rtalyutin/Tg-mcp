import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {connectPostgres} from './postgres.mjs';
import {validateCuratedSnapshot} from './curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from './curated-snapshot-gateway.mjs';
import {DashboardMigrationError} from './migration-service.mjs';

export function validateSnapshotUpdateConfig(env) {
  if (!env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID) return null;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID))
    throw new Error('DASHBOARD_SNAPSHOT_WRITE_CONFIG_INVALID');
  try {
    const url=new URL(env.DATABASE_URL);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.username ||
        !url.hostname || url.pathname.length<2 || url.hash) throw new Error();
  } catch {throw new Error('DASHBOARD_SNAPSHOT_WRITE_CONFIG_INVALID');}
  return {credentialId:env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID.toLowerCase(),databaseUrl:env.DATABASE_URL};
}

function summary(row) {
  return {digest:row.digest,as_of:row.payload.as_of,coverage:row.payload.coverage,
    projects:row.payload.projects.length,tasks:row.payload.tasks.length,
    automations:row.payload.automations.length};
}
function preserved(oldValue,newValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newValue.as_of??'') ||
      newValue.as_of<(oldValue.as_of??'')) return false;
  const titles=value=>[...value.excluded_project_titles].map(s=>s.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').trim()).sort();
  if (!isDeepStrictEqual(titles(oldValue),titles(newValue))) return false;
  for (const key of ['projects','tasks','automations']) {
    const ids=new Set(newValue[key].map(x=>x.id));
    if (oldValue[key].some(x=>!ids.has(x.id))) return false;
  }
  if (Object.keys(oldValue.sources).some(key=>!Object.hasOwn(newValue.sources,key) ||
      !isDeepStrictEqual(oldValue.sources[key],newValue.sources[key]))) return false;
  return true;
}

export function createSnapshotUpdateService(config,{connect=connectPostgres,openReader=createCuratedSnapshotGateway}={}) {
  async function withWriter(fn,{timeoutMs}={}) {
    const bounded=timeoutMs!==undefined;
    if (bounded && (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000))
      throw new DashboardMigrationError('DASHBOARD_READ_TIMEOUT_INVALID');
    const db=connect(config.databaseUrl,bounded?{connectionTimeoutMillis:timeoutMs}:undefined);
    try {
      const checkAndRead=async connection=>{
        const {rows}=await connection.query(`SELECT
          has_table_privilege(current_user,'dashboard.curated_snapshot','SELECT') AS can_read,
          has_table_privilege(current_user,'dashboard.curated_snapshot','UPDATE') AS can_update`);
        if (!rows[0]?.can_read || !rows[0].can_update)
          throw new DashboardMigrationError('DASHBOARD_WRITER_ROLE_INVALID');
        return fn(connection);
      };
      if (bounded) return await db.transaction(async tx=>{
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec(`SET LOCAL statement_timeout = ${timeoutMs}`);
        return checkAndRead(tx);
      },{timeoutMs});
      return await checkAndRead(db);
    } finally {await db.close();}
  }
  return {
    credentialId:config.credentialId,
    readState:options=>withWriter(async db=>{
      const {rows}=await db.query('SELECT payload,digest FROM dashboard.curated_snapshot WHERE singleton=1');
      if (!rows.length) throw new DashboardMigrationError('DASHBOARD_INITIAL_SNAPSHOT_REQUIRED');
      return summary(rows[0]);
    },options),
    async update(input) {
      if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).some(key=>key!=='snapshot'))
        throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
      let serialized;
      try {validateCuratedSnapshot(input.snapshot);serialized=JSON.stringify(input.snapshot);}
      catch {throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');}
      if (Buffer.byteLength(serialized,'utf8')>32_000) throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
      const digest=createHash('sha256').update(serialized).digest('hex');
      const result=await withWriter(db=>db.transaction(async tx=>{
        const {rows}=await tx.query('SELECT payload FROM dashboard.curated_snapshot WHERE singleton=1 FOR UPDATE');
        if (!rows.length) throw new DashboardMigrationError('DASHBOARD_INITIAL_SNAPSHOT_REQUIRED');
        if (isDeepStrictEqual(rows[0].payload,input.snapshot)) return {replayed:true};
        if (!preserved(rows[0].payload,input.snapshot))
          throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
        await tx.query('UPDATE dashboard.curated_snapshot SET payload=$1::jsonb,digest=$2,imported_at=now() WHERE singleton=1',
          [serialized,digest]);
        return {replayed:false};
      }));
      const reader=await openReader(config.databaseUrl,{sharedRole:true});
      try {
        if (!reader || !isDeepStrictEqual(await reader.read(),input.snapshot))
          throw new DashboardMigrationError('DASHBOARD_READBACK_FAILED');
      } finally {await reader?.close();}
      return {...summary({payload:input.snapshot,digest}),replayed:result.replayed,readback_verified:true};
    }
  };
}

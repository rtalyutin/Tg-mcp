import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {connectPostgres} from './postgres.mjs';
import {validateCuratedSnapshot} from './curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from './curated-snapshot-gateway.mjs';
import {DashboardMigrationError} from './migration-service.mjs';
import {migrate} from './migrate.mjs';
import {groupedProject,projectGroupsDigest,resolveProjectGroups,writeProjectGroups} from './project-groups.mjs';

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
  async function withWriter(fn,{ensureSchema=false}={}) {
    const db=connect(config.databaseUrl);
    try {
      if (ensureSchema) await migrate(db);
      const {rows}=await db.query(`SELECT
        has_table_privilege(current_user,'dashboard.curated_snapshot','SELECT') AS can_read,
        has_table_privilege(current_user,'dashboard.curated_snapshot','UPDATE') AS can_update,
        has_table_privilege(current_user,'dashboard.projects_groups','SELECT') AS can_read_groups,
        has_table_privilege(current_user,'dashboard.projects_groups','INSERT') AS can_insert_groups,
        has_table_privilege(current_user,'dashboard.projects_groups','UPDATE') AS can_update_groups,
        has_table_privilege(current_user,'dashboard.projects_groups','DELETE') AS can_delete_groups`);
      if (!rows[0]?.can_read || !rows[0].can_update || !rows[0].can_read_groups ||
          !rows[0].can_insert_groups || !rows[0].can_update_groups || !rows[0].can_delete_groups)
        throw new DashboardMigrationError('DASHBOARD_WRITER_ROLE_INVALID');
      return await fn(db);
    } finally {await db.close();}
  }
  return {
    credentialId:config.credentialId,
    readState:()=>withWriter(async db=>{
      const {rows}=await db.query(`SELECT s.payload,s.digest,
        (SELECT count(*)::int FROM dashboard.projects_groups) AS project_groups
        FROM dashboard.curated_snapshot s WHERE singleton=1`);
      if (!rows.length) throw new DashboardMigrationError('DASHBOARD_INITIAL_SNAPSHOT_REQUIRED');
      return {...summary(rows[0]),project_groups:rows[0].project_groups};
    }),
    async update(input) {
      if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).some(key=>!['snapshot','project_groups'].includes(key)))
        throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
      let serialized;
      try {validateCuratedSnapshot(input.snapshot);serialized=JSON.stringify(input.snapshot);}
      catch {throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');}
      if (Buffer.byteLength(serialized,'utf8')>32_000) throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
      const digest=createHash('sha256').update(serialized).digest('hex');
      const result=await withWriter(db=>db.transaction(async tx=>{
        const {rows}=await tx.query('SELECT payload,digest FROM dashboard.curated_snapshot WHERE singleton=1 FOR UPDATE');
        if (!rows.length) throw new DashboardMigrationError('DASHBOARD_INITIAL_SNAPSHOT_REQUIRED');
        if (!preserved(rows[0].payload,input.snapshot))
          throw new DashboardMigrationError('DASHBOARD_UPDATE_INPUT_INVALID');
        const assignments=await resolveProjectGroups(tx,input.snapshot.projects,input.project_groups);
        const {rows:storedGroups}=await tx.query('SELECT project_id,group_code FROM dashboard.projects_groups');
        storedGroups.sort((a,b)=>a.project_id<b.project_id?-1:a.project_id>b.project_id?1:
          a.group_code<b.group_code?-1:a.group_code>b.group_code?1:0);
        const sameSnapshot=isDeepStrictEqual(rows[0].payload,input.snapshot);
        const sameGroups=isDeepStrictEqual(storedGroups,assignments);
        const replayed=sameSnapshot && sameGroups;
        if (!sameSnapshot) await tx.query('UPDATE dashboard.curated_snapshot SET payload=$1::jsonb,digest=$2,imported_at=now() WHERE singleton=1',
          [serialized,digest]);
        if (!replayed && input.project_groups!==undefined) {
          const replaceProjectIds=[...new Set(input.project_groups.map(item=>item?.project_id).filter(id=>typeof id==='string'))];
          await writeProjectGroups(tx,assignments,replaceProjectIds);
        }
        return {replayed,assignments,digest:sameSnapshot?rows[0].digest:digest};
      }),{ensureSchema:true});
      const reader=await openReader(config.databaseUrl,{sharedRole:true});
      try {
        const expectedGrouped={...input.snapshot,projects:input.snapshot.projects.map(project=>groupedProject(project,result.assignments))};
        if (!reader || !isDeepStrictEqual(await (reader.readSnapshot?.()??reader.read()),input.snapshot) ||
            !isDeepStrictEqual(await reader.read(),expectedGrouped))
          throw new DashboardMigrationError('DASHBOARD_READBACK_FAILED');
      } finally {await reader?.close();}
      return {...summary({payload:input.snapshot,digest:result.digest}),project_groups:result.assignments.length,
        project_groups_digest:projectGroupsDigest(result.assignments),replayed:result.replayed,readback_verified:true};
    }
  };
}

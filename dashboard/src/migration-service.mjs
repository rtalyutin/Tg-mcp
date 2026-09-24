import {isDeepStrictEqual} from 'node:util';
import {connectPostgres} from './postgres.mjs';
import {migrate} from './migrate.mjs';
import {importCuratedSnapshot,validateCuratedSnapshot} from './curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from './curated-snapshot-gateway.mjs';

export class DashboardMigrationError extends Error {
  constructor(code) {super(code);this.name='DashboardMigrationError';}
}

function validDatabaseUrl(value) {
  try {
    const url=new URL(value);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || url.pathname.length<2 || url.hash) return false;
    return true;
  } catch {return false;}
}

export function validateDashboardMigrationConfig(env) {
  if (env.DASHBOARD_MIGRATION_ENABLED===undefined || env.DASHBOARD_MIGRATION_ENABLED==='false') return null;
  if (env.DASHBOARD_MIGRATION_ENABLED!=='true' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID??''))
    throw new Error('DASHBOARD_MIGRATION_CONFIG_INVALID');
  if (!validDatabaseUrl(env.DATABASE_URL))
    throw new Error('DASHBOARD_MIGRATION_CONFIG_INVALID');
  return {credentialId:env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID.toLowerCase(),
    databaseUrl:env.DATABASE_URL};
}

export function createDashboardMigrationService(config,{connect=connectPostgres,
  openReader=createCuratedSnapshotGateway}={}) {
  return {
    credentialId:config.credentialId,
    async apply(input) {
      if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).some(key=>key!=='snapshot'))
        throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');
      let serialized;
      try {validateCuratedSnapshot(input.snapshot);serialized=JSON.stringify(input.snapshot);}
      catch {throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');}
      if (Buffer.byteLength(serialized,'utf8')>32_000) throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');
      const db=connect(config.databaseUrl);
      try {
        const schema=await migrate(db);
        const existing=await db.query('SELECT payload FROM dashboard.curated_snapshot WHERE singleton=1');
        if (existing.rows.length && !isDeepStrictEqual(existing.rows[0].payload,input.snapshot))
          throw new DashboardMigrationError('DASHBOARD_SNAPSHOT_ALREADY_INITIALIZED');
        const receipt=await importCuratedSnapshot(db,input.snapshot);
        const reader=await openReader(config.databaseUrl,{sharedRole:true});
        try {
          if (!reader || !isDeepStrictEqual(await reader.read(),input.snapshot))
            throw new DashboardMigrationError('DASHBOARD_READBACK_FAILED');
        } finally {await reader?.close();}
        return {schema_version:schema.version,applied:schema.applied,digest:receipt.digest,
          projects:receipt.projects,tasks:receipt.tasks,automations:input.snapshot.automations.length,
          verified:true};
      } finally {await db.close();}
    }
  };
}

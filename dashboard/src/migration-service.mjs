import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {connectPostgres} from './postgres.mjs';
import {migrate} from './migrate.mjs';
import {importCuratedSnapshot,validateCuratedSnapshot} from './curated-snapshot.mjs';
import {createCuratedSnapshotGateway} from './curated-snapshot-gateway.mjs';

export class DashboardMigrationError extends Error {
  constructor(code) {super(code);this.name='DashboardMigrationError';}
}

function target(value) {
  try {
    const url=new URL(value);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || url.pathname.length<2 || url.hash) throw new Error();
    return `${url.hostname.toLowerCase()}:${url.port||'5432'}${url.pathname}`;
  } catch {throw new Error('DASHBOARD_MIGRATION_CONFIG_INVALID');}
}

export function validateDashboardMigrationConfig(env) {
  if (env.DASHBOARD_MIGRATION_ENABLED===undefined || env.DASHBOARD_MIGRATION_ENABLED==='false') return null;
  if (env.DASHBOARD_MIGRATION_ENABLED!=='true' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID??'') ||
      !/^[a-f0-9]{64}$/.test(env.DASHBOARD_APPROVED_SNAPSHOT_DIGEST??''))
    throw new Error('DASHBOARD_MIGRATION_CONFIG_INVALID');
  const migrationUrl=env.DASHBOARD_MIGRATION_DATABASE_URL;
  const readerUrl=env.DASHBOARD_SNAPSHOT_READ_DATABASE_URL;
  const writerUrl=env.DASHBOARD_SNAPSHOT_WRITE_DATABASE_URL;
  if (!migrationUrl || !readerUrl || !writerUrl ||
      target(migrationUrl)!==target(readerUrl) || target(migrationUrl)!==target(writerUrl) ||
      migrationUrl===readerUrl || migrationUrl===writerUrl || writerUrl===readerUrl ||
      (env.DATABASE_URL && target(migrationUrl)===target(env.DATABASE_URL)) ||
      new URL(readerUrl).username!=='dashboard_snapshot_reader' ||
      new URL(writerUrl).username!=='dashboard_snapshot_writer')
    throw new Error('DASHBOARD_MIGRATION_CONFIG_INVALID');
  return {credentialId:env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID.toLowerCase(),
    approvedDigest:env.DASHBOARD_APPROVED_SNAPSHOT_DIGEST,migrationUrl,readerUrl,writerUrl};
}

export function createDashboardMigrationService(config,{connect=connectPostgres,
  openReader=createCuratedSnapshotGateway}={}) {
  return {
    credentialId:config.credentialId,
    async apply(input) {
      if (!input || typeof input!=='object' || Array.isArray(input) ||
          Object.keys(input).some(key=>!['snapshot','expected_digest'].includes(key)) ||
          typeof input.expected_digest!=='string' || !/^[a-f0-9]{64}$/.test(input.expected_digest))
        throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');
      let serialized;
      try {validateCuratedSnapshot(input.snapshot);serialized=JSON.stringify(input.snapshot);}
      catch {throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');}
      if (Buffer.byteLength(serialized,'utf8')>32_000) throw new DashboardMigrationError('DASHBOARD_MIGRATION_INPUT_INVALID');
      const digest=createHash('sha256').update(serialized).digest('hex');
      if (!timingSafeEqual(Buffer.from(digest),Buffer.from(config.approvedDigest)) ||
          !timingSafeEqual(Buffer.from(digest),Buffer.from(input.expected_digest)))
        throw new DashboardMigrationError('DASHBOARD_SNAPSHOT_NOT_APPROVED');
      const db=connect(config.migrationUrl);
      try {
        const role=await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('dashboard_snapshot_reader','dashboard_snapshot_writer')");
        if (role.rows.length!==2) throw new DashboardMigrationError('DASHBOARD_DATABASE_ROLES_REQUIRED');
        const schema=await migrate(db);
        for (const file of ['grant-snapshot-reader.sql','grant-snapshot-writer.sql']) {
          const grants=await readFile(new URL(`../sql/${file}`,import.meta.url),'utf8');
          // The standalone SQL has its own BEGIN/COMMIT; the adapter owns those here.
          const statements=grants.replace(/^BEGIN;\s*/m,'').replace(/\s*COMMIT;\s*$/,'');
          await db.transaction(tx=>tx.exec(statements));
        }
        const existing=await db.query('SELECT digest FROM dashboard.curated_snapshot WHERE singleton=1');
        if (existing.rows.length && existing.rows[0].digest!==digest)
          throw new DashboardMigrationError('DASHBOARD_SNAPSHOT_ALREADY_INITIALIZED');
        const receipt=await importCuratedSnapshot(db,input.snapshot);
        const reader=await openReader(config.readerUrl);
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

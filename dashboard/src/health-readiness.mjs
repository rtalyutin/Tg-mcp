import {verifySchema} from './migrate.mjs';
import {validateCuratedSnapshot} from './curated-snapshot.mjs';

const HEALTH_READ_TIMEOUT_MS=2000;
const PRIMARY_DATABASE_BUDGET_MS=7000;
const COMPONENTS=Object.freeze([
  'database','dashboard_schema','snapshot_reader','snapshot_writer','dashboard_assets','dashboard_mcp'
]);

/**
 * Build a bounded, read-only readiness probe for the Outreach gateway.
 * Errors and result data are deliberately reduced to fixed component states.
 */
export function createDashboardReadiness({
  pool,
  dashboardSnapshot,
  dashboardWriter,
  snapshotWriterConfigured=Boolean(dashboardWriter),
  dashboardEnabled=false,
  dashboardMcp,
  checkAssets,
  schemaCheck=verifySchema,
}={}) {
  let active;
  const writerEnabled=snapshotWriterConfigured || Boolean(dashboardWriter);

  async function inspectPrimaryDatabase() {
    let database='unknown';
    let schema='unknown';
    let client;
    let released=false;
    let inTransaction=false;
    let rejectDeadline;
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
    const deadlineTimer=setTimeout(()=>{
      const error=new Error('HEALTH_DATABASE_TIMEOUT');
      if (client && !released) { released=true; client.release(error); }
      rejectDeadline(error);
    },PRIMARY_DATABASE_BUDGET_MS);
    const bounded=promise=>Promise.race([promise,deadline]);

    try {
      const pending=pool?.connect?.();
      if (!pending) throw new Error('HEALTH_DATABASE_UNAVAILABLE');
      try { client=await bounded(pending); }
      catch (error) {
        pending.then(late=>late.release(error instanceof Error ? error : new Error('HEALTH_DATABASE_TIMEOUT')),()=>{});
        throw error;
      }
      await bounded(client.query('BEGIN READ ONLY'));
      inTransaction=true;
      await bounded(client.query('SET LOCAL statement_timeout = 2000'));
      await bounded(client.query('SELECT 1'));
      database='ok';
      const readOnlyDb={query:(sql,params)=>bounded(client.query(sql,params))};
      try { await bounded(schemaCheck(readOnlyDb)); schema='ok'; }
      catch { schema='failed'; }
    } catch {
      if (database==='unknown') database='failed';
      if (database==='failed') schema='unknown';
      else if (schema==='unknown') schema='failed';
    } finally {
      clearTimeout(deadlineTimer);
      if (client && !released) {
        if (inTransaction) {
          let rollbackTimer;
          try {
            await Promise.race([
              client.query('ROLLBACK'),
              new Promise((_,reject)=>{rollbackTimer=setTimeout(()=>reject(new Error('HEALTH_ROLLBACK_TIMEOUT')),500);}),
            ]);
          } catch (error) {
            released=true;
            client.release(error instanceof Error ? error : new Error('HEALTH_ROLLBACK_FAILED'));
          } finally { clearTimeout(rollbackTimer); }
        }
        if (!released) client.release();
      }
    }
    return {database,dashboard_schema:schema};
  }

  async function checkSnapshotReader() {
    if (typeof dashboardSnapshot?.read!=='function') throw new Error('SNAPSHOT_READER_UNAVAILABLE');
    const snapshot=await dashboardSnapshot.read({timeoutMs:HEALTH_READ_TIMEOUT_MS});
    validateCuratedSnapshot(snapshot);
  }

  async function checkSnapshotWriter() {
    if (typeof dashboardWriter?.readState!=='function') throw new Error('SNAPSHOT_WRITER_UNAVAILABLE');
    await dashboardWriter.readState({timeoutMs:HEALTH_READ_TIMEOUT_MS});
  }

  async function checkDashboardMcp() {
    if (typeof dashboardMcp?.healthCheck!=='function') throw new Error('DASHBOARD_MCP_UNAVAILABLE');
    await dashboardMcp.healthCheck({timeoutMs:HEALTH_READ_TIMEOUT_MS});
  }

  async function run() {
    const checks={
      database:'unknown', dashboard_schema:'unknown', snapshot_reader:'unknown',
      snapshot_writer:writerEnabled ? 'unknown' : 'not_configured',
      dashboard_assets:'unknown', dashboard_mcp:dashboardEnabled ? 'unknown' : 'not_configured',
    };
    const tasks=[
      inspectPrimaryDatabase().then(result=>Object.assign(checks,result)),
      checkSnapshotReader().then(()=>{checks.snapshot_reader='ok';},()=>{checks.snapshot_reader='failed';}),
      (async()=>{
        if (!writerEnabled) return;
        try { await checkSnapshotWriter(); checks.snapshot_writer='ok'; }
        catch { checks.snapshot_writer='failed'; }
      })(),
      (async()=>{
        try {
          if (typeof checkAssets!=='function') throw new Error('DASHBOARD_ASSETS_UNAVAILABLE');
          await checkAssets(); checks.dashboard_assets='ok';
        } catch { checks.dashboard_assets='failed'; }
      })(),
      (async()=>{
        if (!dashboardEnabled) return;
        try { await checkDashboardMcp(); checks.dashboard_mcp='ok'; }
        catch { checks.dashboard_mcp='failed'; }
      })(),
    ];
    await Promise.allSettled(tasks);
    const required=['database','dashboard_schema','snapshot_reader','dashboard_assets'];
    if (writerEnabled) required.push('snapshot_writer');
    if (dashboardEnabled) required.push('dashboard_mcp');
    const healthy=required.every(name=>checks[name]==='ok');
    // Keep this response small and restricted to an allowlist of fixed states.
    const safeChecks=Object.fromEntries(COMPONENTS.map(name=>[
      name,['ok','failed','unknown','not_configured'].includes(checks[name])?checks[name]:'unknown'
    ]));
    return {status:healthy?'ok':'unhealthy',checks:safeChecks};
  }

  return function checkReadiness() {
    if (!active) active=run().finally(()=>{active=undefined;});
    return active;
  };
}

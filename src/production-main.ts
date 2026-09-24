import { readProductionConfig } from './production-config.ts';
import { startProductionPublisher } from './oauth-server.ts';
import { installShutdownHandlers } from './lifecycle.ts';
import { startSecretPublisher, startPublicPublisher } from './secret-server.ts';
import { ConfigError } from './config-error.ts';
import { readOutreachConfig } from './outreach/config.ts';
import { createOutreachPool, migrateOutreach } from './outreach/database.ts';
import { startOutreachGateway, type DashboardRoute, type DashboardSnapshotRoute, type DashboardMigrationRoute, type DashboardSnapshotWriterRoute } from './outreach/server.ts';
import type { Pool } from 'pg';

let outreachPool: Pool | undefined;
let dashboardRoute: DashboardRoute | undefined;
let dashboardSnapshot: DashboardSnapshotRoute | undefined;
let dashboardMigration: DashboardMigrationRoute | undefined;
let dashboardWriter: DashboardSnapshotWriterRoute | undefined;
// Driver messages may contain credentials or the full connection URL. Log only
// a fixed startup stage and a bounded PostgreSQL/transport error code.
function safeStartupCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code !== 'string') return '';
  if (/^[A-Z0-9]{5}$/.test(code) || ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) {
    return ` code=${code}`;
  }
  return '';
}
try {
  if (process.env.OUTREACH_ENABLED !== undefined && !['true', 'false'].includes(process.env.OUTREACH_ENABLED)) throw new ConfigError('Invalid OUTREACH_ENABLED');
  if (process.env.OUTREACH_ENABLED === 'true') {
    const config = readOutreachConfig(process.env);
    if (process.env.TELEGRAM_ENABLED !== undefined && !['true', 'false'].includes(process.env.TELEGRAM_ENABLED)) throw new ConfigError('Invalid TELEGRAM_ENABLED');
    const telegram = process.env.TELEGRAM_ENABLED === 'true'
      ? readProductionConfig({ ...process.env, MCP_AUTH_MODE: 'public' }) : undefined;
    if (process.argv.includes('--check-config')) console.log('OUTREACH_CONFIG_VALID');
    else {
      outreachPool = createOutreachPool(config.databaseUrl);
      try { await outreachPool.query('SELECT 1'); }
      catch (error) { console.error(`OUTREACH_DB_CONNECT_FAILED${safeStartupCode(error)}`); throw error; }
      try { await migrateOutreach(outreachPool); }
      catch (error) { console.error(`OUTREACH_DB_MIGRATION_FAILED${safeStartupCode(error)}`); throw error; }
      // Dashboard has its own fail-closed route and migration ledger. A broken
      // optional module must not switch or stop the existing Telegram gateway.
      if (process.env.DASHBOARD_ENABLED !== undefined && process.env.DASHBOARD_ENABLED !== 'false') {
        try {
          const { validateDashboardConfig, createDashboardGateway } = await import(new URL('../dashboard/src/http-gateway.mjs', import.meta.url).href);
          const dashboardConfig = validateDashboardConfig(process.env);
          if (dashboardConfig) dashboardRoute = await createDashboardGateway(dashboardConfig);
        } catch { console.error('DASHBOARD_DISABLED: configuration, migration or database unavailable'); }
      }
      if (process.env.DASHBOARD_SNAPSHOT_READ_DATABASE_URL) {
        try {
          const { createCuratedSnapshotGateway } = await import(new URL('../dashboard/src/curated-snapshot-gateway.mjs', import.meta.url).href);
          dashboardSnapshot = await createCuratedSnapshotGateway(process.env.DASHBOARD_SNAPSHOT_READ_DATABASE_URL) ?? undefined;
        } catch { console.error('DASHBOARD_SNAPSHOT_DISABLED: read role or database unavailable'); }
      }
      try {
        const {validateDashboardMigrationConfig,createDashboardMigrationService}=await import(new URL('../dashboard/src/migration-service.mjs',import.meta.url).href);
        const migrationConfig=validateDashboardMigrationConfig(process.env);
        if (migrationConfig) dashboardMigration=createDashboardMigrationService(migrationConfig);
      } catch { console.error('DASHBOARD_MIGRATION_DISABLED: configuration unavailable'); }
      try {
        const {validateSnapshotUpdateConfig,createSnapshotUpdateService}=await import(new URL('../dashboard/src/snapshot-update-service.mjs',import.meta.url).href);
        const updateConfig=validateSnapshotUpdateConfig(process.env);
        if (updateConfig) dashboardWriter=createSnapshotUpdateService(updateConfig);
      } catch { console.error('DASHBOARD_SNAPSHOT_WRITE_DISABLED: configuration unavailable'); }
      let app;
      try { app = await startOutreachGateway({ config, pool: outreachPool, telegram, dashboard: dashboardRoute, dashboardSnapshot, dashboardMigration, dashboardWriter }); }
      catch (error) { console.error(`OUTREACH_GATEWAY_START_FAILED${safeStartupCode(error)}`); throw error; }
      installShutdownHandlers(async () => { await app.close(); await dashboardRoute?.close(); await dashboardSnapshot?.close(); await outreachPool?.end(); });
      console.log(`OUTREACH_STARTED auth=query_login mail_enabled=${Boolean(config.mail)}`);
    }
  } else {
  const config = readProductionConfig(process.env);
  if (process.argv.includes('--check-config')) {
    console.log('CONFIG_VALID');
  } else {
    const app = config.authMode === 'public' ? await startPublicPublisher(config) : config.authMode === 'secret_path' ? await startSecretPublisher(config) : await startProductionPublisher(config);
    installShutdownHandlers(app.close);
    console.log(`PUBLISHER_STARTED profile=${config.profile} publish_enabled=${config.publishEnabled} auth=${config.authMode}`);
  }
  }
} catch (error) {
  await dashboardRoute?.close().catch(() => {});
  await dashboardSnapshot?.close().catch(() => {});
  await outreachPool?.end().catch(() => {});
  // Do not emit URLs, JWTs, Bot API tokens, config values or dependency errors.
  console.error(error instanceof ConfigError ? `CONFIG_INVALID: ${error.message}` : 'STARTUP_FAILED: check port and runtime configuration; see TIMEWEB-NATIVE.md');
  process.exitCode = 1;
}

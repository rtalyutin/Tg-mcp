import { readProductionConfig } from './production-config.ts';
import { startProductionPublisher } from './oauth-server.ts';
import { installShutdownHandlers } from './lifecycle.ts';
import { startSecretPublisher, startPublicPublisher } from './secret-server.ts';
import { ConfigError } from './config-error.ts';
import { readOutreachConfig } from './outreach/config.ts';
import { createOutreachPool, migrateOutreach } from './outreach/database.ts';
import { startOutreachGateway, type DashboardRoute, type DashboardSnapshotRoute, type DashboardMigrationRoute, type DashboardSnapshotWriterRoute } from './outreach/server.ts';
import type { Pool } from 'pg';
import { DatabaseTools } from './outreach/database-tools.ts';
import type { WorkspaceRoute } from './outreach/server.ts';
import { fileURLToPath } from 'node:url';
import { createOwnsiteGateway, type OwnsiteGateway } from './ownsite/gateway.ts';
import { readTelegramCollectorConfig } from './telegram-collector/config.ts';
import { startTelegramCollector } from './telegram-collector/runtime.ts';
import { TelegramCollectorError } from './telegram-collector/api.ts';
import type { TelegramCollectorGateway } from './telegram-collector/gateway.ts';
import { safeStartupCode } from './startup-diagnostics.ts';
import { startStartupHttpListener, type StartupHttpListener } from './startup-http.ts';

let startupListener: StartupHttpListener | undefined;
let outreachPool: Pool | undefined;
let dashboardRoute: DashboardRoute | undefined;
let dashboardSnapshot: DashboardSnapshotRoute | undefined;
let dashboardMigration: DashboardMigrationRoute | undefined;
let dashboardWriter: DashboardSnapshotWriterRoute | undefined;
let workspace: WorkspaceRoute | undefined;
let ownsite: OwnsiteGateway | undefined;
let telegramCollector: TelegramCollectorGateway | undefined;
try {
  let collectorConfig: ReturnType<typeof readTelegramCollectorConfig> = null;
  try { collectorConfig = readTelegramCollectorConfig(process.env); }
  catch (error) {
    if (process.argv.includes('--check-config')) throw error;
    console.error('TELEGRAM_COLLECTOR_DISABLED code=TGC_CONFIG_INVALID');
  }
  if (process.env.OWNSITE_ENABLED !== undefined && !['true', 'false'].includes(process.env.OWNSITE_ENABLED)) throw new ConfigError('Invalid OWNSITE_ENABLED');
  if (process.env.OWNSITE_ENABLED === 'true' && process.env.OUTREACH_ENABLED !== 'true') throw new ConfigError('Ownsite requires the database-backed outreach gateway');
  if (process.env.OUTREACH_ENABLED !== undefined && !['true', 'false'].includes(process.env.OUTREACH_ENABLED)) throw new ConfigError('Invalid OUTREACH_ENABLED');
  if (process.env.OUTREACH_ENABLED === 'true') {
    const config = readOutreachConfig(process.env);
    const ownsiteCredential = process.env.OWNSITE_MCP_CREDENTIAL_ID ?? process.env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID;
    if (process.env.OWNSITE_ENABLED === 'true' && !ownsiteCredential?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) throw new ConfigError('Ownsite requires an existing MCP credential ID');
    if (process.env.TELEGRAM_ENABLED !== undefined && !['true', 'false'].includes(process.env.TELEGRAM_ENABLED)) throw new ConfigError('Invalid TELEGRAM_ENABLED');
    const telegram = process.env.TELEGRAM_ENABLED === 'true'
      ? readProductionConfig({ ...process.env, MCP_AUTH_MODE: 'public' }) : undefined;
    if (process.argv.includes('--check-config')) console.log('OUTREACH_CONFIG_VALID');
    else {
      try { startupListener = await startStartupHttpListener(config.port); }
      catch (error) { console.error(`OUTREACH_HTTP_START_FAILED${safeStartupCode(error)}`); throw error; }
      console.log(`OUTREACH_HTTP_LISTENING port=${config.port}`);
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
      if (process.env.DATABASE_URL) {
        try {
          const { createCuratedSnapshotGateway } = await import(new URL('../dashboard/src/curated-snapshot-gateway.mjs', import.meta.url).href);
          dashboardSnapshot = await createCuratedSnapshotGateway(process.env.DATABASE_URL,{sharedRole:true}) ?? undefined;
        } catch { console.error('DASHBOARD_SNAPSHOT_DISABLED: schema or table unavailable'); }
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
      const databaseCredentialId = dashboardWriter?.credentialId ?? dashboardMigration?.credentialId;
      const databaseTools = databaseCredentialId ? new DatabaseTools(outreachPool, databaseCredentialId) : undefined;
      if (process.env.OWNSITE_ENABLED === 'true') {
        try {
          ownsite = await createOwnsiteGateway(outreachPool, ownsiteCredential!, {
            phone: process.env.PUBLIC_PHONE, email: process.env.PUBLIC_EMAIL,
          });
          console.log('OWNSITE_STARTED');
        } catch (error) { console.error(`OWNSITE_DISABLED: schema or database unavailable${safeStartupCode(error)}`); }
      }
      // Same owner, database and query-login MCP; an optional module failure
      // leaves existing Telegram/dashboard routes running. Migrations are additive.
      if (process.env.WORKSPACE_ENABLED !== 'false') {
        try {
          if (process.env.WORKSPACE_ENABLED !== undefined && process.env.WORKSPACE_ENABLED !== 'true') throw new Error('Invalid workspace flag');
          const owners = (await outreachPool.query('SELECT id FROM public.outreach_owners LIMIT 2')).rows;
          if (owners.length !== 1) throw new Error('Workspace needs the existing singleton owner');
          const { createWorkspaceGateway } = await import(new URL('../workspace/dist/src/host-gateway.js', import.meta.url).href);
          workspace = await createWorkspaceGateway({databaseUrl:config.databaseUrl,ownerId:owners[0].id,
            migrationsDirectory:fileURLToPath(new URL('../workspace/migrations/',import.meta.url))});
          console.log(`WORKSPACE_STARTED version=${workspace?.status().version}`);
        } catch (error) { console.error(`WORKSPACE_DISABLED: build, owner, migration or database unavailable${safeStartupCode(error)}`); }
      }
      let app;
      if (collectorConfig) {
        try {
          telegramCollector = await startTelegramCollector(outreachPool, collectorConfig);
          console.log('TELEGRAM_COLLECTOR_STARTED');
        } catch (error) {
          console.error(`TELEGRAM_COLLECTOR_DISABLED code=${error instanceof TelegramCollectorError ? error.code : 'TGC_STORAGE_UNAVAILABLE'}`);
        }
      }
      try { app = await startOutreachGateway({ config, pool: outreachPool, startupListener, telegram, dashboard: dashboardRoute, dashboardSnapshot, dashboardMigration, dashboardWriter, databaseTools, workspace, ownsite, telegramCollector }); }
      catch (error) { console.error(`OUTREACH_GATEWAY_START_FAILED${safeStartupCode(error)}`); throw error; }
      installShutdownHandlers(async () => { await app.close(); await telegramCollector?.close(); await workspace?.close(); await dashboardRoute?.close(); await dashboardSnapshot?.close(); await outreachPool?.end(); });
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
  await startupListener?.close().catch(() => {});
  await telegramCollector?.close().catch(() => {});
  await workspace?.close().catch(() => {});
  await dashboardRoute?.close().catch(() => {});
  await dashboardSnapshot?.close().catch(() => {});
  await outreachPool?.end().catch(() => {});
  // Do not emit URLs, JWTs, Bot API tokens, config values or dependency errors.
  console.error(error instanceof ConfigError ? `CONFIG_INVALID: ${error.message}` : 'STARTUP_FAILED: check port and runtime configuration; see TIMEWEB-NATIVE.md');
  process.exitCode = 1;
}

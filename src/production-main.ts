import { readProductionConfig } from './production-config.ts';
import { startProductionPublisher } from './oauth-server.ts';
import { installShutdownHandlers } from './lifecycle.ts';
import { startSecretPublisher, startPublicPublisher } from './secret-server.ts';
import { ConfigError } from './config-error.ts';
import { readOutreachConfig } from './outreach/config.ts';
import { createOutreachPool, migrateOutreach } from './outreach/database.ts';
import { startOutreachGateway } from './outreach/server.ts';
import type { Pool } from 'pg';

let outreachPool: Pool | undefined;
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
      let app;
      try { app = await startOutreachGateway({ config, pool: outreachPool, telegram }); }
      catch (error) { console.error(`OUTREACH_GATEWAY_START_FAILED${safeStartupCode(error)}`); throw error; }
      installShutdownHandlers(async () => { await app.close(); await outreachPool?.end(); });
      console.log('OUTREACH_STARTED auth=query_login mail_enabled=false');
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
  await outreachPool?.end().catch(() => {});
  // Do not emit URLs, JWTs, Bot API tokens, config values or dependency errors.
  console.error(error instanceof ConfigError ? `CONFIG_INVALID: ${error.message}` : 'STARTUP_FAILED: check port and runtime configuration; see TIMEWEB-NATIVE.md');
  process.exitCode = 1;
}

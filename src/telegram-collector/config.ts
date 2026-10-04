import { ConfigError } from '../config-error.ts';

export interface TelegramCollectorConfig {
  botToken: string;
  ownerTelegramId: string;
  credentialId: string;
  expectedUsername: string;
}

/** Disabled by default. Values are never included in diagnostics. */
export function readTelegramCollectorConfig(env: NodeJS.ProcessEnv): TelegramCollectorConfig | null {
  if (env.TELEGRAM_COLLECTOR_ENABLED === undefined || env.TELEGRAM_COLLECTOR_ENABLED === 'false') return null;
  if (env.TELEGRAM_COLLECTOR_ENABLED !== 'true') throw new ConfigError('Invalid TELEGRAM_COLLECTOR_ENABLED');
  if (env.OUTREACH_ENABLED !== 'true') throw new ConfigError('Telegram collector requires the database-backed gateway');
  const botToken = env.TELEGRAM_COLLECTOR_BOT_TOKEN;
  if (!botToken || !/^\d+:[A-Za-z0-9_-]{20,200}$/.test(botToken)) throw new ConfigError('Invalid TELEGRAM_COLLECTOR_BOT_TOKEN');
  const ownerTelegramId = env.TELEGRAM_COLLECTOR_OWNER_ID;
  if (!ownerTelegramId || !/^[1-9]\d{0,15}$/.test(ownerTelegramId) || !Number.isSafeInteger(Number(ownerTelegramId)))
    throw new ConfigError('Invalid TELEGRAM_COLLECTOR_OWNER_ID');
  const credentialId = env.TELEGRAM_COLLECTOR_MCP_CREDENTIAL_ID ?? env.DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID;
  if (!credentialId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentialId))
    throw new ConfigError('Telegram collector requires an existing owner MCP credential');
  // The selected existing bot; no additional value to manage on first launch.
  return { botToken, ownerTelegramId, credentialId: credentialId.toLowerCase(), expectedUsername: 'RevitOpenClawBot' };
}

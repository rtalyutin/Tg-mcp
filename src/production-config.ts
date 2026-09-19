import type { OAuthServerOptions } from './oauth-server.ts';
import { validateOAuthConfig } from './oauth.ts';
import type { SecretServerOptions } from './secret-server.ts';
import { validateSecretPathConfig } from './secret-auth.ts';
import { ConfigError } from './config-error.ts';

export type ProductionConfig = ({ authMode: 'oauth' } & OAuthServerOptions) | ({ authMode: 'secret_path' } & SecretServerOptions);

/** Validate without binding/listening, fetching keys, contacting Telegram or printing secrets. */
export function readProductionConfig(env: NodeJS.ProcessEnv): ProductionConfig {
  for (const key of ['LOCAL_PROBE_TOKEN', 'TELEGRAM_API_ROOT', 'MOCK_TELEGRAM_ROOT', 'OAUTH_ALLOW_INSECURE']) {
    if (env[key] !== undefined) throw new ConfigError(`Remove local test setting: ${key}`);
  }
  if (env.HOST !== undefined && env.HOST !== '0.0.0.0') throw new ConfigError('HOST must be 0.0.0.0');
  const profile = env.MCP_PROFILE ?? 'readonly';
  if (profile !== 'readonly' && profile !== 'publisher') throw new ConfigError('Invalid MCP_PROFILE');
  if (env.PUBLISH_ENABLED !== undefined && !['true', 'false'].includes(env.PUBLISH_ENABLED)) throw new ConfigError('Invalid PUBLISH_ENABLED');
  const publishEnabled = env.PUBLISH_ENABLED === 'true';
  if (profile === 'readonly' && publishEnabled) throw new ConfigError('Read-only cannot publish');
  const required = (key: string) => { if (!env[key]) throw new ConfigError(`Missing setting: ${key}`); return env[key]!; };
  const authMode = env.MCP_AUTH_MODE ?? 'oauth';
  if (authMode !== 'oauth' && authMode !== 'secret_path') throw new ConfigError('Invalid MCP_AUTH_MODE (oauth or secret_path)');
  const portText = env.PORT ?? '8080';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new ConfigError('Invalid PORT');
  let botToken: string | undefined; let channelId: string | undefined;
  if (profile === 'publisher') {
    botToken = required('TELEGRAM_BOT_TOKEN'); channelId = required('TELEGRAM_CHANNEL_ID');
    if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(botToken) || botToken.length > 256) throw new ConfigError('Invalid TELEGRAM_BOT_TOKEN');
    if (!/^-[1-9]\d*$/.test(channelId)) throw new ConfigError('Invalid TELEGRAM_CHANNEL_ID');
  }
  const common = { profile, publishEnabled, botToken, channelId, port: Number(portText) } as const;
  if (authMode === 'secret_path') {
    const secret = validateSecretPathConfig({ publicOrigin: required('MCP_PUBLIC_ORIGIN'), pathSecret: required('MCP_PATH_SECRET') });
    return { ...common, authMode, secret };
  }
  if (env.MCP_PATH_SECRET !== undefined || env.MCP_PUBLIC_ORIGIN !== undefined) throw new ConfigError('Set MCP_AUTH_MODE=secret_path to use secret path settings');
  const oauthInput = { resource: required('MCP_RESOURCE_URL'), issuer: required('OAUTH_ISSUER'), jwksUri: required('OAUTH_JWKS_URI'), allowedSubject: required('OAUTH_ALLOWED_SUBJECT') };
  try { return { ...common, authMode, oauth: validateOAuthConfig(oauthInput) }; }
  catch { throw new ConfigError('Invalid OAuth configuration: check MCP_RESOURCE_URL, OAUTH_ISSUER, OAUTH_JWKS_URI and OAUTH_ALLOWED_SUBJECT'); }
}

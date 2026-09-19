import type { OAuthServerOptions } from './oauth-server.ts';
import { validateOAuthConfig } from './oauth.ts';

/** Validate without binding/listening, fetching keys, contacting Telegram or printing secrets. */
export function readProductionConfig(env: NodeJS.ProcessEnv): OAuthServerOptions {
  for (const key of ['LOCAL_PROBE_TOKEN', 'TELEGRAM_API_ROOT', 'MOCK_TELEGRAM_ROOT', 'OAUTH_ALLOW_INSECURE']) {
    if (env[key] !== undefined) throw new Error(`Remove local test setting: ${key}`);
  }
  if (env.HOST !== undefined && env.HOST !== '0.0.0.0') throw new Error('HOST must be 0.0.0.0');
  const profile = env.MCP_PROFILE ?? 'readonly';
  if (profile !== 'readonly' && profile !== 'publisher') throw new Error('Invalid MCP_PROFILE');
  if (env.PUBLISH_ENABLED !== undefined && !['true', 'false'].includes(env.PUBLISH_ENABLED)) throw new Error('Invalid PUBLISH_ENABLED');
  const publishEnabled = env.PUBLISH_ENABLED === 'true';
  if (profile === 'readonly' && publishEnabled) throw new Error('Read-only cannot publish');
  const required = (key: string) => { if (!env[key]) throw new Error(`Missing setting: ${key}`); return env[key]!; };
  const oauth = validateOAuthConfig({ resource: required('MCP_RESOURCE_URL'), issuer: required('OAUTH_ISSUER'), jwksUri: required('OAUTH_JWKS_URI'), allowedSubject: required('OAUTH_ALLOWED_SUBJECT') });
  const portText = env.PORT ?? '8080';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Invalid PORT');
  let botToken: string | undefined; let channelId: string | undefined;
  if (profile === 'publisher') {
    botToken = required('TELEGRAM_BOT_TOKEN'); channelId = required('TELEGRAM_CHANNEL_ID');
    if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(botToken) || botToken.length > 256) throw new Error('Invalid TELEGRAM_BOT_TOKEN');
    if (!/^-[1-9]\d*$/.test(channelId)) throw new Error('Invalid TELEGRAM_CHANNEL_ID');
  }
  return { oauth, profile, publishEnabled, botToken, channelId, port: Number(portText) };
}

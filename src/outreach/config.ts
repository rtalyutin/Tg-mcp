import ipaddr from 'ipaddr.js';
import { ConfigError } from '../config-error.ts';
import { validatePublicOrigin } from '../secret-auth.ts';

export interface OutreachConfig {
  publicOrigin: string;
  port: number;
  databaseUrl: string;
  trustedProxyCidrs: string[];
}

/** Validation has no side effects and never includes configuration values in errors. */
export function readOutreachConfig(env: NodeJS.ProcessEnv): OutreachConfig {
  if (!env.MCP_PUBLIC_ORIGIN) throw new ConfigError('Missing MCP_PUBLIC_ORIGIN');
  const publicOrigin = validatePublicOrigin(env.MCP_PUBLIC_ORIGIN);
  const portText = env.PORT ?? '8080';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new ConfigError('Invalid PORT');
  }
  if (!env.DATABASE_URL) throw new ConfigError('Missing DATABASE_URL');
  try {
    const database = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || database.hash) {
      throw new Error();
    }
  } catch { throw new ConfigError('Invalid DATABASE_URL'); }
  // Native pg TLS settings are preserved; credentials and TLS are never rewritten.
  const trustedProxyCidrs = env.MCP_TRUSTED_PROXY_CIDRS === undefined || env.MCP_TRUSTED_PROXY_CIDRS === ''
    ? [] : env.MCP_TRUSTED_PROXY_CIDRS.split(',').map(value => value.trim());
  if (trustedProxyCidrs.length > 32 || trustedProxyCidrs.some(value => !value || !ipaddr.isValidCIDR(value))) {
    throw new ConfigError('Invalid MCP_TRUSTED_PROXY_CIDRS');
  }
  if (env.MAIL_TRANSPORT_ENABLED !== undefined && env.MAIL_TRANSPORT_ENABLED !== 'false') {
    throw new ConfigError('MAIL_TRANSPORT_ENABLED must be false: mail transport is not implemented');
  }
  return { publicOrigin, port: Number(portText), databaseUrl: env.DATABASE_URL, trustedProxyCidrs };
}

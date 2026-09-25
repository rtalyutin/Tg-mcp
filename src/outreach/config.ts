import ipaddr from 'ipaddr.js';
import { ConfigError } from '../config-error.ts';
import { validatePublicOrigin } from '../secret-auth.ts';

export interface OutreachConfig {
  publicOrigin: string;
  port: number;
  databaseUrl: string;
  trustedProxyCidrs: string[];
  mail: MailConfig | null;
}

interface MailAddresses {
  username: 'info@ycs.bar';
  recipient: 'r.talyutin@gmail.com';
  port: 587 | 465;
}

export interface TestMailConfig extends MailAddresses {
  transport: 'smtp';
  host: 'smtp.timeweb.ru';
  password: string;
}

export interface RelayMailConfig extends MailAddresses {
  transport: 'relay';
  origin: string;
  token: string;
  port: 465;
}
export type MailConfig = TestMailConfig | RelayMailConfig;

const TEST_MAIL_HOST = 'smtp.timeweb.ru';
const TEST_MAIL_ADDRESS = 'info@ycs.bar';
const TEST_MAIL_RECIPIENT = 'r.talyutin@gmail.com';

export function readTestMailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  if (env.MAIL_TRANSPORT_ENABLED === undefined || env.MAIL_TRANSPORT_ENABLED === 'false') return null;
  if (env.MAIL_TRANSPORT_ENABLED !== 'true') throw new ConfigError('Invalid MAIL_TRANSPORT_ENABLED');
  if ((env.MAIL_SMTP_HOST !== undefined && env.MAIL_SMTP_HOST !== TEST_MAIL_HOST) ||
      (env.MAIL_FROM !== undefined && env.MAIL_FROM !== TEST_MAIL_ADDRESS) ||
      (env.MAIL_TEST_RECIPIENTS !== undefined && env.MAIL_TEST_RECIPIENTS !== TEST_MAIL_RECIPIENT)) {
    throw new ConfigError('Incomplete or invalid test mail configuration');
  }
  if (env.MAIL_RELAY_ORIGIN !== undefined || env.MAIL_RELAY_TOKEN !== undefined) {
    if (!env.MAIL_RELAY_ORIGIN || !/^[a-f0-9]{64}$/.test(env.MAIL_RELAY_TOKEN ?? '') ||
        (env.MAIL_SMTP_PORT !== undefined && env.MAIL_SMTP_PORT !== '465')) {
      throw new ConfigError('Incomplete or invalid mail relay configuration');
    }
    let origin:string;
    try { origin=validatePublicOrigin(env.MAIL_RELAY_ORIGIN); }
    catch { throw new ConfigError('MAIL_RELAY_ORIGIN must be a public HTTPS origin'); }
    return {transport:'relay',origin,token:env.MAIL_RELAY_TOKEN!,port:465,
      username:TEST_MAIL_ADDRESS,recipient:TEST_MAIL_RECIPIENT};
  }
  const port = env.MAIL_SMTP_PORT ?? '587';
  if (port !== '587' && port !== '465') throw new ConfigError('MAIL_SMTP_PORT must be 587 or 465');
  if (!env.MAIL_SMTP_PASSWORD) throw new ConfigError('Incomplete or invalid test mail configuration');
  return { transport:'smtp',host:TEST_MAIL_HOST, port:Number(port) as 587|465,
    username:TEST_MAIL_ADDRESS,password:env.MAIL_SMTP_PASSWORD, recipient:TEST_MAIL_RECIPIENT };
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
  const mail = readTestMailConfig(env);
  return { publicOrigin, port: Number(portText), databaseUrl: env.DATABASE_URL, trustedProxyCidrs, mail };
}

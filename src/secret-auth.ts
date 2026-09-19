import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ConfigError } from './config-error.ts';

export interface SecretPathConfig { publicOrigin: string; pathSecret: string }

export function validateSecretPathConfig(config: SecretPathConfig, local = false): Readonly<SecretPathConfig> {
  if (!/^[a-f0-9]{64}$/.test(config.pathSecret)) throw new ConfigError('MCP_PATH_SECRET must be 64 lowercase hex characters; generate 32 random bytes');
  return Object.freeze({ publicOrigin: validatePublicOrigin(config.publicOrigin, local), pathSecret: config.pathSecret });
}

export function validatePublicOrigin(origin: string, local = false): string {
  let url: URL;
  try { url = new URL(origin); } catch { throw new ConfigError('Invalid MCP_PUBLIC_ORIGIN'); }
  const safe = local ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port
    : url.protocol === 'https:' && !isIP(url.hostname) && !url.hostname.startsWith('[') && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  if (!safe || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    ![url.origin, `${url.origin}/`].includes(origin)) throw new ConfigError('MCP_PUBLIC_ORIGIN must be an HTTPS origin without path, credentials or query');
  return url.origin;
}

/** Exact raw path only: reject encoding, query strings, trailing slash and aliases. */
export function acceptsSecretPath(rawUrl: string | undefined, secret: string): boolean {
  if (!rawUrl || !/^\/mcp\/[a-f0-9]{64}$/.test(rawUrl)) return false;
  return timingSafeEqual(Buffer.from(rawUrl.slice(5), 'ascii'), Buffer.from(secret, 'ascii'));
}

import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation } from 'jose';
import { isIP } from 'node:net';

export const READ_SCOPE = 'stories:read';
export const WRITE_SCOPE = 'stories:write';
export interface OAuthConfig {
  resource: string;
  issuer: string;
  jwksUri: string;
  allowedSubject: string;
}
export interface Identity { subject: string; scopes: string[]; expiresAt: number }
export class AuthFailure extends Error {
  readonly code: 'invalid_token' | 'insufficient_scope';
  readonly scopes: string[];
  constructor(code: 'invalid_token' | 'insufficient_scope', scopes = [READ_SCOPE]) { super(code); this.code = code; this.scopes = scopes; }
}

/** Only configuration supplies these URLs. Never discover keys from JWT headers. */
export function validateOAuthConfig(config: OAuthConfig, local = false): OAuthConfig {
  const urls = [config.resource, config.issuer, config.jwksUri].map(value => {
    const url = new URL(value);
    const schemeOK = local ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
      : url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
    if (!schemeOK || url.username || url.password || url.search || url.hash || url.href !== value) throw new Error('Invalid OAuth URL');
    return url;
  });
  if (urls[0].pathname !== '/mcp' || urls[1].origin !== urls[2].origin) throw new Error('Invalid OAuth resource or JWKS origin');
  if (typeof config.allowedSubject !== 'string' || !config.allowedSubject.trim() || config.allowedSubject.length > 512) throw new Error('Owner subject is required');
  return Object.freeze({ ...config });
}

async function boundedKeyFetch(url: string, init: Parameters<FetchImplementation>[1]) {
  // jose supplies the timeout signal. Enforce it through body reading too.
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('Keys unavailable'); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 128 * 1024) throw new Error('Keys too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  new TextDecoder('utf-8', { fatal: true }).decode(body);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** OAuth resource server only. The established external IdP owns login/PKCE/refresh. */
export class OAuthVerifier {
  readonly config: OAuthConfig;
  #keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(config: OAuthConfig, local = false) {
    this.config = validateOAuthConfig(config, local);
    this.#keys = createRemoteJWKSet(new URL(this.config.jwksUri), {
      timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
      [customFetch]: boundedKeyFetch,
    });
  }
  async verify(header: string | undefined): Promise<Identity> {
    if (!header || header.length > 16_384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)) throw new AuthFailure('invalid_token');
    try {
      const { payload } = await jwtVerify(header.slice(7), this.#keys, {
        issuer: this.config.issuer, audience: this.config.resource,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'], clockTolerance: 0,
      });
      if (payload.sub !== this.config.allowedSubject || typeof payload.scope !== 'string' ||
          !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.iat! > Date.now() / 1000 ||
          payload.exp! <= payload.iat!) throw new Error('Invalid claims');
      const identity = { subject: payload.sub, scopes: payload.scope.split(' ').filter(Boolean), expiresAt: payload.exp! };
      this.require(identity, [READ_SCOPE]);
      return identity;
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('invalid_token');
    }
  }
  require(identity: Identity, scopes: string[]) {
    if (identity.expiresAt <= Date.now() / 1000) throw new AuthFailure('invalid_token', scopes);
    if (!scopes.every(scope => identity.scopes.includes(scope))) throw new AuthFailure('insufficient_scope', scopes);
  }
  challenge(error = new AuthFailure('invalid_token')) {
    const metadata = new URL('/.well-known/oauth-protected-resource/mcp', this.config.resource).href;
    return `Bearer resource_metadata="${metadata}", scope="${error.scopes.join(' ')}", error="${error.code}", error_description="Authorization required"`;
  }
  metadata(publishing: boolean) {
    return { resource: this.config.resource, authorization_servers: [this.config.issuer],
      scopes_supported: publishing ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE], bearer_methods_supported: ['header'] };
  }
}

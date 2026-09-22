import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import ipaddr from 'ipaddr.js';
import type { Pool, PoolClient } from 'pg';
import { validatePublicOrigin } from '../secret-auth.ts';

const alphabet = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
  .filter(value => /[!-/:-@\[-`{-~]/.test(value)).join('');
const loginPattern = /^[!-/:-@\[-`{-~]{16}$/;
const maxActiveLogins = 8;
const maxHashChecks = 4;
// @node-rs/argon2's Algorithm enum is ambient const: use its documented Argon2id value.
const argon2id = 2;
let activeHashChecks = 0;
const sessionTtlHours = 12;
const rateRejectionSql = `WITH event AS (SELECT clock_timestamp() AS at)
  INSERT INTO outreach_rate_rejections (ip, window_start, rejected_count, first_at, last_at)
  SELECT $1::inet,date_trunc('minute',at),1,at,at FROM event
  ON CONFLICT (ip,window_start) DO UPDATE SET
    rejected_count=outreach_rate_rejections.rejected_count+1,
    last_at=EXCLUDED.last_at`;
function validLogin(secret: string): boolean { return secret.length === 16 && loginPattern.test(secret); }

export class AccessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 503) { super(code); this.name = 'AccessError'; this.code = code; this.status = status; }
}

export const accessMigrationSql = `
CREATE TABLE IF NOT EXISTS outreach_mcp_logins (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  login_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS outreach_owners (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  login text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS outreach_owner_sessions (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES outreach_owners(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS outreach_owner_sessions_expiry ON outreach_owner_sessions(expires_at);
CREATE TABLE IF NOT EXISTS outreach_ip_rates (
  ip inet PRIMARY KEY,
  last_admitted_at timestamptz
);
CREATE TABLE IF NOT EXISTS outreach_rate_rejections (
  ip inet NOT NULL,
  window_start timestamptz NOT NULL,
  rejected_count bigint NOT NULL CHECK (rejected_count > 0),
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (ip, window_start)
);
CREATE TABLE IF NOT EXISTS outreach_access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip inet NOT NULL,
  route text NOT NULL,
  outcome text NOT NULL,
  credential_id uuid,
  request_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS outreach_access_events_created ON outreach_access_events(created_at);
`;

/** Accept only the HTTP origin-form /mcp path and one exact query field. Decode once. */
export function parseMcpLogin(rawUrl: string): string | null {
  if (rawUrl.length > 256 || !rawUrl.startsWith('/mcp?') || rawUrl.includes('#')) return null;
  const query = rawUrl.slice(5);
  if (!query.startsWith('login=') || query.includes('&') || /%(?![0-9a-f]{2})/i.test(query)) return null;
  try {
    const value = decodeURIComponent(query.slice(6).replace(/\+/g, ' '));
    return validLogin(value) ? value : null;
  } catch { return null; }
}

export function generateLogin(): string {
  // 32 symbols divide 256 exactly: masking introduces no modulo bias.
  return Array.from(randomBytes(16), byte => alphabet[byte & 31]).join('');
}

export function generateConnectionUrl(origin: string, secret: string): string {
  if (!validLogin(secret)) throw new AccessError('INVALID_LOGIN_FORMAT', 400);
  const publicOrigin = validatePublicOrigin(origin);
  // Encode ALL punctuation, including characters encodeURIComponent normally preserves.
  const encoded = Array.from(secret, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join('');
  return `${publicOrigin}/mcp?login=${encoded}`;
}

async function withHashSlot<T>(action: () => Promise<T>): Promise<T> {
  if (activeHashChecks >= maxHashChecks) throw new AccessError('ACCESS_CAPACITY_EXCEEDED');
  activeHashChecks++;
  try { return await action(); }
  finally { activeHashChecks--; }
}

/** Salt is generated per call. Raw secrets are never retained or logged. */
export async function hashSecret(secret: string): Promise<string> {
  try {
    return await withHashSlot(async () => hash(secret, {
      algorithm: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
      outputLen: 32, salt: randomBytes(16),
    }));
  } catch (error) { return controlledError(error); }
}

async function verifySecret(encoded: string, secret: string): Promise<boolean> {
  // A damaged/malicious DB hash cannot request unlimited native memory or CPU.
  const options = parseOptions(encoded);
  if (options.algorithm !== argon2id || options.memoryCost < 19456 || options.memoryCost > 65536 ||
    options.timeCost < 2 || options.timeCost > 4 || options.parallelism !== 1 || options.saltLen < 16 || options.outputLen !== 32) {
    throw new AccessError('ACCESS_DEPENDENCY_UNAVAILABLE');
  }
  return verify(encoded, secret);
}

function canonicalIp(value: string): string {
  // Reject zones, ports and nonstandard octal/hex IPv4 representations.
  if (!isIP(value) || value.includes('%')) throw new AccessError('CLIENT_IP_UNAVAILABLE');
  return ipaddr.process(value).toString();
}

function isTrusted(address: string, cidrs: string[]): boolean {
  const parsed = ipaddr.process(address);
  return cidrs.some(cidr => {
    let [network, prefix] = ipaddr.parseCIDR(cidr);
    if (network.kind() === 'ipv6' && (network as ipaddr.IPv6).isIPv4MappedAddress() && prefix >= 96) {
      network = (network as ipaddr.IPv6).toIPv4Address(); prefix -= 96;
    }
    return parsed.kind() === network.kind() && parsed.match(network, prefix);
  });
}

/** Trust XFF only through a configured immediate proxy; stop at first untrusted hop. */
export function clientIp(req: IncomingMessage, trustedCidrs: string[]): string {
  const peer = canonicalIp(req.socket.remoteAddress ?? '');
  if (!isTrusted(peer, trustedCidrs)) return peer;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded === undefined) return peer;
  if (typeof forwarded !== 'string' || forwarded.length > 2048) throw new AccessError('CLIENT_IP_UNAVAILABLE');
  const hops = forwarded.split(',');
  if (hops.length > 32) throw new AccessError('CLIENT_IP_UNAVAILABLE');
  let address = peer;
  for (let index = hops.length - 1; index >= 0 && isTrusted(address, trustedCidrs); index--) {
    address = canonicalIp(hops[index].trim());
  }
  return address;
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function validSessionToken(token: string | null): token is string { return token !== null && token.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(token); }
function controlledError(error: unknown): never {
  if (error instanceof AccessError) throw error;
  throw new AccessError('ACCESS_DEPENDENCY_UNAVAILABLE');
}

export class AccessStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async authenticateLogin(secret: string | null): Promise<{ id: string } | null> {
    if (secret === null || !validLogin(secret)) return null;
    try {
      return await withHashSlot(async () => {
        const result = await this.pool.query<{ id: string; login_hash: string }>(
          'SELECT id, login_hash FROM outreach_mcp_logins WHERE revoked_at IS NULL ORDER BY created_at, id LIMIT 9');
        if (result.rows.length > maxActiveLogins) throw new AccessError('ACCESS_DEPENDENCY_UNAVAILABLE');
        let id: string | null = null;
        for (const row of result.rows) if (await verifySecret(row.login_hash, secret)) id = row.id;
        if (!id) return null;
        const current = await this.pool.query<{ id: string }>(
          'SELECT id FROM outreach_mcp_logins WHERE id=$1 AND revoked_at IS NULL', [id]);
        return current.rows[0] ?? null;
      });
    } catch (error) { return controlledError(error); }
  }

  async authenticateOwner(login: string, password: string): Promise<{ id: string } | null> {
    if (!login || login.length > 128 || !password || password.length > 256) return null;
    try {
      return await withHashSlot(async () => {
        const result = await this.pool.query<{ id: string; password_hash: string }>(
          'SELECT id, password_hash FROM outreach_owners WHERE login=$1', [login]);
        const owner = result.rows[0];
        return owner && await verifySecret(owner.password_hash, password) ? { id: owner.id } : null;
      });
    } catch (error) { return controlledError(error); }
  }

  async createSession(ownerId: string): Promise<{ token: string; csrfToken: string }> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    try {
      await this.pool.query(`INSERT INTO outreach_owner_sessions (token_hash, owner_id, csrf_token, expires_at)
        VALUES ($1,$2,$3,clock_timestamp()+$4::int*interval '1 hour')`, [tokenHash(token), ownerId, csrfToken, sessionTtlHours]);
      return { token, csrfToken };
    } catch (error) { return controlledError(error); }
  }

  async getSession(token: string | null): Promise<{ ownerId: string; csrfToken: string } | null> {
    if (!validSessionToken(token)) return null;
    try {
      const result = await this.pool.query<{ ownerId: string; csrfToken: string }>(`SELECT owner_id AS "ownerId", csrf_token AS "csrfToken"
        FROM outreach_owner_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [tokenHash(token)]);
      return result.rows[0] ?? null;
    } catch (error) { return controlledError(error); }
  }

  async revokeSession(token: string): Promise<void> {
    if (!validSessionToken(token)) return;
    try { await this.pool.query('UPDATE outreach_owner_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(token)]); }
    catch (error) { controlledError(error); }
  }

  async admitIp(ip: string, recordRejection = true): Promise<{ allowed: boolean; retryAfter: number }> {
    const canonical = canonicalIp(ip);
    return this.transaction(async client => {
      await client.query('INSERT INTO outreach_ip_rates(ip) VALUES ($1::inet) ON CONFLICT (ip) DO NOTHING', [canonical]);
      // Lock first, THEN sample DB time: a waiter may not use a timestamp taken before its lock.
      await client.query('SELECT ip FROM outreach_ip_rates WHERE ip=$1::inet FOR UPDATE', [canonical]);
      const result = await client.query<{ allowed: boolean }>(`SELECT
        last_admitted_at IS NULL OR clock_timestamp() >= last_admitted_at+interval '1000 milliseconds' AS allowed
        FROM outreach_ip_rates WHERE ip=$1::inet`, [canonical]);
      if (result.rows[0].allowed) {
        await client.query('UPDATE outreach_ip_rates SET last_admitted_at=clock_timestamp() WHERE ip=$1::inet', [canonical]);
        return { allowed: true, retryAfter: 0 };
      }
      if (recordRejection) await client.query(rateRejectionSql, [canonical]);
      // HTTP Retry-After uses integral seconds; any remaining positive wait rounds up to one.
      return { allowed: false, retryAfter: 1 };
    });
  }

  /** Queue probes are not HTTP rejections; count the final 429 exactly once. */
  async recordRateRejection(ip: string): Promise<void> {
    try { await this.pool.query(rateRejectionSql, [canonicalIp(ip)]); }
    catch (error) { controlledError(error); }
  }

  async recordAccess(event: { ip: string; route: string; outcome: string; credentialId?: string; requestId: string }): Promise<void> {
    // A closed route vocabulary also protects legacy secret paths and malformed raw URLs.
    const knownRoutes = new Set(['/', '/login', '/logout', '/mcp', '/healthz', '/companies/:id', '/api/v1/companies', '/api/v1/candidates', '/api/v1/candidates/resolve', '/api/v1/contacts', '/api/v1/opportunities', '/api/v1/opportunities/status', '/api/v1/session', '/api/v1/access-log']);
    const pathname = event.route.split(/[?#]/, 1)[0];
    const route = knownRoutes.has(pathname) ? pathname : '/unknown';
    const outcome = /^[A-Z_]{1,64}$/.test(event.outcome) ? event.outcome : 'UNSPECIFIED';
    const requestId = /^[a-f\d-]{36}$/i.test(event.requestId) ? event.requestId : randomUUID();
    const credentialId = event.credentialId && /^[a-f\d-]{36}$/i.test(event.credentialId) ? event.credentialId : null;
    try {
      await this.pool.query(`INSERT INTO outreach_access_events(ip,route,outcome,credential_id,request_id) VALUES ($1::inet,$2,$3,$4,$5)`,
        [canonicalIp(event.ip), route, outcome, credentialId, requestId]);
    } catch (error) { controlledError(error); }
  }

  /** Initial provisioning only. An existing owner's credentials are never silently replaced. */
  async seedOwner(login: string, password: string): Promise<void> {
    if (!login || login.length > 128 || !password || password.length > 256) throw new AccessError('INVALID_OWNER_CREDENTIALS', 400);
    const passwordHash = await hashSecret(password);
    try {
      const result = await this.pool.query(`INSERT INTO outreach_owners(id,login,password_hash) VALUES ($1,$2,$3)
        ON CONFLICT (singleton) DO NOTHING RETURNING id`, [randomUUID(), login, passwordHash]);
      if (result.rowCount !== 1) throw new AccessError('OWNER_ALREADY_EXISTS', 409);
    } catch (error) { controlledError(error); }
  }

  async addLogin(secret: string, label: string): Promise<{ id: string }> {
    if (!validLogin(secret)) throw new AccessError('INVALID_LOGIN_FORMAT', 400);
    if (!label || label.length > 128) throw new AccessError('INVALID_LOGIN_LABEL', 400);
    const encoded = await hashSecret(secret);
    return this.transaction(async client => {
      // Serializes provisioning across processes, including an initially empty whitelist.
      await client.query('LOCK TABLE outreach_mcp_logins IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query<{ id: string; login_hash: string }>('SELECT id,login_hash FROM outreach_mcp_logins WHERE revoked_at IS NULL');
      if (existing.rows.length >= maxActiveLogins) throw new AccessError('LOGIN_CAPACITY_REACHED', 409);
      await withHashSlot(async () => {
        for (const row of existing.rows) if (await verifySecret(row.login_hash, secret)) throw new AccessError('LOGIN_ALREADY_EXISTS', 409);
      });
      const id = randomUUID();
      await client.query('INSERT INTO outreach_mcp_logins(id,label,login_hash) VALUES ($1,$2,$3)', [id, label, encoded]);
      return { id };
    });
  }

  async revokeLogin(id: string): Promise<void> {
    try { await this.pool.query('UPDATE outreach_mcp_logins SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL', [id]); }
    catch (error) { controlledError(error); }
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* no raw dependency details */ }
      return controlledError(error);
    } finally { client?.release(); }
  }
}

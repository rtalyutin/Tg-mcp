import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  registrySchemas, searchCompaniesSchema, getCompanySchema, upsertCompanyCandidateSchema,
  saveContactSchema, createOpportunitySchema, getOperationSchema, resolveCandidateSchema,
  setOpportunityStatusSchema, type SourceInput, type StoredSource,
} from './registry-schema.ts';

export const registryMigrationSql = `
CREATE TABLE IF NOT EXISTS outreach_companies (
  id uuid PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'ycs',
  name text NOT NULL, normalized_name text NOT NULL, website text, domain text, inn text,
  sector text, city text, rationale text NOT NULL, sources jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, inn)
);
CREATE TABLE IF NOT EXISTS outreach_candidates (
  id uuid PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'ycs',
  intake_fingerprint text NOT NULL, name text NOT NULL, normalized_name text NOT NULL,
  website text, domain text, inn text, sector text, city text, rationale text NOT NULL, sources jsonb NOT NULL,
  status text NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review','resolved')),
  company_id uuid REFERENCES outreach_companies(id), version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, intake_fingerprint),
  CHECK((status = 'needs_review' AND company_id IS NULL) OR (status = 'resolved' AND company_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS outreach_contacts (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES outreach_companies(id),
  email text NOT NULL, email_key text NOT NULL, name text, position text,
  source jsonb NOT NULL, verified_at timestamptz NOT NULL, invalid boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,email_key)
);
CREATE TABLE IF NOT EXISTS outreach_opportunities (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES outreach_companies(id),
  subject text NOT NULL, sources jsonb NOT NULL, rationale text NOT NULL,
  status text NOT NULL DEFAULT 'candidate' CHECK(status IN
    ('candidate','preparing','awaiting_approval','awaiting_reply','reply_received','negotiating','agreed','declined','deferred')),
  last_action text NOT NULL DEFAULT 'created', last_action_at timestamptz NOT NULL DEFAULT now(),
  next_step text, next_step_at timestamptz, deferred_reason text, reason text, agreement text,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status <> 'deferred' OR (deferred_reason IS NOT NULL AND next_step_at IS NOT NULL)),
  CHECK(status <> 'agreed' OR agreement IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS outreach_operations (
  id uuid PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'ycs', request_id text NOT NULL,
  command text NOT NULL, payload_hash text NOT NULL, actor_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
  result jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, UNIQUE(workspace_id,request_id)
);
CREATE TABLE IF NOT EXISTS outreach_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id uuid NOT NULL REFERENCES outreach_operations(id),
  actor_id text NOT NULL, command text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  company_id uuid REFERENCES outreach_companies(id), old_version integer, new_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_candidate_name ON outreach_candidates(normalized_name);
CREATE INDEX IF NOT EXISTS outreach_company_name ON outreach_companies(normalized_name);
CREATE INDEX IF NOT EXISTS outreach_contact_company ON outreach_contacts(company_id);
CREATE INDEX IF NOT EXISTS outreach_opportunity_company ON outreach_opportunities(company_id);
CREATE INDEX IF NOT EXISTS outreach_audit_company ON outreach_audit(company_id);
`;

export class RegistryError extends Error {
  code: string;
  status: number;
  details?: object;
  constructor(code: string, status: number, message: string, details?: object) {
    super(message); this.name = 'RegistryError'; this.code = code; this.status = status; this.details = details;
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RegistryError('VALIDATION_ERROR', 400, 'Invalid input', {
    issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String), code: issue.code, message: issue.message })),
  });
  return parsed.data;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }

// Unicode 15.0 full case-fold supplements where lowercase differs. Stored inline
// so candidate identity does not depend on an external normalization service.
const caseFoldExtras: Readonly<Record<string,string>> = {"\u00b5":"\u03bc","\u00df":"ss","\u0149":"\u02bcn","\u017f":"s","\u01f0":"j\u030c","\u0345":"\u03b9","\u0390":"\u03b9\u0308\u0301","\u03b0":"\u03c5\u0308\u0301","\u03c2":"\u03c3","\u03d0":"\u03b2","\u03d1":"\u03b8","\u03d5":"\u03c6","\u03d6":"\u03c0","\u03f0":"\u03ba","\u03f1":"\u03c1","\u03f5":"\u03b5","\u0587":"\u0565\u0582","\u13a0":"\u13a0","\u13a1":"\u13a1","\u13a2":"\u13a2","\u13a3":"\u13a3","\u13a4":"\u13a4","\u13a5":"\u13a5","\u13a6":"\u13a6","\u13a7":"\u13a7","\u13a8":"\u13a8","\u13a9":"\u13a9","\u13aa":"\u13aa","\u13ab":"\u13ab","\u13ac":"\u13ac","\u13ad":"\u13ad","\u13ae":"\u13ae","\u13af":"\u13af","\u13b0":"\u13b0","\u13b1":"\u13b1","\u13b2":"\u13b2","\u13b3":"\u13b3","\u13b4":"\u13b4","\u13b5":"\u13b5","\u13b6":"\u13b6","\u13b7":"\u13b7","\u13b8":"\u13b8","\u13b9":"\u13b9","\u13ba":"\u13ba","\u13bb":"\u13bb","\u13bc":"\u13bc","\u13bd":"\u13bd","\u13be":"\u13be","\u13bf":"\u13bf","\u13c0":"\u13c0","\u13c1":"\u13c1","\u13c2":"\u13c2","\u13c3":"\u13c3","\u13c4":"\u13c4","\u13c5":"\u13c5","\u13c6":"\u13c6","\u13c7":"\u13c7","\u13c8":"\u13c8","\u13c9":"\u13c9","\u13ca":"\u13ca","\u13cb":"\u13cb","\u13cc":"\u13cc","\u13cd":"\u13cd","\u13ce":"\u13ce","\u13cf":"\u13cf","\u13d0":"\u13d0","\u13d1":"\u13d1","\u13d2":"\u13d2","\u13d3":"\u13d3","\u13d4":"\u13d4","\u13d5":"\u13d5","\u13d6":"\u13d6","\u13d7":"\u13d7","\u13d8":"\u13d8","\u13d9":"\u13d9","\u13da":"\u13da","\u13db":"\u13db","\u13dc":"\u13dc","\u13dd":"\u13dd","\u13de":"\u13de","\u13df":"\u13df","\u13e0":"\u13e0","\u13e1":"\u13e1","\u13e2":"\u13e2","\u13e3":"\u13e3","\u13e4":"\u13e4","\u13e5":"\u13e5","\u13e6":"\u13e6","\u13e7":"\u13e7","\u13e8":"\u13e8","\u13e9":"\u13e9","\u13ea":"\u13ea","\u13eb":"\u13eb","\u13ec":"\u13ec","\u13ed":"\u13ed","\u13ee":"\u13ee","\u13ef":"\u13ef","\u13f0":"\u13f0","\u13f1":"\u13f1","\u13f2":"\u13f2","\u13f3":"\u13f3","\u13f4":"\u13f4","\u13f5":"\u13f5","\u13f8":"\u13f0","\u13f9":"\u13f1","\u13fa":"\u13f2","\u13fb":"\u13f3","\u13fc":"\u13f4","\u13fd":"\u13f5","\u1c80":"\u0432","\u1c81":"\u0434","\u1c82":"\u043e","\u1c83":"\u0441","\u1c84":"\u0442","\u1c85":"\u0442","\u1c86":"\u044a","\u1c87":"\u0463","\u1c88":"\ua64b","\u1e96":"h\u0331","\u1e97":"t\u0308","\u1e98":"w\u030a","\u1e99":"y\u030a","\u1e9a":"a\u02be","\u1e9b":"\u1e61","\u1e9e":"ss","\u1f50":"\u03c5\u0313","\u1f52":"\u03c5\u0313\u0300","\u1f54":"\u03c5\u0313\u0301","\u1f56":"\u03c5\u0313\u0342","\u1f80":"\u1f00\u03b9","\u1f81":"\u1f01\u03b9","\u1f82":"\u1f02\u03b9","\u1f83":"\u1f03\u03b9","\u1f84":"\u1f04\u03b9","\u1f85":"\u1f05\u03b9","\u1f86":"\u1f06\u03b9","\u1f87":"\u1f07\u03b9","\u1f88":"\u1f00\u03b9","\u1f89":"\u1f01\u03b9","\u1f8a":"\u1f02\u03b9","\u1f8b":"\u1f03\u03b9","\u1f8c":"\u1f04\u03b9","\u1f8d":"\u1f05\u03b9","\u1f8e":"\u1f06\u03b9","\u1f8f":"\u1f07\u03b9","\u1f90":"\u1f20\u03b9","\u1f91":"\u1f21\u03b9","\u1f92":"\u1f22\u03b9","\u1f93":"\u1f23\u03b9","\u1f94":"\u1f24\u03b9","\u1f95":"\u1f25\u03b9","\u1f96":"\u1f26\u03b9","\u1f97":"\u1f27\u03b9","\u1f98":"\u1f20\u03b9","\u1f99":"\u1f21\u03b9","\u1f9a":"\u1f22\u03b9","\u1f9b":"\u1f23\u03b9","\u1f9c":"\u1f24\u03b9","\u1f9d":"\u1f25\u03b9","\u1f9e":"\u1f26\u03b9","\u1f9f":"\u1f27\u03b9","\u1fa0":"\u1f60\u03b9","\u1fa1":"\u1f61\u03b9","\u1fa2":"\u1f62\u03b9","\u1fa3":"\u1f63\u03b9","\u1fa4":"\u1f64\u03b9","\u1fa5":"\u1f65\u03b9","\u1fa6":"\u1f66\u03b9","\u1fa7":"\u1f67\u03b9","\u1fa8":"\u1f60\u03b9","\u1fa9":"\u1f61\u03b9","\u1faa":"\u1f62\u03b9","\u1fab":"\u1f63\u03b9","\u1fac":"\u1f64\u03b9","\u1fad":"\u1f65\u03b9","\u1fae":"\u1f66\u03b9","\u1faf":"\u1f67\u03b9","\u1fb2":"\u1f70\u03b9","\u1fb3":"\u03b1\u03b9","\u1fb4":"\u03ac\u03b9","\u1fb6":"\u03b1\u0342","\u1fb7":"\u03b1\u0342\u03b9","\u1fbc":"\u03b1\u03b9","\u1fbe":"\u03b9","\u1fc2":"\u1f74\u03b9","\u1fc3":"\u03b7\u03b9","\u1fc4":"\u03ae\u03b9","\u1fc6":"\u03b7\u0342","\u1fc7":"\u03b7\u0342\u03b9","\u1fcc":"\u03b7\u03b9","\u1fd2":"\u03b9\u0308\u0300","\u1fd3":"\u03b9\u0308\u0301","\u1fd6":"\u03b9\u0342","\u1fd7":"\u03b9\u0308\u0342","\u1fe2":"\u03c5\u0308\u0300","\u1fe3":"\u03c5\u0308\u0301","\u1fe4":"\u03c1\u0313","\u1fe6":"\u03c5\u0342","\u1fe7":"\u03c5\u0308\u0342","\u1ff2":"\u1f7c\u03b9","\u1ff3":"\u03c9\u03b9","\u1ff4":"\u03ce\u03b9","\u1ff6":"\u03c9\u0342","\u1ff7":"\u03c9\u0342\u03b9","\u1ffc":"\u03c9\u03b9","\uab70":"\u13a0","\uab71":"\u13a1","\uab72":"\u13a2","\uab73":"\u13a3","\uab74":"\u13a4","\uab75":"\u13a5","\uab76":"\u13a6","\uab77":"\u13a7","\uab78":"\u13a8","\uab79":"\u13a9","\uab7a":"\u13aa","\uab7b":"\u13ab","\uab7c":"\u13ac","\uab7d":"\u13ad","\uab7e":"\u13ae","\uab7f":"\u13af","\uab80":"\u13b0","\uab81":"\u13b1","\uab82":"\u13b2","\uab83":"\u13b3","\uab84":"\u13b4","\uab85":"\u13b5","\uab86":"\u13b6","\uab87":"\u13b7","\uab88":"\u13b8","\uab89":"\u13b9","\uab8a":"\u13ba","\uab8b":"\u13bb","\uab8c":"\u13bc","\uab8d":"\u13bd","\uab8e":"\u13be","\uab8f":"\u13bf","\uab90":"\u13c0","\uab91":"\u13c1","\uab92":"\u13c2","\uab93":"\u13c3","\uab94":"\u13c4","\uab95":"\u13c5","\uab96":"\u13c6","\uab97":"\u13c7","\uab98":"\u13c8","\uab99":"\u13c9","\uab9a":"\u13ca","\uab9b":"\u13cb","\uab9c":"\u13cc","\uab9d":"\u13cd","\uab9e":"\u13ce","\uab9f":"\u13cf","\uaba0":"\u13d0","\uaba1":"\u13d1","\uaba2":"\u13d2","\uaba3":"\u13d3","\uaba4":"\u13d4","\uaba5":"\u13d5","\uaba6":"\u13d6","\uaba7":"\u13d7","\uaba8":"\u13d8","\uaba9":"\u13d9","\uabaa":"\u13da","\uabab":"\u13db","\uabac":"\u13dc","\uabad":"\u13dd","\uabae":"\u13de","\uabaf":"\u13df","\uabb0":"\u13e0","\uabb1":"\u13e1","\uabb2":"\u13e2","\uabb3":"\u13e3","\uabb4":"\u13e4","\uabb5":"\u13e5","\uabb6":"\u13e6","\uabb7":"\u13e7","\uabb8":"\u13e8","\uabb9":"\u13e9","\uabba":"\u13ea","\uabbb":"\u13eb","\uabbc":"\u13ec","\uabbd":"\u13ed","\uabbe":"\u13ee","\uabbf":"\u13ef","\ufb00":"ff","\ufb01":"fi","\ufb02":"fl","\ufb03":"ffi","\ufb04":"ffl","\ufb05":"st","\ufb06":"st","\ufb13":"\u0574\u0576","\ufb14":"\u0574\u0565","\ufb15":"\u0574\u056b","\ufb16":"\u057e\u0576","\ufb17":"\u0574\u056d"};
export function normalizeCompanyName(name: string): string {
  return Array.from(name.normalize('NFC'), char => caseFoldExtras[char] ?? char.toLowerCase()).join('').trim().replace(/\s+/gu, ' ');
}
export function sourceIdentity(source: SourceInput): string {
  return source.url ? `url:${new URL(source.url).href}` : `material:${source.material_id}`;
}
export function intakeFingerprint(name: string, sources: SourceInput[]): string {
  return digest(['ycs', normalizeCompanyName(name), [...new Set(sources.map(sourceIdentity))].sort()]);
}
function storeSources(sources: SourceInput[], actorId: string): StoredSource[] {
  return sources.map(source => ({ ...source, id: randomUUID(), actor_id: actorId }));
}
function mergeSources(previous: StoredSource[], incoming: StoredSource[]): StoredSource[] {
  const result = [...previous];
  const key = (source: StoredSource) => digest([sourceIdentity(source),source.claim,source.verification,source.retrieved_at]);
  const known = new Set(previous.map(key));
  for (const source of incoming) if (!known.has(key(source))) { result.push(source); known.add(key(source)); }
  return result;
}
function normalizedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  // Local part is preserved: dots, +tags and case have no universal equivalence.
  return `${email.slice(0,at)}@${domainToASCII(email.slice(at+1)).toLowerCase()}`;
}
function domain(website?: string | null): string | null { return website ? new URL(website).hostname : null; }
function owner(actorId: string): void {
  if (!actorId.startsWith('owner:') || actorId.length <= 6) throw new RegistryError('FORBIDDEN', 403, 'Owner access required');
}
function expected(row: { version: number }, version: number): void {
  if (row.version !== version) throw new RegistryError('VERSION_CONFLICT', 409, 'Record changed', { current_version: row.version });
}
function validInn(inn: string): boolean {
  const sum = (weights: number[]) => weights.reduce((total,weight,index) => total + weight * Number(inn[index]), 0) % 11 % 10;
  return !/^0+$/.test(inn) && (inn.length === 10
    ? sum([2,4,10,3,5,9,4,6,8]) === Number(inn[9])
    : sum([7,2,4,10,3,5,9,4,6,8]) === Number(inn[10]) && sum([3,7,2,4,10,3,5,9,4,6,8]) === Number(inn[11]));
}
type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
type Row = Record<string, any>;
type CommandContext = { client: PoolClient; operationId: string; actorId: string; command: string };

export class Registry {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async companyRow(db: Db, id: string, lock = false): Promise<Row> {
    const result = await db.query(`SELECT * FROM outreach_companies WHERE id=$1 AND workspace_id='ycs'${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!result.rows[0]) throw new RegistryError('NOT_FOUND', 404, 'Company not found');
    return result.rows[0];
  }
  private async card(db: Db, row: Row, kind: 'company'|'candidate'): Promise<Row> {
    const contacts = kind === 'company' ? (await db.query('SELECT * FROM outreach_contacts WHERE company_id=$1 ORDER BY id',[row.id])).rows : [];
    const opportunities = kind === 'company' ? (await db.query('SELECT * FROM outreach_opportunities WHERE company_id=$1 ORDER BY id',[row.id])).rows : [];
    return {
      id: row.id, kind, name: row.name, website: row.website, inn: row.inn, sector: row.sector, city: row.city,
      version: row.version, status: kind === 'company' ? 'confirmed' : row.status,
      company_id: kind === 'company' ? row.id : row.company_id,
      updated_at: row.updated_at, sources: row.sources, rationale: row.rationale, contacts, opportunities,
    };
  }
  private async audit(ctx: CommandContext, type: string, id: string, companyId: string|null, oldVersion: number|null, newVersion: number) {
    await ctx.client.query(`INSERT INTO outreach_audit(operation_id,actor_id,command,entity_type,entity_id,company_id,old_version,new_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.operationId,ctx.actorId,ctx.command,type,id,companyId,oldVersion,newVersion]);
  }
  private async mutate(command: string, input: { request_id: string }, actorId: string, perform: (ctx: CommandContext) => Promise<Row>): Promise<Row> {
    const client = await this.pool.connect();
    const operationId = randomUUID();
    const payloadHash = digest([command,input]);
    let deferredError: RegistryError | undefined;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO outreach_operations(id,request_id,command,payload_hash,actor_id,status)
        VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(workspace_id,request_id) DO NOTHING RETURNING id`,
      [operationId,input.request_id,command,payloadHash,actorId]);
      if (!inserted.rowCount) {
        const previous = (await client.query("SELECT * FROM outreach_operations WHERE workspace_id='ycs' AND request_id=$1",[input.request_id])).rows[0];
        if (previous.payload_hash !== payloadHash || previous.command !== command) throw new RegistryError('IDEMPOTENCY_CONFLICT',409,'request_id was used with different input');
        await client.query('COMMIT');
        if (previous.status === 'failed') throw new RegistryError(previous.error.code,previous.error.status,previous.error.message,previous.error.details);
        return previous.result;
      }
      await client.query('SAVEPOINT command_effects');
      let result: Row = {};
      try {
        result = JSON.parse(JSON.stringify({ ...(await perform({client,operationId,actorId,command})), operation_id: operationId }));
        await client.query("UPDATE outreach_operations SET status='succeeded', result=$2::jsonb, completed_at=now() WHERE id=$1",[operationId,JSON.stringify(result)]);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT command_effects');
        deferredError = error;
        await client.query("UPDATE outreach_operations SET status='failed', error=$2::jsonb, completed_at=now() WHERE id=$1",[operationId,JSON.stringify({code:error.code,status:error.status,message:error.message,details:error.details})]);
      }
      await client.query('COMMIT');
      if (deferredError) throw deferredError;
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof RegistryError) throw error;
      throw new RegistryError('DEPENDENCY_UNAVAILABLE',503,'Registry storage is unavailable');
    } finally { client.release(); }
  }

  async searchCompanies(raw: unknown = {}): Promise<{ items: Row[]; next_cursor: string|null }> {
    const input = parse(searchCompaniesSchema,raw);
    const q = input.q ? `%${normalizeCompanyName(input.q).replace(/[\\%_]/g, '\\$&')}%` : null;
    const result = await this.pool.query(`SELECT * FROM (
      SELECT id, 'company'::text AS kind, normalized_name, 'confirmed'::text AS state FROM outreach_companies WHERE workspace_id='ycs'
      UNION ALL
      SELECT id, 'candidate'::text AS kind, normalized_name, status AS state FROM outreach_candidates WHERE workspace_id='ycs' AND status='needs_review'
    ) entries WHERE ($1::text IS NULL OR normalized_name LIKE $1 ESCAPE '\\')
      AND ($2::uuid IS NULL OR id > $2) AND ($3::text IS NULL OR state=$3 OR EXISTS
      (SELECT 1 FROM outreach_opportunities o WHERE o.company_id=entries.id AND o.status=$3))
      ORDER BY id LIMIT $4`,[q,input.cursor ?? null,input.status ?? null,input.limit+1]);
    const hasMore = result.rows.length > input.limit;
    const entries = result.rows.slice(0,input.limit);
    const items: Row[] = [];
    for (const entry of entries) {
      const table = entry.kind === 'company' ? 'outreach_companies' : 'outreach_candidates';
      const row = (await this.pool.query(`SELECT * FROM ${table} WHERE id=$1`,[entry.id])).rows[0];
      items.push(await this.card(this.pool,row,entry.kind));
    }
    return {items,next_cursor:hasMore ? entries.at(-1)!.id : null};
  }

  async getCompany(raw: unknown): Promise<Row> {
    const input = parse(getCompanySchema,raw);
    const companies = await this.pool.query("SELECT * FROM outreach_companies WHERE id=$1 AND workspace_id='ycs'",[input.id]);
    const kind = companies.rowCount ? 'company' : 'candidate';
    const row = companies.rows[0] ?? (await this.pool.query("SELECT * FROM outreach_candidates WHERE id=$1 AND workspace_id='ycs'",[input.id])).rows[0];
    if (!row) throw new RegistryError('NOT_FOUND',404,'Card not found');
    const history = (await this.pool.query('SELECT * FROM outreach_audit WHERE entity_id=$1 OR company_id=$1 ORDER BY id',[input.id])).rows;
    let possibleMatches: Row[] = [];
    if (kind === 'candidate' && row.status === 'needs_review') {
      possibleMatches = (await this.pool.query(`SELECT id,name,website,'company'::text AS kind FROM outreach_companies
        WHERE workspace_id='ycs' AND (normalized_name=$1 OR ($2::text IS NOT NULL AND domain=$2) OR ($3::text IS NOT NULL AND inn=$3))
        UNION ALL SELECT id,name,website,'candidate'::text AS kind FROM outreach_candidates
        WHERE workspace_id='ycs' AND status='needs_review' AND id<>$4 AND (normalized_name=$1 OR ($2::text IS NOT NULL AND domain=$2))`,
      [row.normalized_name,row.domain,row.inn,row.id])).rows;
    }
    return {...await this.card(this.pool,row,kind),history,possible_matches:possibleMatches};
  }

  async upsertCompanyCandidate(raw: unknown, actorId: string): Promise<Row> {
    const input = parse(upsertCompanyCandidateSchema,raw);
    return this.mutate('upsert_company_candidate',input,actorId,async ctx => {
      if (input.company_id) {
        const row = await this.companyRow(ctx.client,input.company_id,true);
        expected(row as {version:number},input.expected_version!);
        if (input.inn !== undefined && input.inn !== row.inn) throw new RegistryError('IDENTITY_REVIEW_REQUIRED',409,'Changing confirmed INN requires owner review');
        const merged = mergeSources(row.sources,storeSources(input.sources,actorId));
        const updated = (await ctx.client.query(`UPDATE outreach_companies SET name=$2,normalized_name=$3,
          website=$4,domain=$5,sector=$6,city=$7,rationale=$8,sources=$9::jsonb,version=version+1,updated_at=now()
          WHERE id=$1 RETURNING *`,[row.id,input.name,normalizeCompanyName(input.name),input.website === undefined ? row.website : input.website,
          input.website === undefined ? row.domain : domain(input.website),input.sector === undefined ? row.sector : input.sector,
          input.city === undefined ? row.city : input.city,input.rationale,JSON.stringify(merged)])).rows[0];
        await this.audit(ctx,'company',row.id,row.id,row.version,updated.version);
        return {result:'existing',company_id:row.id,candidate_id:null,version:updated.version,company:await this.card(ctx.client,updated,'company')};
      }
      // Assistant supplied INN remains an unverified claim until the owner resolves it.
      const fingerprint = intakeFingerprint(input.name,input.sources);
      const id = randomUUID();
      const inserted = await ctx.client.query(`INSERT INTO outreach_candidates
        (id,intake_fingerprint,name,normalized_name,website,domain,inn,sector,city,rationale,sources)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT(workspace_id,intake_fingerprint) DO NOTHING RETURNING *`,
      [id,fingerprint,input.name,normalizeCompanyName(input.name),input.website ?? null,domain(input.website),input.inn ?? null,
        input.sector ?? null,input.city ?? null,input.rationale,JSON.stringify(storeSources(input.sources,actorId))]);
      const row = inserted.rows[0] ?? (await ctx.client.query("SELECT * FROM outreach_candidates WHERE workspace_id='ycs' AND intake_fingerprint=$1",[fingerprint])).rows[0];
      if (inserted.rowCount) await this.audit(ctx,'candidate',row.id,null,null,1);
      if (row.status === 'resolved') {
        const company = await this.companyRow(ctx.client,row.company_id);
        return {result:'existing',candidate_id:row.id,company_id:row.company_id,version:company.version,company:await this.card(ctx.client,company,'company')};
      }
      return {result:'needs_review',candidate_id:row.id,company_id:null,version:row.version,created:Boolean(inserted.rowCount)};
    });
  }

  async resolveCandidate(raw: unknown, actorId: string): Promise<Row> {
    owner(actorId);
    const input = parse(resolveCandidateSchema,raw);
    return this.mutate('resolve_candidate',input,actorId,async ctx => {
      const candidate = (await ctx.client.query("SELECT * FROM outreach_candidates WHERE id=$1 AND workspace_id='ycs' FOR UPDATE",[input.candidate_id])).rows[0];
      if (!candidate) throw new RegistryError('NOT_FOUND',404,'Candidate not found');
      expected(candidate,input.expected_version);
      if (candidate.status !== 'needs_review') throw new RegistryError('INVALID_STATUS',409,'Candidate is already resolved');
      if (candidate.inn && !validInn(candidate.inn)) throw new RegistryError('INVALID_INN',400,'INN checksum is invalid');
      let company: Row | undefined;
      if (input.company_id) {
        company = await this.companyRow(ctx.client,input.company_id,true);
        if (candidate.inn && company.inn && candidate.inn !== company.inn) throw new RegistryError('IDENTITY_CONFLICT',409,'INN differs from the selected company');
      } else if (candidate.inn) {
        await ctx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ycs:inn:${candidate.inn}`]);
        company = (await ctx.client.query("SELECT * FROM outreach_companies WHERE workspace_id='ycs' AND inn=$1 FOR UPDATE",[candidate.inn])).rows[0];
      }
      if (company) {
        const oldVersion = company.version;
        company = (await ctx.client.query(`UPDATE outreach_companies SET sources=$2::jsonb,version=version+1,updated_at=now()
          WHERE id=$1 RETURNING *`,[company.id,JSON.stringify(mergeSources(company.sources,candidate.sources))])).rows[0];
        await this.audit(ctx,'company',company!.id,company!.id,oldVersion,company!.version);
      } else {
        company = (await ctx.client.query(`INSERT INTO outreach_companies
          (id,name,normalized_name,website,domain,inn,sector,city,rationale,sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [randomUUID(),candidate.name,candidate.normalized_name,candidate.website,candidate.domain,candidate.inn,candidate.sector,candidate.city,candidate.rationale,JSON.stringify(candidate.sources)])).rows[0];
        await this.audit(ctx,'company',company!.id,company!.id,null,1);
      }
      await ctx.client.query("UPDATE outreach_candidates SET status='resolved',company_id=$2,version=version+1,updated_at=now() WHERE id=$1",[candidate.id,company!.id]);
      await this.audit(ctx,'candidate',candidate.id,company!.id,candidate.version,candidate.version+1);
      return {result:'resolved',candidate_id:candidate.id,company_id:company!.id,company:await this.card(ctx.client,company!,'company')};
    });
  }

  async saveContact(raw: unknown, actorId: string): Promise<Row> {
    const input = parse(saveContactSchema,raw);
    return this.mutate('save_contact',input,actorId,async ctx => {
      await this.companyRow(ctx.client,input.company_id,true);
      const emailKey = normalizedEmail(input.email);
      const source = storeSources([input.source],actorId)[0];
      let contact: Row;
      let oldVersion: number|null = null;
      if (input.contact_id) {
        const current = (await ctx.client.query('SELECT * FROM outreach_contacts WHERE id=$1 AND company_id=$2 FOR UPDATE',[input.contact_id,input.company_id])).rows[0];
        if (!current) throw new RegistryError('NOT_FOUND',404,'Contact not found');
        expected(current,input.expected_version!); oldVersion = current.version;
        const duplicate = await ctx.client.query('SELECT id FROM outreach_contacts WHERE company_id=$1 AND email_key=$2 AND id<>$3',[input.company_id,emailKey,current.id]);
        if (duplicate.rowCount) throw new RegistryError('DUPLICATE_CONTACT',409,'Contact already exists',{contact_id:duplicate.rows[0].id});
        contact = (await ctx.client.query(`UPDATE outreach_contacts SET email=$2,email_key=$3,name=$4,position=$5,source=$6::jsonb,
          verified_at=$7,invalid=$8,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [current.id,input.email,emailKey,input.name ?? null,input.position ?? null,JSON.stringify(source),input.verified_at,input.invalid])).rows[0];
      } else {
        const duplicate = await ctx.client.query('SELECT * FROM outreach_contacts WHERE company_id=$1 AND email_key=$2',[input.company_id,emailKey]);
        if (duplicate.rowCount) return {result:'existing',contact:duplicate.rows[0]};
        contact = (await ctx.client.query(`INSERT INTO outreach_contacts(id,company_id,email,email_key,name,position,source,verified_at,invalid)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [randomUUID(),input.company_id,input.email,emailKey,input.name ?? null,input.position ?? null,JSON.stringify(source),input.verified_at,input.invalid])).rows[0];
      }
      await this.audit(ctx,'contact',contact.id,input.company_id,oldVersion,contact.version);
      return {result:oldVersion ? 'updated' : 'created',contact};
    });
  }

  async createOpportunity(raw: unknown, actorId: string): Promise<Row> {
    const input = parse(createOpportunitySchema,raw);
    return this.mutate('create_opportunity',input,actorId,async ctx => {
      await this.companyRow(ctx.client,input.company_id);
      const opportunity = (await ctx.client.query(`INSERT INTO outreach_opportunities(id,company_id,subject,sources,rationale)
        VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *`,[randomUUID(),input.company_id,input.subject,JSON.stringify(storeSources(input.sources,actorId)),input.rationale])).rows[0];
      await this.audit(ctx,'opportunity',opportunity.id,input.company_id,null,1);
      return {result:'created',opportunity};
    });
  }

  async setOpportunityStatus(raw: unknown, actorId: string): Promise<Row> {
    owner(actorId);
    const input = parse(setOpportunityStatusSchema,raw);
    return this.mutate('set_opportunity_status',input,actorId,async ctx => {
      const current = (await ctx.client.query('SELECT * FROM outreach_opportunities WHERE id=$1 FOR UPDATE',[input.opportunity_id])).rows[0];
      if (!current) throw new RegistryError('NOT_FOUND',404,'Opportunity not found');
      expected(current,input.expected_version);
      if (['awaiting_approval','awaiting_reply','reply_received'].includes(input.status)) throw new RegistryError('EVENT_REQUIRED',409,'This status requires its recorded proposal or mail event');
      if (['declined','deferred'].includes(current.status) && input.status !== current.status && !input.reason) throw new RegistryError('REASON_REQUIRED',400,'Resuming requires an explicit reason');
      if (current.status === 'agreed' && input.status !== 'agreed') throw new RegistryError('INVALID_STATUS',409,'An agreed opportunity cannot be reopened here');
      const opportunity = (await ctx.client.query(`UPDATE outreach_opportunities SET status=$2,next_step=$3,next_step_at=$4,
        deferred_reason=$5,reason=$6,agreement=$7,last_action='owner_status_change',last_action_at=now(),version=version+1,updated_at=now()
        WHERE id=$1 RETURNING *`,[current.id,input.status,input.next_step === undefined ? current.next_step : input.next_step,
        input.next_step_at === undefined ? current.next_step_at : input.next_step_at,
        input.status === 'deferred' ? input.deferred_reason : null,input.reason ?? current.reason,input.agreement ?? current.agreement])).rows[0];
      await this.audit(ctx,'opportunity',opportunity.id,current.company_id,current.version,opportunity.version);
      return {result:'updated',opportunity};
    });
  }

  async getOperation(raw: unknown): Promise<Row> {
    const input = parse(getOperationSchema,raw);
    const result = input.operation_id
      ? await this.pool.query("SELECT id,request_id,command,status,result,error,created_at,completed_at FROM outreach_operations WHERE workspace_id='ycs' AND id=$1",[input.operation_id])
      : await this.pool.query("SELECT id,request_id,command,status,result,error,created_at,completed_at FROM outreach_operations WHERE workspace_id='ycs' AND request_id=$1",[input.request_id]);
    if (!result.rows[0]) throw new RegistryError('NOT_FOUND',404,'Operation not found');
    const {id,...row} = result.rows[0];
    return {operation_id:id,...row};
  }
}

const descriptions: Record<keyof typeof registrySchemas,string> = {
  search_companies:'Read the YCS company/candidate register. Negotiation statuses belong to individual opportunities.',
  get_company:'Read one company or unresolved candidate, sources, separate opportunities and audit history.',
  upsert_company_candidate:'Import a candidate with sourced facts, or enrich a confirmed company using expected_version. Claims never confirm identity automatically.',
  save_contact:'Save a sourced contact of a confirmed company. Public contact data is not permission to send mail.',
  create_opportunity:'Create a separate candidate-stage opportunity with a concrete proposal subject. Cannot approve or send mail.',
  get_operation:'Read a committed command outcome after timeout before attempting any retry.',
};
export const registryToolDefinitions: Tool[] = Object.entries(registrySchemas).map(([name,schema]) => ({
  name, description:descriptions[name as keyof typeof registrySchemas],
  inputSchema:z.toJSONSchema(schema,{target:'draft-7'}) as Tool['inputSchema'],
  annotations:{readOnlyHint:['search_companies','get_company','get_operation'].includes(name),destructiveHint:false,idempotentHint:true,openWorldHint:false},
}));
export async function executeRegistryTool(registry: Registry, name: string, args: unknown, actorId: string): Promise<object> {
  switch (name) {
    case 'search_companies': return registry.searchCompanies(args);
    case 'get_company': return registry.getCompany(args);
    case 'upsert_company_candidate': return registry.upsertCompanyCandidate(args,actorId);
    case 'save_contact': return registry.saveContact(args,actorId);
    case 'create_opportunity': return registry.createOpportunity(args,actorId);
    case 'get_operation': return registry.getOperation(args);
    default: throw new RegistryError('UNKNOWN_TOOL',404,'Unknown registry tool');
  }
}

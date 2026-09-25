import type { Pool } from 'pg';
import { z } from 'zod';

const identifier = z.string().min(1).refine(value =>
  !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 63, 'Invalid PostgreSQL identifier');
const values = z.record(identifier, z.unknown());
const fields = values.refine(value => Object.keys(value).length > 0);
const target = { schema: identifier, table: identifier };
const page = { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() };
const listInput = z.strictObject({ schema: identifier.optional(), ...page });
const describeInput = z.strictObject(target);
const readInput = z.strictObject({ ...target, where: fields.optional(), columns: z.array(identifier).min(1).max(100).optional(),
  order_by: z.array(identifier).min(1).max(5).optional(), ...page });
const databaseReadInput = readInput.partial({ schema: true, table: true });
const writeInput = z.strictObject({ ...target, operation: z.enum(['insert', 'update', 'upsert']),
  rows: z.array(z.strictObject({ values, where: fields.optional(), expected_count: z.number().int().min(1).max(100).optional() })).min(1).max(100) });

export class DatabaseToolError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DatabaseToolError'; this.code = code; }
}

function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function qualified(schema: string, table: string) { return `${quote(schema)}.${quote(table)}`; }
function predicate(values: Record<string, unknown>, start = 1) {
  const entries = Object.entries(values);
  return { sql: entries.map(([name], index) => `${quote(name)} IS NOT DISTINCT FROM $${start + index}`).join(' AND '),
    parameters: entries.map(([, value]) => value) };
}

type Column = { name: string; data_type: string; nullable: boolean; default_value: string | null; generated: string; identity: string };
type Relation = { oid: number; kind: string; can_read: boolean; can_insert: boolean; can_update: boolean };

export class DatabaseTools {
  private readonly pool: Pool;
  readonly credentialId: string;
  constructor(pool: Pool, credentialId: string) { this.pool = pool; this.credentialId = credentialId; }

  async listTables(input: unknown) {
    const args = listInput.parse(input ?? {});
    const result = await this.pool.query(`SELECT n.nspname AS schema, c.relname AS table,
        has_table_privilege(c.oid, 'SELECT') AS can_read,
        has_table_privilege(c.oid, 'INSERT') AS can_insert,
        has_table_privilege(c.oid, 'UPDATE') AS can_update
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','f') AND ($1::text IS NULL OR n.nspname=$1)
        AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE'))
      ORDER BY CASE WHEN left(n.nspname,3)='pg_' OR n.nspname='information_schema' THEN 1 ELSE 0 END,
        n.nspname,c.relname LIMIT $2 OFFSET $3`, [args.schema ?? null, (args.limit ?? 100) + 1, args.offset ?? 0]);
    const limit = args.limit ?? 100;
    return { tables: result.rows.slice(0, limit), has_more: result.rows.length > limit, offset: args.offset ?? 0 };
  }

  private async relation(schema: string, table: string): Promise<Relation> {
    const result = await this.pool.query(`SELECT c.oid, c.relkind AS kind,
        has_table_privilege(c.oid, 'SELECT') AS can_read,
        has_table_privilege(c.oid, 'INSERT') AS can_insert,
        has_table_privilege(c.oid, 'UPDATE') AS can_update
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p','f')`, [schema, table]);
    if (!result.rows.length) throw new DatabaseToolError('DATABASE_TABLE_NOT_FOUND');
    return result.rows[0] as Relation;
  }

  private async columns(oid: number): Promise<{ columns: Column[]; primary_key: string[] }> {
    const columns = await this.pool.query(`SELECT a.attname AS name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
        NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value,
        a.attgenerated AS generated, a.attidentity AS identity
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [oid]);
    const primary = await this.pool.query(`SELECT a.attname AS name FROM pg_catalog.pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,position) ON k.position<=i.indnkeyatts
      JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE i.indrelid=$1 AND i.indisprimary ORDER BY k.position`, [oid]);
    return { columns: columns.rows as Column[], primary_key: primary.rows.map(row => row.name as string) };
  }

  async describeTable(input: unknown) {
    const args = describeInput.parse(input ?? {});
    const relation = await this.relation(args.schema, args.table);
    const structure = await this.columns(relation.oid);
    return { schema: args.schema, table: args.table, kind: relation.kind,
      can_read: relation.can_read, can_insert: relation.can_insert, can_update: relation.can_update, ...structure };
  }

  async readDatabase(input: unknown) {
    const args = databaseReadInput.parse(input ?? {});
    if (!args.table) {
      if (args.where || args.columns || args.order_by) throw new DatabaseToolError('DATABASE_INPUT_INVALID');
      return this.listTables({ schema: args.schema, limit: args.limit, offset: args.offset });
    }
    if (!args.schema) throw new DatabaseToolError('DATABASE_INPUT_INVALID');
    return this.readRows(args);
  }

  async readRows(input: unknown) {
    const args = readInput.parse(input ?? {});
    const relation = await this.relation(args.schema, args.table);
    if (!relation.can_read) throw new DatabaseToolError('DATABASE_PERMISSION_DENIED');
    const { columns, primary_key } = await this.columns(relation.oid);
    const available = new Set(columns.map(column => column.name));
    for (const field of [...Object.keys(args.where ?? {}), ...(args.columns ?? []), ...(args.order_by ?? [])]) {
      if (!available.has(field)) throw new DatabaseToolError('DATABASE_COLUMN_NOT_FOUND');
    }
    const where = args.where ? predicate(args.where) : null;
    const order = args.order_by ?? primary_key;
    const limit = args.limit ?? 50;
    const selection = args.columns?.map(quote).join(', ') ?? '*';
    const result = await this.pool.query(`SELECT ${selection} FROM ${qualified(args.schema, args.table)}` +
      (where ? ` WHERE ${where.sql}` : '') + (order.length ? ` ORDER BY ${order.map(quote).join(', ')}` : '') +
      ` LIMIT $${(where?.parameters.length ?? 0) + 1} OFFSET $${(where?.parameters.length ?? 0) + 2}`,
      [...(where?.parameters ?? []), limit + 1, args.offset ?? 0]);
    const output = { schema: args.schema, table: args.table, columns, primary_key,
      rows: result.rows.slice(0, limit), has_more: result.rows.length > limit,
      offset: args.offset ?? 0, order_by: order };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 1_000_000)
      throw new DatabaseToolError('DATABASE_RESULT_TOO_LARGE');
    return output;
  }

  async writeRows(input: unknown) {
    const args = writeInput.parse(input ?? {});
    const relation = await this.relation(args.schema, args.table);
    if ((args.operation === 'update' && !relation.can_update) ||
      (args.operation === 'insert' && !relation.can_insert) ||
      (args.operation === 'upsert' && (!relation.can_insert || !relation.can_update)))
      throw new DatabaseToolError('DATABASE_PERMISSION_DENIED');
    const { columns, primary_key } = await this.columns(relation.oid);
    const available = new Set(columns.map(column => column.name));
    for (const row of args.rows) {
      if ((args.operation === 'insert' && (row.where || row.expected_count)) ||
        (args.operation !== 'insert' && !row.where) ||
        (args.operation === 'upsert' && row.expected_count) ||
        (args.operation !== 'insert' && !Object.keys(row.values).length))
        throw new DatabaseToolError('DATABASE_INPUT_INVALID');
      for (const field of [...Object.keys(row.values), ...Object.keys(row.where ?? {})]) {
        if (!available.has(field)) throw new DatabaseToolError('DATABASE_COLUMN_NOT_FOUND');
      }
      if (args.operation === 'upsert' &&
        (!primary_key.length || primary_key.some(key => !Object.hasOwn(row.where!, key)) ||
          Object.keys(row.where!).length !== primary_key.length ||
          Object.keys(row.values).some(key => primary_key.includes(key))))
        throw new DatabaseToolError('DATABASE_PRIMARY_KEY_REQUIRED');
    }
    const table = qualified(args.schema, args.table);
    const client = await this.pool.connect();
    const results: { affected: number }[] = [];
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      for (const row of args.rows) {
        const entries = Object.entries(row.values);
        const names = entries.map(([name]) => name);
        const values = entries.map(([, value]) => value);
        if (args.operation === 'insert') {
          const sql = names.length ? `INSERT INTO ${table} (${names.map(quote).join(', ')}) VALUES (${values.map((_,i) => `$${i + 1}`).join(', ')}) RETURNING 1` :
            `INSERT INTO ${table} DEFAULT VALUES RETURNING 1`;
          const inserted = await client.query(sql, values);
          results.push({ affected: inserted.rowCount ?? 0 });
        } else if (args.operation === 'upsert') {
          const keys = primary_key.map(key => row.where![key]);
          const inserted = await client.query(`INSERT INTO ${table} (${[...primary_key, ...names].map(quote).join(', ')}) ` +
            `VALUES (${[...keys, ...values].map((_,i) => `$${i + 1}`).join(', ')}) ` +
            `ON CONFLICT (${primary_key.map(quote).join(', ')}) DO UPDATE SET ` +
            names.map(name => `${quote(name)}=EXCLUDED.${quote(name)}`).join(', ') + ' RETURNING 1', [...keys, ...values]);
          results.push({ affected: inserted.rowCount ?? 0 });
        } else {
          const where = predicate(row.where!, values.length + 1);
          const expected = row.expected_count ?? 1;
          const check = predicate(row.where!);
          const matches = await client.query(`SELECT 1 FROM ${table} WHERE ${check.sql} LIMIT $${check.parameters.length + 1} FOR UPDATE`,
            [...check.parameters, expected + 1]);
          if (matches.rows.length !== expected) throw new DatabaseToolError('DATABASE_MATCH_COUNT_CHANGED');
          const updated = await client.query(`UPDATE ${table} SET ${names.map((name, i) => `${quote(name)}=$${i + 1}`).join(', ')} ` +
            `WHERE ${where.sql} RETURNING 1`, [...values, ...where.parameters]);
          if (updated.rowCount !== expected) throw new DatabaseToolError('DATABASE_MATCH_COUNT_CHANGED');
          results.push({ affected: updated.rowCount ?? 0 });
        }
      }
      await client.query('COMMIT');
      return { operation: args.operation, rows: results, affected: results.reduce((sum, result) => sum + result.affected, 0) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

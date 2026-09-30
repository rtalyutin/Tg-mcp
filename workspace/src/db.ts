import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
export type Client = pg.PoolClient;
export const id = randomUUID;
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
export class Database {
  pool: pg.Pool;
  constructor(
    url: string,
    private options: {
      schema?: string;
      migrationsDirectory?: string;
      max?: number;
    } = {},
  ) {
    if (options.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("invalid_database_schema");
    // node-postgres gives URL options precedence over Pool options. Pin the
    // namespace in the URL too, after any existing timeout/session options.
    let connectionString = url;
    if (options.schema) {
      const parsed = new URL(url);
      parsed.searchParams.set(
        "options",
        `${parsed.searchParams.get("options") ?? ""} -c search_path=${options.schema}`.trim(),
      );
      connectionString = parsed.toString();
    }
    this.pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      ...(options.schema
        ? { options: `-c search_path=${options.schema}` }
        : {}),
    });
    this.pool.on("error", () => {});
  }
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(1853459820)");
      if (this.options.schema)
        await c.query(`CREATE SCHEMA IF NOT EXISTS "${this.options.schema}"`);
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const directory =
        this.options.migrationsDirectory ?? resolve("migrations");
      for (const name of (await readdir(directory))
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const old = (
          await c.query("SELECT digest FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rows[0];
        if (old) {
          if (old.digest !== hash(sql))
            throw new Error("Applied migration changed: " + name);
          continue;
        }
        await c.query("BEGIN");
        try {
          await c.query(sql);
          await c.query(
            "INSERT INTO schema_migrations(name,digest) VALUES($1,$2)",
            [name, hash(sql)],
          );
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await c.query("SELECT pg_advisory_unlock(1853459820)");
      c.release();
    }
  }
  async tx<T>(owner: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // One personal workspace: this lock serializes hierarchy/queue/archive and receipts.
      // READ COMMITTED deliberately re-reads after the lock, including another client's commit.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        owner,
      ]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  close() {
    return this.pool.end();
  }
}
export async function one(c: Client, sql: string, params: unknown[] = []) {
  const r = (await c.query(sql, params)).rows[0];
  if (!r) throw new DomainError("not_found", 404);
  return r;
}
export function revision(row: Record<string, unknown>, expected: number) {
  if (Number(row.revision) !== expected)
    throw new DomainError("revision_conflict", 409, {
      current_revision: Number(row.revision),
    });
}

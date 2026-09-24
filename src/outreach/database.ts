import { Pool } from 'pg';
import { accessMigrationSql } from './access.ts';
import { registryMigrationSql } from './registry.ts';
import { coverMigrationSql, deliveryMigrationSql } from './telegram-delivery.ts';

export function createOutreachPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, application_name: 'ycs-outreach' });
  // pg otherwise emits an unhandled error; never print connection details.
  pool.on('error', () => console.error('OUTREACH_DATABASE_CONNECTION_FAILED'));
  return pool;
}

/** One migration owner, atomic schema installation, refusal of unknown future schemas. */
export async function migrateOutreach(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ycs-outreach-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS outreach_schema_version (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL)`);
    const current = await client.query('SELECT version FROM outreach_schema_version WHERE singleton = true');
    if (current.rows.length && ![1, 2, 3].includes(current.rows[0].version)) throw new Error('UNSUPPORTED_OUTREACH_SCHEMA');
    if (!current.rows.length) {
      await client.query(accessMigrationSql);
      await client.query(registryMigrationSql);
      await client.query('INSERT INTO outreach_schema_version(singleton, version) VALUES(true, 1)');
    }
    if (!current.rows.length || current.rows[0].version === 1) {
      await client.query(deliveryMigrationSql);
      await client.query('UPDATE outreach_schema_version SET version = 2 WHERE singleton = true');
    }
    if (!current.rows.length || current.rows[0].version < 3) {
      await client.query(coverMigrationSql);
      await client.query('UPDATE outreach_schema_version SET version = 3 WHERE singleton = true');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

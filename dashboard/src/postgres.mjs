import pg from 'pg';

// One checked-out client for the entire transaction; never pool.query(BEGIN).
export function connectPostgres(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL_REQUIRED');
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({query: (sql, params) => client.query(sql, params), exec: sql => client.query(sql)});
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end()
  };
}

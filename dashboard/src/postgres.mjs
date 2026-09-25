import pg from 'pg';

// One checked-out client for the entire transaction; never pool.query(BEGIN).
export function connectPostgres(connectionString, {connectionTimeoutMillis=5000}={}) {
  if (!connectionString) throw new Error('DATABASE_URL_REQUIRED');
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis });
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn, {timeoutMs}={}) {
      const bounded=timeoutMs!==undefined;
      if (bounded && (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000))
        throw new Error('DASHBOARD_TRANSACTION_TIMEOUT_INVALID');
      const client = await pool.connect();
      let released=false;
      let timedOut=false;
      let rejectDeadline;
      let timer;
      const deadline=bounded?new Promise((_,reject)=>{rejectDeadline=reject;}):undefined;
      // Attach a handler immediately in case the timeout falls between queries.
      if (deadline) deadline.catch(()=>{});
      if (bounded) timer=setTimeout(()=>{
        timedOut=true;
        const error=new Error('DASHBOARD_TRANSACTION_TIMEOUT');
        if (!released) { released=true; client.release(error); }
        rejectDeadline(error);
      },timeoutMs);
      const query=async(sql,params)=>{
        const pending=client.query(sql,params);
        return deadline ? Promise.race([pending,deadline]) : pending;
      };
      try {
        await query('BEGIN');
        const result = await fn({query, exec: sql => query(sql)});
        await query('COMMIT');
        return result;
      } catch (error) {
        if (!timedOut) await query('ROLLBACK').catch(()=>{});
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (!released) client.release();
      }
    },
    close: () => pool.end()
  };
}

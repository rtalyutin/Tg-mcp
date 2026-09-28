import {readCuratedSnapshot} from './curated-snapshot.mjs';

const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
};

export function createTaskPlan(db) {
  return {
    async read() {
      const {rows} = await db.query(`SELECT task_id, start_date::text, end_date::text, version
        FROM dashboard.task_plan ORDER BY task_id`);
      return rows.map(row => ({task_id:row.task_id,start_date:row.start_date,
        end_date:row.end_date,version:row.version}));
    },
    async write(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'end_date,start_date,task_id,version' ||
          typeof input.task_id !== 'string' || !input.task_id || input.task_id.length > 256 ||
          !Number.isSafeInteger(input.version) || input.version < 0 ||
          !((input.start_date === null && input.end_date === null) ||
            (validDate(input.start_date) && validDate(input.end_date) && input.start_date <= input.end_date)))
        throw new Error('INVALID_TASK_PLAN');
      return db.transaction(async tx => {
        const snapshot = await readCuratedSnapshot(tx);
        if (!snapshot?.tasks.some(task => task.id === input.task_id)) throw new Error('TASK_NOT_FOUND');
        const {rows} = await tx.query(`INSERT INTO dashboard.task_plan(task_id,start_date,end_date,version)
          VALUES ($1,$2::date,$3::date,1)
          ON CONFLICT (task_id) DO UPDATE SET start_date=EXCLUDED.start_date,
            end_date=EXCLUDED.end_date,version=dashboard.task_plan.version+1,updated_at=now()
          WHERE dashboard.task_plan.version=$4
          RETURNING task_id,start_date::text,end_date::text,version`,
          [input.task_id,input.start_date,input.end_date,input.version]);
        // A new row requires version 0. Reject an insert with a stale expected version.
        if (rows[0]?.version !== input.version+1) throw new Error('TASK_PLAN_CONFLICT');
        const row=rows[0];
        return {task_id:row.task_id,start_date:row.start_date,end_date:row.end_date,version:row.version};
      });
    }
  };
}

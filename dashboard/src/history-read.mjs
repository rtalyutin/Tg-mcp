const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

export function validDay(value) {
  if (typeof value !== 'string' || !dayPattern.test(value) || value.slice(0,4) === '0000') return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function asDay(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function publicRow(row) {
  return {date: asDay(row.report_date), state: row.state, coverage: row.coverage,
    payload: row.result_payload, group_memberships: row.group_memberships};
}

export function createHistoryReader(db) {
  return {
    async dates() {
      const {rows} = await db.query(`SELECT report_date,state,coverage FROM dashboard.published_daily_history
        ORDER BY report_date DESC LIMIT 2000`);
      return rows.map(row => ({date: asDay(row.report_date), state: row.state, coverage: row.coverage}));
    },
    async compare(a, b) {
      for (const period of [a, b]) {
        if (!validDay(period.from) || !validDay(period.to) || period.from > period.to)
          throw new Error('INVALID_PERIOD');
        if ((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`))/86400000 >= 2000)
          throw new Error('PERIOD_TOO_LONG');
      }
      if (a.to >= b.from) throw new Error('PERIODS_OVERLAP');
      const load = async period => {
        const {rows} = await db.query(`SELECT report_date,state,coverage,result_payload,group_memberships,changes
          FROM dashboard.published_daily_history WHERE report_date BETWEEN $1::date AND $2::date
          ORDER BY report_date LIMIT 2001`,
        [period.from, period.to]);
        if (rows.length > 2000) throw new Error('PERIOD_TOO_LONG');
        return {endpoint: rows.length ? publicRow(rows.at(-1)) : null,
          events: rows.flatMap(row => row.state === 'baseline_only' ? [] :
            row.changes.filter(change => change && typeof change === 'object' && !Array.isArray(change))
              .map(change => ({...change, report_date: asDay(row.report_date)}))),
          days: rows.map(row => ({date:asDay(row.report_date),coverage:row.coverage,state:row.state}))};
      };
      const first = await load(a), second = await load(b);
      return {a:first,b:second};
    }
  };
}

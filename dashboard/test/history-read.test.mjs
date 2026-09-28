import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/migrate.mjs';
import {createHistoryReader,validDay} from '../src/history-read.mjs';

test('history lists only committed days and compares endpoint states and events within both ranges',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const digest='a'.repeat(64);
    for (const [date,state,progress,events] of [
      ['2026-09-24','baseline_only',20,[]],
      ['2026-09-25','applied',40,[{type:'progress',task_id:'t',old_value:20,new_value:40}]],
      ['2026-09-26','prepared',50,[{type:'progress',task_id:'t',new_value:50}]],
      ['2026-09-27','applied',70,[{type:'progress',task_id:'t',old_value:40,new_value:70}]],
    ]) {
      await db.query(`INSERT INTO dashboard.daily_result
        (report_date,result_digest,result_payload,group_memberships,changes,dialog_scan,coverage,state,applied_at)
        VALUES ($1,$2,$3,$4,$5,'{}','partial',$6,$7)`,
        [date,digest,{schema:'dashboard-curated-snapshot/1',tasks:[{id:'t',progress_percent:progress}]},
          {p:['g']},events,state,state==='applied' ? new Date() : null]);
    }
    await db.exec('CREATE ROLE dashboard_runtime LOGIN');
    await db.exec(await readFile(new URL('../sql/grant-runtime.sql',import.meta.url),'utf8'));
    await db.exec('SET ROLE dashboard_runtime');
    await assert.rejects(db.query('SELECT * FROM dashboard.daily_result'),/permission denied/);
    const history=createHistoryReader(db);
    assert.deepEqual((await history.dates()).map(row=>row.date),['2026-09-27','2026-09-25','2026-09-24']);
    const result=await history.compare({from:'2026-09-24',to:'2026-09-25'},
      {from:'2026-09-26',to:'2026-09-27'});
    assert.equal(result.a.endpoint.payload.tasks[0].progress_percent,40);
    assert.equal(result.b.endpoint.payload.tasks[0].progress_percent,70);
    assert.deepEqual(result.a.events.map(event=>event.report_date),['2026-09-25']);
    assert.deepEqual(result.b.events.map(event=>event.report_date),['2026-09-27']);
    assert.equal(result.a.endpoint.group_memberships.p[0],'g');
    await assert.rejects(history.compare({from:'2026-09-25',to:'2026-09-27'},
      {from:'2026-09-27',to:'2026-09-28'}),/PERIODS_OVERLAP/);
    await assert.rejects(history.compare({from:'2026-02-30',to:'2026-09-25'},
      {from:'2026-09-27',to:'2026-09-28'}),/INVALID_PERIOD/);
    assert.equal(validDay('2026-02-30'),false);
  } finally {await db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate,verifySchema} from '../src/migrate.mjs';

const digest='a'.repeat(64);
const insertPrepared=database=>database.query(`INSERT INTO dashboard.daily_result
  (report_date,baseline_date,baseline_digest,result_digest,result_payload,
   group_memberships,changes,dialog_cutoff_at,dialog_scan,coverage,state)
  VALUES ('2026-09-25','2026-09-24',$1,$1,$2,$3,$4,'2026-09-25T06:00:00Z',$5,'partial','prepared')`,
  [digest,{as_of:'2026-09-25',projects:[],tasks:[]},{},[],{complete:true,dialogs:12}]);

test('daily results accept a prepared-to-applied recovery and reject history rewrites',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    assert.deepEqual(await verifySchema(db),{version:6});
    await insertPrepared(db);
    await db.query("UPDATE dashboard.daily_result SET state='applied',applied_at=now() WHERE report_date='2026-09-25'");
    const {rows:[row]}=await db.query("SELECT state,changes,coverage FROM dashboard.daily_result WHERE report_date='2026-09-25'");
    assert.deepEqual(row,{state:'applied',changes:[],coverage:'partial'});
    await assert.rejects(db.query("UPDATE dashboard.daily_result SET changes='[{}]' WHERE report_date='2026-09-25'"),/DAILY_RESULT_IMMUTABLE/);
  } finally {await db.close();}
});

test('daily results reject invalid baselines and states',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    await assert.rejects(db.query(`INSERT INTO dashboard.daily_result
      (report_date,baseline_date,result_digest,result_payload,group_memberships,changes,
       dialog_cutoff_at,dialog_scan,coverage,state)
      VALUES ('2026-09-24','2026-09-25',$1,'{}','{}','[]','2026-09-25T06:00:00Z','{}','partial','applied')`,[digest]),/check constraint/);
    await assert.rejects(db.query(`INSERT INTO dashboard.daily_result
      (report_date,result_digest,result_payload,group_memberships,changes,
       dialog_cutoff_at,dialog_scan,coverage,state)
      VALUES ('2026-09-25',$1,'{}','{}','[]','2026-09-25T06:00:00Z','{}','partial','unknown')`,[digest]),/check constraint/);
  } finally {await db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,verifySchema} from '../src/migrate.mjs';
import {registerSource,ingestBatch,readCheckpoint,verifyBatch} from '../src/ingest.mjs';
import {beginFullRun,completeRunSource,finalizeRun} from '../src/run-lifecycle.mjs';
import {verifyRuntimePrivileges} from '../src/runtime-privileges.mjs';

test('restricted runtime role completes an import but cannot change owner state or migrate',async()=>{
  const db=new PGlite();
  try {
    await migrate(db);
    const codex=randomUUID(),chatgpt=randomUUID();
    await registerSource(db,{id:codex,kind:'codex',externalScope:'test-codex'});
    await registerSource(db,{id:chatgpt,kind:'chatgpt',externalScope:'test-chatgpt'});
    await db.exec('CREATE ROLE dashboard_runtime LOGIN');
    await db.exec(await readFile(new URL('../sql/grant-runtime.sql',import.meta.url),'utf8'));
    await db.exec('SET ROLE dashboard_runtime');
    assert.deepEqual(await verifySchema(db),{version:4});
    await verifyRuntimePrivileges(db);
    const run=await beginFullRun(db);
    for (const source of run.sources) {
      const batchKey=`packet-${source.kind}`;
      const receipt=await ingestBatch(db,{sourceId:source.sourceId,runId:run.runId,
        batchKey,baseVersion:0,cursorAfter:{done:true},events:[{
          nativeId:'synthetic-message',revision:'1',threadId:'synthetic-thread',
          occurredAt:'2026-09-24T00:00:00Z',payload:{text:'synthetic only'}
        }]});
      assert.equal(receipt.committedVersion,1);
      assert.equal((await verifyBatch(db,source.sourceId,batchKey)).verified,true);
      assert.equal((await readCheckpoint(db,source.sourceId)).version,1);
      await completeRunSource(db,{runId:run.runId,sourceId:source.sourceId,
        fromVersion:0,toVersion:1,observedCount:1,endOfSource:true,
        method:'full_enumeration',collectorVersion:'test',watermark:null});
    }
    assert.equal((await finalizeRun(db,run.runId)).completed,true);
    await assert.rejects(db.query('SELECT * FROM dashboard.project_visibility'),/permission denied/);
    await assert.rejects(db.query('DELETE FROM dashboard.source_event'),/permission denied/);
    await assert.rejects(db.query('CREATE TABLE dashboard.illicit_table(id integer)'),/permission denied/);
  } finally {await db.close();}
});

test('runtime verifier rejects an overly privileged migration owner',async()=>{
  const db=new PGlite();
  try {await migrate(db);await assert.rejects(verifyRuntimePrivileges(db),/DASHBOARD_DB_ROLE_INVALID/);}
  finally {await db.close();}
});

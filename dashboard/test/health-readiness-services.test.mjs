import test from 'node:test';
import assert from 'node:assert/strict';
import {createCuratedSnapshotGateway} from '../src/curated-snapshot-gateway.mjs';
import {createSnapshotUpdateService} from '../src/snapshot-update-service.mjs';
import {createDashboardHandler} from '../src/http-gateway.mjs';

const snapshot={schema:'dashboard-curated-snapshot/1',coverage:'partial',projects:[],tasks:[],automations:[],sources:{},excluded_project_titles:[]};

test('snapshot reader, update writer, and MCP health probes use read-only timed transactions',async()=>{
  const snapshotSql=[];
  let snapshotTransactionOptions;
  const snapshotDb={
    query:async()=>({rows:[]}),
    transaction:async(fn,options)=>{
      snapshotTransactionOptions=options;
      return fn({exec:async sql=>snapshotSql.push(sql),query:async sql=>{
        snapshotSql.push(sql);return {rows:[{payload:snapshot}]};
      }});
    },
    close:async()=>{},
  };
  const reader=await createCuratedSnapshotGateway('postgres://example/dashboard',{connect:()=>snapshotDb,sharedRole:true});
  assert.deepEqual(await reader.read({timeoutMs:2000}),snapshot);
  assert.deepEqual(snapshotTransactionOptions,{timeoutMs:2000});
  assert.ok(snapshotSql.includes('SET TRANSACTION READ ONLY'));
  assert.ok(snapshotSql.includes('SET LOCAL statement_timeout = 2000'));
  assert.ok(!snapshotSql.some(sql=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)));

  const writerSql=[];
  let writerConnectionOptions;
  let writerTransactionOptions;
  const writerDb={
    query:async()=>({rows:[]}),
    transaction:async(fn,options)=>{
      writerTransactionOptions=options;
      return fn({exec:async sql=>writerSql.push(sql),query:async sql=>{
        writerSql.push(sql);
        if (sql.includes('has_table_privilege')) return {rows:[{can_read:true,can_update:true}]};
        return {rows:[{payload:snapshot,digest:'private'}]};
      }});
    },
    close:async()=>{},
  };
  const writer=createSnapshotUpdateService({credentialId:'owner',databaseUrl:'postgres://example/dashboard'},
    {connect:(_url,options)=>{writerConnectionOptions=options;return writerDb;}});
  assert.equal((await writer.readState({timeoutMs:2000})).coverage,'partial');
  assert.deepEqual(writerConnectionOptions,{connectionTimeoutMillis:2000});
  assert.deepEqual(writerTransactionOptions,{timeoutMs:2000});
  assert.ok(writerSql.includes('SET TRANSACTION READ ONLY'));
  assert.ok(writerSql.includes('SET LOCAL statement_timeout = 2000'));
  assert.ok(!writerSql.some(sql=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)));

  const mcpSql=[];
  let mcpTransactionOptions;
  const mcp=createDashboardHandler({transaction:async(fn,options)=>{
    mcpTransactionOptions=options;
    return fn({exec:async sql=>mcpSql.push(sql),query:async sql=>{mcpSql.push(sql);return {rows:[{value:1}]};}});
  }},'m'.repeat(40));
  await mcp.healthCheck({timeoutMs:2000});
  assert.deepEqual(mcpTransactionOptions,{timeoutMs:2000});
  assert.ok(mcpSql.includes('SET TRANSACTION READ ONLY'));
  assert.ok(mcpSql.includes('SET LOCAL statement_timeout = 2000'));
  assert.deepEqual(mcpSql.at(-1),'SELECT 1');
});

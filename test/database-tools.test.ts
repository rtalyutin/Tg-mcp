import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseTools } from '../src/outreach/database-tools.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';

const permitted = '14a4d6e9-63b0-44ea-9f45-a6237692aef1';
const other = '68c15837-4b5a-47db-8ced-f10aae51e0dc';

test('dynamic PostgreSQL metadata and atomic writes cover new fields, schemas and bounded matches', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  // PGlite speaks PostgreSQL, but exposes affectedRows instead of node-pg's rowCount.
  const query = async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await query('CREATE SCHEMA "some schema"');
  await query('CREATE TABLE "some schema"."items" (id integer PRIMARY KEY, "weird""name" text, payload jsonb)');
  const tools = new DatabaseTools(pool, permitted);
  const list = await tools.readDatabase({schema:'some schema'});
  assert.ok('tables' in list);
  assert.ok(list.tables.some((row: {table: string}) => row.table === 'items'));
  const first = await tools.describeTable({schema:'some schema',table:'items'});
  assert.deepEqual(first.primary_key, ['id']);
  assert.ok(first.columns.some((column: {name: string}) => column.name === 'weird"name'));

  await query('ALTER TABLE "some schema"."items" ADD COLUMN "future field" text');
  const after = await tools.describeTable({schema:'some schema',table:'items'});
  assert.ok(after.columns.some((column: {name: string}) => column.name === 'future field'));
  const all = await tools.readDatabase({schema:'some schema',table:'items'});
  assert.ok('columns' in all);
  assert.ok(all.columns.some((column: {name:string}) => column.name === 'future field'));
  await assert.rejects(tools.readDatabase({table:'items'}), {code:'DATABASE_INPUT_INVALID'});
  const inserted = await tools.writeRows({schema:'some schema',table:'items',operation:'insert',rows:[
    {values:{id:1,'weird"name':'first','future field':'new',payload:{version:1}}},
    {values:{id:2,'weird"name':'second','future field':'newer',payload:{version:2}}}
  ]});
  assert.equal(inserted.affected,2);
  const selected = await tools.readRows({schema:'some schema',table:'items',limit:1});
  assert.equal(selected.has_more,true);
  assert.equal(selected.rows[0]['future field'],'new');
  assert.deepEqual(selected.order_by,['id']);
  assert.equal((await tools.readRows({schema:'some schema',table:'items',where:{id:2}})).rows[0]['weird"name'],'second');

  const replaced = await tools.writeRows({schema:'some schema',table:'items',operation:'upsert',rows:[
    {where:{id:1},values:{'future field':'replaced'}},
    {where:{id:3},values:{'future field':'inserted'}}
  ]});
  assert.equal(replaced.affected,2);
  assert.equal((await tools.readRows({schema:'some schema',table:'items',where:{id:1}})).rows[0]['future field'],'replaced');
  assert.equal((await tools.readRows({schema:'some schema',table:'items',where:{id:3}})).rows[0]['future field'],'inserted');

  await assert.rejects(tools.writeRows({schema:'some schema',table:'items',operation:'update',rows:[
    {where:{id:1},values:{'future field':'must rollback'}},
    {where:{id:999},values:{'future field':'never exists'}}
  ]}), {code:'DATABASE_MATCH_COUNT_CHANGED'});
  assert.equal((await tools.readRows({schema:'some schema',table:'items',where:{id:1}})).rows[0]['future field'],'replaced');
  assert.equal((await tools.writeRows({schema:'some schema',table:'items',operation:'update',rows:[
    {where:{'weird"name':null},values:{'future field':'two rows'},expected_count:1}
  ]})).affected,1);
  await assert.rejects(tools.readRows({schema:'some schema',table:'items";DROP SCHEMA "some schema" CASCADE;--'}),
    {code:'DATABASE_TABLE_NOT_FOUND'});
  await assert.rejects(tools.writeRows({schema:'some schema',table:'items',operation:'update',rows:[
    {where:{},values:{'future field':'unbounded'}}
  ]}));
  assert.equal((await tools.readRows({schema:'some schema',table:'items',columns:['id']})).rows.length,3);
  await query('CREATE TABLE "some schema"."duplicate log" (label text, state text)');
  await tools.writeRows({schema:'some schema',table:'duplicate log',operation:'insert',rows:[
    {values:{label:'same',state:'before'}},{values:{label:'same',state:'before'}}]});
  await assert.rejects(tools.writeRows({schema:'some schema',table:'duplicate log',operation:'update',rows:[
    {where:{label:'same'},values:{state:'wrong'}}
  ]}),{code:'DATABASE_MATCH_COUNT_CHANGED'});
  assert.equal((await tools.writeRows({schema:'some schema',table:'duplicate log',operation:'update',rows:[
    {where:{label:'same'},values:{state:'after'},expected_count:2}
  ]})).affected,2);
  assert.deepEqual((await tools.readRows({schema:'some schema',table:'duplicate log',columns:['state']})).rows,
    [{state:'after'},{state:'after'}]);
  await query('CREATE TABLE "some schema"."defaults only" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY)');
  assert.equal((await tools.writeRows({schema:'some schema',table:'defaults only',operation:'insert',rows:[{values:{}}]})).affected,1);
});

test('generic database tools stay hidden and forbidden for any other MCP login', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const query = async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  await query('CREATE TABLE public.only_owner (id integer PRIMARY KEY)');
  const app = await startLocalOutreach({pool, databaseTools:new DatabaseTools(pool,permitted)});
  t.after(() => app.close());
  app.access.admitIp=async()=>({allowed:true,retryAfter:0});
  app.access.recordAccess=async()=>{};
  app.access.authenticateLogin=async secret=>secret==='!!!!!!!!!!!!!!!!' ? {id:permitted} : secret==='################' ? {id:other} : null;
  const call = async (login: string, method: string, params: object) => {
    const response = await fetch(`${app.url}/mcp?login=${encodeURIComponent(login)}`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return (await response.json()).result;
  };
  const ownList = await call('!!!!!!!!!!!!!!!!','tools/list',{});
  const otherList = await call('################','tools/list',{});
  assert.ok(ownList?.tools, JSON.stringify(ownList));
  assert.deepEqual(ownList.tools.filter((tool:{name:string})=>tool.name==='read_database'||tool.name==='write_database')
    .map((tool:{name:string})=>tool.name), ['read_database','write_database']);
  assert.ok(!otherList.tools.some((tool:{name:string})=>tool.name==='read_database'));
  assert.ok(!otherList.tools.some((tool:{name:string})=>tool.name==='write_database'));
  for (const name of ['read_database','write_database']) {
    const denied = await call('################','tools/call',{name,arguments:{schema:'public',table:'only_owner',operation:'insert',rows:[{values:{id:1}}]}});
    assert.equal(denied.structuredContent.code,'FORBIDDEN');
  }
  const listed = await call('!!!!!!!!!!!!!!!!','tools/call',{name:'read_database',arguments:{}});
  assert.ok(listed.structuredContent.tables.some((row:{table:string})=>row.table==='only_owner'));
  assert.equal(((await query('SELECT count(*)::int AS count FROM public.only_owner')).rows[0] as {count:number}).count,0);
  const allowed = await call('!!!!!!!!!!!!!!!!','tools/call',{name:'write_database',arguments:{schema:'public',table:'only_owner',operation:'insert',rows:[{values:{id:1}}]}});
  assert.equal(allowed.structuredContent.affected,1);
  const read = await call('!!!!!!!!!!!!!!!!','tools/call',{name:'read_database',arguments:{schema:'public',table:'only_owner',where:{id:1}}});
  assert.deepEqual(read.structuredContent.rows,[{id:1}]);
  assert.deepEqual(read.structuredContent.primary_key,['id']);
  const duplicate = await call('!!!!!!!!!!!!!!!!','tools/call',{name:'write_database',arguments:{schema:'public',table:'only_owner',operation:'insert',rows:[{values:{id:1}}]}});
  assert.equal(duplicate.isError,true);
  assert.equal(duplicate.structuredContent.code,'DATABASE_CONSTRAINT_VIOLATION');
});

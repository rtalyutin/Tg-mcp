import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createOwnsiteGateway, ownsiteToolDefinitions } from '../src/ownsite/gateway.ts';
import { seedWorks } from '../src/ownsite/seed-works.ts';

const owner='14a4d6e9-63b0-44ea-9f45-a6237692aef1';
async function fixture(t:test.TestContext) {
  const db=new PGlite();
  t.after(()=>db.close());
  const query=async(sql:string,params?:unknown[])=>{
    const result=await db.query(sql,params);return {...result,rowCount:result.affectedRows ?? result.rows.length};
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const gateway=await createOwnsiteGateway(pool,owner,{phone:undefined,email:undefined});
  return {db,pool,gateway};
}
test('exact public projection, closed hidden states, credentials, and restart preserving editorial changes',async t=>{
  const {db,pool,gateway}=await fixture(t);
  const works=await gateway.publicWorks();
  assert.deepEqual(works.map(w=>w.id),['ycs','dashboard']);
  const ycs=seedWorks[0];
  assert.deepEqual(works[0],{
    id:ycs.id,slug:ycs.slug,title:ycs.title,displayTitle:ycs.display_title,kind:ycs.kind,
    category:ycs.category,status:ycs.status,role:ycs.role,summary:ycs.summary,theme:ycs.theme,
    orientation:ycs.orientation,liveUrl:ycs.live_url,embedAllowed:true,links:JSON.parse(ycs.links_json!),
    poster:ycs.poster,reveal:JSON.parse(ycs.reveal_json),tools:[],featuredOrder:1
  });
  assert.equal('show' in works[0],false);
  assert.equal('catalogueOrder' in works[0],false);
  assert.deepEqual(await gateway.publicContacts(),[
    {label:'Позвонить',href:'tel:+79065253445'},
    {label:'Написать письмо',href:'mailto:info@yarcyberseason.ru'}
  ]);
  assert.deepEqual((await db.query('SELECT key FROM ownsite.site_settings')).rows,[{key:'seed_revision'}]);
  assert.equal((await db.query<{count:number}>(`SELECT count(*)::int AS count FROM ownsite.entity_parameter_values
    WHERE entity_id='public-contacts' AND entity_type='portfolio-contacts'`)).rows[0].count,2);
  for (const w of seedWorks.filter(w=>w.show===0)) assert.equal(await gateway.publicWork(w.slug),null);
  await assert.rejects(gateway.callTool('ownsite_update_work',{id:'ycs',patch:{show:false}},'someone-else'),{code:'OWNSITE_FORBIDDEN'});
  await assert.rejects(gateway.callTool('ownsite_list_works',{},'someone-else'),{code:'OWNSITE_FORBIDDEN'});
  await assert.rejects(gateway.callTool('ownsite_list_works',{schema:'workspace'},owner),{code:'OWNSITE_INPUT_INVALID'});
  const before=await gateway.callTool('ownsite_list_works',{},owner);
  assert.equal((before.works as unknown[]).length,9);
  assert.ok((before.parameters as {key:string}[]).some(p=>p.key==='show'));
  await gateway.callTool('ownsite_update_work',{id:'ycs',patch:{title:'Правка сохранена',show:null}},owner);
  assert.equal(await gateway.publicWork('ycs'),null);
  await gateway.callTool('ownsite_update_work',{id:'dashboard',patch:{show:false}},owner);
  assert.deepEqual(await gateway.publicWorks(),[]);
  await db.query("DELETE FROM ownsite.entity_parameter_values WHERE entity_id='ycs' AND parameter_key='show'");
  assert.equal(await gateway.publicWork('ycs'),null);
  const restarted=await createOwnsiteGateway(pool,owner);
  assert.deepEqual(await restarted.publicWorks(),[]);
  const ownerWorks=(await restarted.callTool('ownsite_list_works',{},owner)).works as {id:string;title:string;show:boolean|null}[];
  assert.equal(ownerWorks.find(w=>w.id==='ycs')?.title,'Правка сохранена');
  assert.equal(ownerWorks.find(w=>w.id==='ycs')?.show,null);
  await db.query(`UPDATE ownsite.entity_parameter_values SET text_value='editorial@example.com'
    WHERE entity_id='public-contacts' AND parameter_key='email'`);
  await createOwnsiteGateway(pool,owner);
  assert.ok((await restarted.publicContacts()).some(c=>c.href==='mailto:editorial@example.com'));
  await db.query(`UPDATE ownsite.entity_parameter_values SET is_null=TRUE,text_value=NULL
    WHERE entity_id='public-contacts' AND parameter_key='phone'`);
  assert.deepEqual(await restarted.publicContacts(),[{label:'Написать письмо',href:'mailto:editorial@example.com'}]);
  await createOwnsiteGateway(pool,owner);
  assert.deepEqual(await restarted.publicContacts(),[{label:'Написать письмо',href:'mailto:editorial@example.com'}]);
  for (const email of ['a@example.com?bcc=hidden@example.net','a@example.com#fragment','a#header@example.com']) {
    await db.query(`UPDATE ownsite.entity_parameter_values SET text_value=$1
      WHERE entity_id='public-contacts' AND parameter_key='email'`,[email]);
    assert.deepEqual(await restarted.publicContacts(),[]);
    await assert.rejects(createOwnsiteGateway(pool,owner,{email}),{code:'OWNSITE_CONTACTS_INVALID'});
  }
  await restarted.callTool('ownsite_update_work',{id:'ycs',patch:{show:true}},owner);
  assert.equal((await restarted.publicWorks())[0].title,'Правка сохранена');
});
test('database constraints reject mismatched constructor types, multiple scalars, null required fields and duplicate values',async t=>{
  const {db}=await fixture(t);
  await assert.rejects(db.query(`UPDATE ownsite.entity_parameter_values SET data_type='text',text_value='true',boolean_value=NULL
    WHERE entity_id='ycs' AND parameter_key='show'`));
  await assert.rejects(db.query(`UPDATE ownsite.entity_parameter_values SET text_value='extra'
    WHERE entity_id='ycs' AND parameter_key='show'`));
  await assert.rejects(db.query(`UPDATE ownsite.entity_parameter_values SET is_null=TRUE,text_value=NULL
    WHERE entity_id='ycs' AND parameter_key='title'`));
  await assert.rejects(db.query(`INSERT INTO ownsite.entity_parameter_values
    SELECT * FROM ownsite.entity_parameter_values WHERE entity_id='ycs' AND parameter_key='title'`));
  await db.query("INSERT INTO ownsite.entity_types(id,title) VALUES ('private','private')");
  await db.query("INSERT INTO ownsite.entities(id,entity_type,slug) VALUES ('secret','private','secret')");
  await assert.rejects(db.query(`INSERT INTO ownsite.entity_parameter_values
    (entity_id,entity_type,parameter_key,data_type,text_value) VALUES ('secret','portfolio-work','title','text','leak')`));
  await assert.rejects(db.query(`UPDATE ownsite.entity_parameter_values SET json_value='{}'::jsonb
    WHERE entity_id='ycs' AND parameter_key='links'`));
});
test('partial patches are validated atomically and safe DTO rejects untrusted nested data',async t=>{
  const {db,gateway}=await fixture(t);
  for (const patch of [{show:1},{title:'x',show:'true'},{links:[{label:'X',href:'javascript:alert(1)'}]},
    {links:[{label:'X',href:'https://example.com',secret:'hidden'}]}, {privateWorkspace:'secret'}, {},
    {tools:[{label:'X',href:'https://example.com',secret:'hidden'}]}])
    await assert.rejects(gateway.callTool('ownsite_update_work',{id:'ycs',patch},owner),{code:'OWNSITE_INPUT_INVALID'});
  assert.equal((await gateway.publicWork('ycs'))?.title,'ЯрКиберСезон');
  await assert.rejects(gateway.callTool('ownsite_update_work',{id:'ycs',patch:{title:'atomic',slug:'dashboard'}},owner));
  assert.equal((await gateway.publicWork('ycs'))?.title,'ЯрКиберСезон');
  await db.query("INSERT INTO ownsite.entity_parameters(entity_type,key,data_type,title) VALUES ('portfolio-work','private_note','text','private')");
  await db.query(`INSERT INTO ownsite.entity_parameter_values(entity_id,entity_type,parameter_key,data_type,text_value)
    VALUES ('ycs','portfolio-work','private_note','text','DO_NOT_EXPOSE')`);
  assert.ok(!JSON.stringify(await gateway.publicWorks()).includes('DO_NOT_EXPOSE'));
  await db.query(`UPDATE ownsite.entity_parameter_values SET json_value='[{"label":"X","href":"https://example.com","secret":"DO_NOT_EXPOSE"}]'::jsonb
    WHERE entity_id='ycs' AND parameter_key='links'`);
  await assert.rejects(gateway.publicWorks());
});
test('HTTP surface permits only declared reads, HEAD semantics, ready status and fails without private errors',async t=>{
  const {db,gateway}=await fixture(t);
  const server=createServer(async(req,res)=>{if(!await gateway.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const get=await fetch(`${url}/ownsite/api/works`);
  assert.equal(get.status,200);assert.equal(get.headers.get('access-control-allow-origin'),null);
  assert.equal(get.headers.get('cache-control'),'no-store');
  assert.equal((await get.json()).length,2);
  assert.equal((await fetch(`${url}/ownsite/api/works/booking`)).status,404);
  assert.equal((await fetch(`${url}/ownsite/api/works/%2Fworkspace`)).status,404);
  assert.equal((await fetch(`${url}/ownsite/api/works?show=false`)).status,400);
  assert.equal((await fetch(`${url}/ownsite/api/works`,{method:'POST',body:'{}'})).status,405);
  assert.equal((await fetch(`${url}/ownsite/api/private`)).status,404);
  const head=await fetch(`${url}/ownsite/api/works`,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.deepEqual(await (await fetch(`${url}/ownsite/readyz`)).json(),{status:'OK'});
  await db.query('DROP SCHEMA ownsite CASCADE');
  const failure=await fetch(`${url}/ownsite/api/works`);
  assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{error:'OWNSITE_UNAVAILABLE'});
  assert.equal((await fetch(`${url}/ownsite/readyz`)).status,503);
  assert.ok(ownsiteToolDefinitions.every(d=>d.inputSchema.additionalProperties===false));
});

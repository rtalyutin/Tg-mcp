import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {registryMigrationSql,RegistryError} from '../src/outreach/registry.ts';
import {mailMigrationSql} from '../src/outreach/mail-schema.ts';
import {MailService} from '../src/outreach/mail.ts';
import {MailTransferError,renderMimeMessage,type MailTransport,type OutboundMail} from '../src/outreach/smtp.ts';
import {readTestMailConfig} from '../src/outreach/config.ts';

const config=readTestMailConfig({MAIL_TRANSPORT_ENABLED:'true',MAIL_SMTP_HOST:'smtp.timeweb.ru',MAIL_SMTP_PORT:'587',
  MAIL_FROM:'info@ycs.bar',MAIL_SMTP_PASSWORD:'local fake credential',MAIL_TEST_RECIPIENTS:'r.talyutin@gmail.com',
  MAIL_DAILY_LIMIT:'1',MAIL_WINDOW_START:'10:00',MAIL_WINDOW_END:'14:00',MAIL_TIMEZONE:'UTC'})!;
const clock=()=>new Date('2026-09-24T12:00:00Z');
const err=(code:string)=>(error:unknown)=>error instanceof RegistryError && error.code===code;
const fake=(send:(mail:OutboundMail)=>Promise<number>):MailTransport=>({probe:async()=>{},send});
const draft=(opportunity_id:string,extra:Record<string,unknown>={})=>({
  opportunity_id,from:'info@ycs.bar',reply_to:'info@ycs.bar',to:'r.talyutin@gmail.com',
  subject:'Проверка почтового маршрута',body:'Контрольное письмо, без рекламы.',basis:'self_test',request_id:randomUUID(),...extra});
const owner='owner:local';

test('mail configuration fails closed and MIME escapes untrusted headers',()=>{
  assert.equal(readTestMailConfig({}),null);
  assert.throws(()=>readTestMailConfig({...config,MAIL_TRANSPORT_ENABLED:'true'} as never));
  assert.throws(()=>readTestMailConfig({MAIL_TRANSPORT_ENABLED:'true',MAIL_SMTP_HOST:'smtp.timeweb.ru',MAIL_SMTP_PORT:'587',
    MAIL_FROM:'info@ycs.bar',MAIL_SMTP_PASSWORD:'hidden',MAIL_TEST_RECIPIENTS:'someone@example.org',MAIL_DAILY_LIMIT:'1',
    MAIL_WINDOW_START:'10:00',MAIL_WINDOW_END:'14:00',MAIL_TIMEZONE:'UTC'}));
  const content=renderMimeMessage({from:'info@ycs.bar',to:'r.talyutin@gmail.com',replyTo:'info@ycs.bar',
    subject:'Привет',body:'Строка\nсодержимое',messageId:'123@ycs.bar'});
  assert.match(content,/Subject: =\?UTF-8\?B\?/);
  assert.match(content,/Content-Transfer-Encoding: base64/);
  assert.ok(!content.includes('Строка'));
  assert.throws(()=>renderMimeMessage({from:'info@ycs.bar\r\nBcc: bad@example.org',to:'r.talyutin@gmail.com',
    replyTo:'info@ycs.bar',subject:'test',body:'test',messageId:'123@ycs.bar'}),/INVALID_HEADER/);
});

test('outgoing mail uses PostgreSQL approvals, a bounded worker and no retry after uncertainty',
  {skip:!process.env.OUTREACH_TEST_DATABASE_URL},async t=>{
  const pool=new Pool({connectionString:process.env.OUTREACH_TEST_DATABASE_URL,max:12});
  t.after(()=>pool.end());
  await pool.query(registryMigrationSql); await pool.query(mailMigrationSql);
  async function setup() {
    await pool.query('TRUNCATE outreach_companies CASCADE');
    await pool.query('TRUNCATE outreach_mail_operations');
    await pool.query('TRUNCATE outreach_mail_suppressions');
    await pool.query('UPDATE outreach_mail_settings SET paused=false');
    const company=randomUUID(), opportunity=randomUUID();
    await pool.query(`INSERT INTO outreach_companies(id,name,normalized_name,rationale,sources)
      VALUES($1,'Local test','local test','mail smoke','[]')`,[company]);
    await pool.query(`INSERT INTO outreach_opportunities(id,company_id,subject,sources,rationale)
      VALUES($1,$2,'Test mail','[]','controlled test')`,[opportunity,company]);
    return opportunity;
  }
  async function prepared(service:MailService, opportunity:string) {
    const input=draft(opportunity);
    const result=await service.saveDraft(input,'mcp:assistant');
    assert.deepEqual(await service.saveDraft(input,'mcp:assistant'),result);
    const submit={proposal_id:result.proposal_id,expected_version:1,request_id:randomUUID()};
    await service.submit(submit,'mcp:assistant');
    const approval={...submit,content_hash:result.content_hash,request_id:randomUUID()};
    await assert.rejects(service.approve(approval,'mcp:assistant'),err('FORBIDDEN'));
    await service.approve(approval,owner);
    return {...approval,request_id:randomUUID()};
  }
  await t.test('wrong recipient is blocked before transport despite an owner approval',async()=>{
    const opportunity=await setup(); let sends=0;
    const service=new MailService(pool,config,fake(async()=>{sends++;return 250;}),clock);
    const other=draft(opportunity,{to:'someone@example.org'});
    const saved=await service.saveDraft(other,'mcp:assistant');
    await service.submit({proposal_id:saved.proposal_id,expected_version:1,request_id:randomUUID()},'mcp:assistant');
    await service.approve({proposal_id:saved.proposal_id,expected_version:1,content_hash:saved.content_hash,request_id:randomUUID()},owner);
    await assert.rejects(service.queue({proposal_id:saved.proposal_id,expected_version:1,content_hash:saved.content_hash,request_id:randomUUID()},owner),err('MAIL_DESTINATION_DENIED'));
    await service.tick(); assert.equal(sends,0);
  });
  await t.test('editing a queued proposal cancels its old job and approval atomically',async()=>{
    const opportunity=await setup();let sends=0;
    const service=new MailService(pool,config,fake(async()=>{sends++;return 250;}),clock);
    const input=await prepared(service,opportunity);
    await service.queue(input,owner);
    const edited=await service.saveDraft(draft(opportunity,{proposal_id:input.proposal_id,expected_version:1,body:'Новый проверочный текст.'}),'mcp:assistant');
    assert.equal(edited.version,2);
    const details=await service.detail(String(input.proposal_id));
    assert.equal(details.jobs[0].status,'cancelled');assert.ok(details.approvals[0].revoked_at);
    await service.tick();assert.equal(sends,0);
    await assert.rejects(service.queue({...input,request_id:randomUUID()},owner),err('VERSION_CONFLICT'));
  });
  await t.test('two instances claim one message; SMTP acceptance is not recipient delivery',async()=>{
    const opportunity=await setup();let sends=0;let unblock!:()=>void;
    const gate=new Promise<void>(resolve=>{unblock=resolve;});
    const smtp=fake(async()=>{sends++;await gate;return 250;});
    const a=new MailService(pool,config,smtp,clock), b=new MailService(pool,config,smtp,clock);
    const input=await prepared(a,opportunity);
    const queued=await a.queue(input,owner);
    assert.deepEqual(await a.queue(input,owner),queued);
    const running=a.tick();
    for (let n=0;n<100 && sends===0;n++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(sends,1);
    await b.tick();await b.recoverStale(); assert.equal(sends,1);
    assert.equal((await a.detail(String(input.proposal_id))).jobs[0].status,'sending');
    unblock();await running;
    const finished=(await a.detail(String(input.proposal_id))).jobs[0];
    assert.equal(finished.status,'sent');assert.equal(finished.smtp_code,250);
    assert.equal(finished.message_id,queued.message_id);
    assert.equal((await pool.query('SELECT status FROM outreach_opportunities WHERE id=$1',[opportunity])).rows[0].status,'awaiting_reply');
    await b.tick(); assert.equal(sends,1);
  });
  await t.test('lost SMTP result remains unknown across instances and explicit closure never retries',async()=>{
    const opportunity=await setup();let sends=0;
    const smtp=fake(async()=>{sends++;throw new MailTransferError('SMTP_RESULT_UNKNOWN',true);});
    const a=new MailService(pool,config,smtp,clock),b=new MailService(pool,config,smtp,clock);
    const input=await prepared(a,opportunity);await a.queue(input,owner);
    await a.tick();await b.tick();
    const details=await a.detail(String(input.proposal_id));
    assert.equal(sends,1);assert.equal(details.jobs[0].status,'unknown');
    await a.closeUnknown({proposal_id:input.proposal_id,note:'Проверено вручную; доказательств нет',request_id:randomUUID()},owner);
    await b.tick();assert.equal(sends,1);
    assert.equal((await b.detail(String(input.proposal_id))).jobs[0].resolution,'closed_without_retry');
  });
  await t.test('a stale sending claim becomes unknown without network replay',async()=>{
    const opportunity=await setup();let sends=0;let unblock!:()=>void;
    const gate=new Promise<void>(resolve=>{unblock=resolve;});
    const smtp=fake(async()=>{sends++;await gate;return 250;});
    const a=new MailService(pool,config,smtp,clock),b=new MailService(pool,config,smtp,clock);
    const input=await prepared(a,opportunity);await a.queue(input,owner);
    const running=a.tick();
    for (let n=0;n<100 && sends===0;n++) await new Promise(resolve=>setTimeout(resolve,10));
    await pool.query("UPDATE outreach_mail_jobs SET attempt_started_at=now()-interval '6 minutes' WHERE status='sending'");
    await b.tick();
    assert.equal((await b.detail(String(input.proposal_id))).jobs[0].status,'unknown');
    unblock();await running;assert.equal(sends,1);
    assert.equal((await b.detail(String(input.proposal_id))).jobs[0].status,'unknown');
  });
  await t.test('global pause, suppression and disabled transport fail closed',async()=>{
    const opportunity=await setup();let sends=0;
    const a=new MailService(pool,config,fake(async()=>{sends++;return 250;}),clock);
    const input=await prepared(a,opportunity);
    await a.pause({paused:true,request_id:randomUUID()},owner);
    await assert.rejects(a.queue(input,owner),err('MAIL_PAUSED'));
    await a.pause({paused:false,request_id:randomUUID()},owner);
    await a.suppress({email:'r.talyutin@gmail.com',reason:'Local test stop',request_id:randomUUID()},owner);
    await assert.rejects(a.queue({...input,request_id:randomUUID()},owner),err('CONTACT_SUPPRESSED'));
    assert.equal(sends,0);
    const disabled=new MailService(pool,null,undefined,clock);
    assert.deepEqual(await disabled.probe(owner).catch((error:RegistryError)=>error.code),'MAIL_DISABLED');
    await disabled.tick();assert.equal(sends,0);
  });
  await t.test('a queued message is stopped by a later pause or suppression',async()=>{
    const opportunity=await setup();let sends=0;
    const a=new MailService(pool,config,fake(async()=>{sends++;return 250;}),clock);
    const input=await prepared(a,opportunity);await a.queue(input,owner);
    await a.pause({paused:true,request_id:randomUUID()},owner);
    await a.tick();assert.equal(sends,0);
    await a.pause({paused:false,request_id:randomUUID()},owner);
    await a.suppress({email:'r.talyutin@gmail.com',reason:'Stopped after approval',request_id:randomUUID()},owner);
    await a.tick();assert.equal(sends,0);
    assert.equal((await a.detail(String(input.proposal_id))).jobs[0].status,'cancelled');
  });
  await t.test('one attempted send per local day, and no transmission outside the owner window',async()=>{
    const first=await setup();let sends=0;
    const smtp=fake(async()=>{sends++;return 250;});
    const a=new MailService(pool,config,smtp,clock);
    await a.queue(await prepared(a,first),owner);
    const second=randomUUID();
    const company=(await pool.query('SELECT id FROM outreach_companies LIMIT 1')).rows[0].id;
    await pool.query("INSERT INTO outreach_opportunities(id,company_id,subject,sources,rationale) VALUES($1,$2,'Second test','[]','controlled')",[second,company]);
    await a.queue(await prepared(a,second),owner);
    const outside=new MailService(pool,config,smtp,()=>new Date('2026-09-24T02:00:00Z'));
    await outside.tick();assert.equal(sends,0);
    await a.tick();await a.tick();assert.equal(sends,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM outreach_mail_jobs WHERE status='queued'")).rows[0].n,1);
  });
});

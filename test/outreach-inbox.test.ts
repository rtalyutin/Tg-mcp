import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImapFlow } from 'imapflow';
import { referencedOutbound,scanInboxOnce,type ImportedReply } from '../src/outreach/relay-inbox.ts';
import { mailSections } from '../src/outreach/mail-ui.ts';

test('only In-Reply-To or References headers link a message to an outgoing job',()=>{
  const id=`${randomUUID()}@ycs.bar`;
  assert.equal(referencedOutbound(`In-Reply-To: <${id}>\r\n`),id);
  assert.equal(referencedOutbound(`References: <other@example.test> <${id}>\r\n`),id);
  assert.equal(referencedOutbound(`Subject: <${id}>\r\n`),null);
  assert.equal(referencedOutbound(`From: <${id}>\r\n`),null);
});

test('IMAP scanner keeps the mailbox read-only and retries unacknowledged replies after restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ycs-inbox-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id=`${randomUUID()}@ycs.bar`;
  const envelope=(from:string)=>({from:[{address:from}],to:[{address:'info@ycs.bar'}],
    messageId:'<reply@example.test>',subject:'Ответ',inReplyTo:`<${id}>`});
  const mime=`From: Test <r.talyutin@gmail.com>\r\nTo: info@ycs.bar\r\nSubject: Ответ\r\nIn-Reply-To: <${id}>\r\nMessage-ID: <reply@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nТекст ответа`;
  let sources=0,validity=11n;
  function fake():ImapFlow {
    return {mailbox:{uidValidity:validity,uidNext:4},
      connect:async()=>{},logout:async()=>{},
      getMailboxLock:async(_path:string,options:{readOnly?:boolean})=>{
        assert.equal(options.readOnly,true);return {release:()=>{}};
      },
      search:async()=>[1,2,3],
      fetchOne:async (uid:number,query:Record<string,unknown>)=>{
        if (query.source) {sources++;return {source:Buffer.from(mime)};}
        if (uid===1) return {envelope:envelope('unrelated@example.test'),
          headers:Buffer.from(`In-Reply-To: <${id}>`),size:100,internalDate:new Date()};
        if (uid===2) return {envelope:{...envelope('r.talyutin@gmail.com'),inReplyTo:undefined},
          headers:Buffer.from('Subject: no link'),size:100,internalDate:new Date()};
        return {envelope:envelope('r.talyutin@gmail.com'),
          headers:Buffer.from(`In-Reply-To: <${id}>`),size:Buffer.byteLength(mime),internalDate:new Date()};
      },
    } as unknown as ImapFlow;
  }
  let attempts=0;const delivered:ImportedReply[]=[];
  await assert.rejects(scanInboxOnce(fake(),dir,async reply=>{attempts++;delivered.push(reply);throw new Error('lost response');}));
  assert.equal(JSON.parse(await readFile(join(dir,'inbox-cursor.json'),'utf8')).uid,2);
  await scanInboxOnce(fake(),dir,async reply=>{attempts++;delivered.push(reply);});
  await scanInboxOnce(fake(),dir,async()=>{throw new Error('unexpected duplicate');});
  assert.equal(attempts,2);assert.equal(sources,2);
  assert.equal(delivered[0].reference_message_id,id);
  assert.equal(delivered[0].body,'Текст ответа');
  assert.equal(delivered[0].imap_uid,3);
  validity=12n;
  await scanInboxOnce(fake(),dir,async()=>{});
  assert.equal(JSON.parse(await readFile(join(dir,'inbox-cursor.json'),'utf8')).uid_validity,'12');
});

test('reply in the existing card is escaped and associated with its job',()=>{
  const job=randomUUID();
  const html=mailSections([{id:randomUUID(),subject:'Проверка'}],[]);
  assert.ok(!html.includes('<script>'));
  const opportunity=randomUUID(),proposal=randomUUID();
  const page=mailSections([{id:opportunity,subject:'Проверка'}],[{opportunity_id:opportunity,
    proposal:{id:proposal,state:'approved',current_version:1},versions:[{version:1,subject:'Test',content_hash:'hash',from_email:'info@ycs.bar',to_email:'r.talyutin@gmail.com',reply_to:'info@ycs.bar',body:'Outgoing'}],
    approvals:[],jobs:[{id:job,status:'sent',message_id:'outgoing@ycs.bar'}],
    replies:[{job_id:job,subject:'<script>alert(1)</script>',body:'<img src=x onerror=alert(1)>',
      from_email:'r.talyutin@gmail.com',received_at:new Date().toISOString()}],
    events:[],mail_enabled:true,paused:false}]);
  assert.match(page,/Ответы \(1\)/);
  assert.match(page,/Исходящее письмо:[\s\S]*outgoing@ycs\.bar/);
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!page.includes('<img src=x'));
});

test('earlier job replies remain linked and visible after a later job is added',()=>{
  const opportunity=randomUUID(),earlier=randomUUID(),later=randomUUID();
  const page=mailSections([{id:opportunity,subject:'Проверка'}],[{opportunity_id:opportunity,
    proposal:{id:randomUUID(),state:'approved',current_version:2},
    versions:[{version:2,subject:'Второе письмо',content_hash:'second',body:'New'},
      {version:1,subject:'Первое письмо',content_hash:'first',body:'Old'}],
    approvals:[],jobs:[{id:later,version:2,status:'sent',message_id:'later@ycs.bar'},
      {id:earlier,version:1,status:'sent',message_id:'earlier@ycs.bar'}],
    replies:[{job_id:earlier,subject:'Ответ на первое',body:'Да, получил',from_email:'r.talyutin@gmail.com',
      received_at:new Date().toISOString(),received_message_id:'reply@example.test'}],
    events:[],mail_enabled:true,paused:false}]);
  assert.match(page,/Ответы \(1\)/);
  assert.match(page,/Первое письмо[\s\S]*earlier@ycs\.bar[\s\S]*Ответ на первое/);
  assert.ok(!page.includes('Второе письмо · later@ycs.bar'));
});

test('expanded JSON body remains within the app request limit',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ycs-inbox-body-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id=`${randomUUID()}@ycs.bar`;
  const mime=`From: r.talyutin@gmail.com\r\nTo: info@ycs.bar\r\nIn-Reply-To: <${id}>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${'\u0001'.repeat(20_000)}`;
  const client={mailbox:{uidValidity:13n,uidNext:2},connect:async()=>{},logout:async()=>{},
    getMailboxLock:async()=>({release:()=>{}}),search:async()=>[1],
    fetchOne:async (_uid:number,query:Record<string,unknown>)=>query.source?{source:Buffer.from(mime)}:
      {envelope:{from:[{address:'r.talyutin@gmail.com'}],to:[{address:'info@ycs.bar'}]},
        headers:Buffer.from(`In-Reply-To: <${id}>`),size:Buffer.byteLength(mime),internalDate:new Date()},
  } as unknown as ImapFlow;
  await scanInboxOnce(client,dir,async reply=>{
    assert.ok(Buffer.byteLength(JSON.stringify(reply))<=60_000);
    assert.equal(reply.truncated,true);
    assert.ok(reply.body.length>0);
    assert.ok(reply.body.length<20_000);
  });
});

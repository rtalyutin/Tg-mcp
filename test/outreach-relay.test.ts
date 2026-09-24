import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readTestMailConfig, type RelayMailConfig } from '../src/outreach/config.ts';
import { RelayMailTransport } from '../src/outreach/relay-client.ts';
import { createRelayServer } from '../src/outreach/relay-server.ts';
import { MailTransferError, type MailTransport, type OutboundMail } from '../src/outreach/smtp.ts';

const token='a'.repeat(64);
const mail=():OutboundMail=>({from:'info@ycs.bar',replyTo:'info@ycs.bar',to:'r.talyutin@gmail.com',
  subject:'Проверка',body:'Тестовый текст',messageId:`${randomUUID()}@ycs.bar`});

test('relay configuration uses HTTPS and never requires the mailbox password in the app',()=>{
  assert.deepEqual(readTestMailConfig({MAIL_TRANSPORT_ENABLED:'true',MAIL_RELAY_ORIGIN:'https://relay.example.org',
    MAIL_RELAY_TOKEN:token}),{transport:'relay',origin:'https://relay.example.org',token,port:465,
    username:'info@ycs.bar',recipient:'r.talyutin@gmail.com'});
  for (const extra of [
    {MAIL_RELAY_ORIGIN:'http://relay.example.org'},
    {MAIL_RELAY_TOKEN:'short'},
    {MAIL_SMTP_PORT:'587'},
  ]) assert.throws(()=>readTestMailConfig({MAIL_TRANSPORT_ENABLED:'true',MAIL_RELAY_ORIGIN:'https://relay.example.org',
    MAIL_RELAY_TOKEN:token,...extra}));
});

test('VDS relay authenticates, restricts destination and saves each result before acknowledging',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ycs-mail-relay-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let sends=0,probes=0;
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const smtp:MailTransport={probe:async()=>{probes++;},send:async()=>{sends++;await gate;return 250;}};
  const server=createRelayServer(token,directory,smtp);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();
  if (!address || typeof address==='string') throw new Error('Missing local server address');
  const origin=`http://127.0.0.1:${address.port}`;
  const config:RelayMailConfig={transport:'relay',origin,token,port:465,
    username:'info@ycs.bar',recipient:'r.talyutin@gmail.com'};
  const client=new RelayMailTransport(config);
  await client.probe(); assert.equal(probes,1);assert.equal(sends,0);
  const message=mail();
  const unauth=await fetch(`${origin}/v1/send`,{method:'POST',body:JSON.stringify(message)});
  assert.equal(unauth.status,401);
  const wrong=await fetch(`${origin}/v1/send`,{method:'POST',headers:{Authorization:`Bearer ${token}`},
    body:JSON.stringify({...message,to:'stranger@example.org'})});
  assert.equal(wrong.status,400);assert.equal(sends,0);
  const active=client.send(message);
  for (let n=0;n<100 && sends===0;n++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(sends,1);
  await assert.rejects(client.send(message),(error:unknown)=>error instanceof MailTransferError && error.uncertain);
  release();assert.equal(await active,250);
  assert.equal(await client.send(message),250);assert.equal(sends,1);
  const stored=JSON.parse(await readFile(join(directory,`${message.messageId.slice(0,36)}.json`),'utf8')) as {status:string};
  assert.equal(stored.status,'sent');
  await assert.rejects(client.send({...message,body:'Изменено'}),
    (error:unknown)=>error instanceof MailTransferError && error.code==='RELAY_MESSAGE_CONFLICT');
  assert.equal(sends,1);
  const lost=new RelayMailTransport(config,async (url,init)=>{
    await fetch(url,init);
    throw new Error('Response lost after SMTP acceptance');
  });
  await assert.rejects(lost.send(message),(error:unknown)=>error instanceof MailTransferError && error.uncertain);
  assert.equal(sends,1);
});

test('SMTP uncertainty is durable; replay and process restart do not send again',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ycs-mail-relay-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let sends=0;
  const smtp:MailTransport={probe:async()=>{},send:async()=>{sends++;throw new MailTransferError('SMTP_RESULT_UNKNOWN',true);}};
  const message=mail();
  async function run() {
    const server=createRelayServer(token,directory,smtp);
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('Missing local server address');
    const client=new RelayMailTransport({transport:'relay',origin:`http://127.0.0.1:${address.port}`,
      token,port:465,username:'info@ycs.bar',recipient:'r.talyutin@gmail.com'});
    return {server,client};
  }
  const first=await run();
  await assert.rejects(first.client.send(message),(error:unknown)=>error instanceof MailTransferError && error.uncertain);
  await new Promise<void>(resolve=>first.server.close(()=>resolve()));
  const second=await run();
  t.after(()=>new Promise<void>(resolve=>second.server.close(()=>resolve())));
  await assert.rejects(second.client.send(message),(error:unknown)=>error instanceof MailTransferError && error.uncertain);
  assert.equal(sends,1);
});

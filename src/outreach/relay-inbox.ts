import { randomUUID } from 'node:crypto';
import { open,readFile,rename,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { z } from 'zod';

const cursorSchema=z.strictObject({uid_validity:z.string().regex(/^[0-9]{1,20}$/),uid:z.number().int().min(0).max(4294967295)});
type Cursor=z.infer<typeof cursorSchema>;
const reference=/<([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}@ycs\.bar)>/g;
const expectedFrom='r.talyutin@gmail.com', expectedTo='info@ycs.bar';
export interface ImportedReply {
  uid_validity:string;imap_uid:number;reference_message_id:string;
  received_message_id?:string;from:typeof expectedFrom;to:typeof expectedTo;
  subject:string;body:string;truncated:boolean;received_at:string;
}

/** Only mail which explicitly references one of our outgoing Message-IDs is eligible. */
export function referencedOutbound(headers:Buffer|string,inReplyTo?:string|null):string|null {
  const raw=String(headers);
  const unfolded=raw.replace(/\r?\n[ \t]+/g,' ');
  const replyLine=/^in-reply-to:[ \t]*(.*)$/im.exec(unfolded)?.[1] ?? inReplyTo ?? '';
  const direct=[...replyLine.matchAll(reference)].at(-1)?.[1];
  if (direct) return direct.toLowerCase();
  const refs=/^references:[ \t]*(.*)$/im.exec(unfolded)?.[1] ?? '';
  return [...refs.matchAll(reference)].at(-1)?.[1]?.toLowerCase() ?? null;
}
function mailboxAddress(value:unknown):string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(x=>typeof x?.address==='string'?[x.address.toLowerCase()]:[]);
}
function sourceId(value:unknown):string|undefined {
  if (typeof value!=='string') return;
  const id=value.trim().replace(/^<|>$/g,'');
  return id.length>=1 && id.length<=320 && !/[\r\n\0]/.test(id) ? id : undefined;
}
async function loadCursor(directory:string):Promise<Cursor|null> {
  try { return cursorSchema.parse(JSON.parse(await readFile(join(directory,'inbox-cursor.json'),'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error; }
}
async function saveCursor(directory:string,value:Cursor) {
  const path=join(directory,'inbox-cursor.json');
  const temp=join(directory,`${randomUUID()}.cursor.tmp`);
  try {
    const file=await open(temp,'wx',0o600);
    try { await file.writeFile(JSON.stringify(value));await file.sync(); }
    finally { await file.close(); }
    await rename(temp,path);
    const folder=await open(directory,'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await unlink(temp).catch(()=>{}); }
}

/** A missing delivery acknowledgement keeps the UID uncommitted. The app deduplicates repeats. */
export async function scanInboxOnce(client:ImapFlow,directory:string,deliver:(reply:ImportedReply)=>Promise<void>) {
  await client.connect();
  try {
    const lock=await client.getMailboxLock('INBOX',{readOnly:true});
    try {
      const mailbox=client.mailbox;
      if (!mailbox || !mailbox.uidNext || !mailbox.uidValidity) throw new Error('IMAP_MAILBOX_UNAVAILABLE');
      const validity=mailbox.uidValidity.toString();
      const previous=await loadCursor(directory);
      let last=previous?.uid_validity===validity?previous.uid:0;
      const upper=mailbox.uidNext-1;
      if (last>=upper) return;
      const found=await client.search({uid:`${last+1}:${upper}`,from:expectedFrom,to:expectedTo},{uid:true});
      if (!Array.isArray(found)) throw new Error('IMAP_SEARCH_UNAVAILABLE');
      const selected=found.filter(uid=>uid>last&&uid<=upper).sort((a,b)=>a-b).slice(0,100);
      for (const uid of selected) {
        const header=await client.fetchOne(uid,{uid:true,envelope:true,headers:['In-Reply-To','References','Message-ID'],size:true,internalDate:true},{uid:true});
        if (header && mailboxAddress(header.envelope?.from).includes(expectedFrom) &&
            mailboxAddress(header.envelope?.to).includes(expectedTo)) {
          const parent=referencedOutbound(header.headers??'',header.envelope?.inReplyTo);
          if (parent) {
            const full=header.size!==undefined && header.size<=2_000_000
              ? await client.fetchOne(uid,{source:true},{uid:true}) : false;
            if (header.size!==undefined && header.size<=2_000_000 && (!full || !full.source))
              throw new Error('IMAP_SOURCE_UNAVAILABLE');
            const parsed=full && full.source ? await simpleParser(full.source) : null;
            if (!parsed || (mailboxAddress(parsed.from?.value).includes(expectedFrom) &&
                mailboxAddress(Array.isArray(parsed.to)?parsed.to.flatMap(x=>x.value):parsed.to?.value).includes(expectedTo))) {
              const text=parsed?.text??'';
              const receivedId=sourceId(parsed?.messageId??header.envelope?.messageId);
              const reply:ImportedReply={uid_validity:validity,imap_uid:uid,reference_message_id:parent,
                ...(receivedId?{received_message_id:receivedId}:{}),
                from:expectedFrom,to:expectedTo,subject:(parsed?.subject??header.envelope?.subject??'').slice(0,300),
                body:text.slice(0,20_000),truncated:!parsed || text.length>20_000 || (parsed.attachments.length>0),
                received_at:new Date(header.internalDate??parsed?.date??Date.now()).toISOString()};
              // The app accepts at most 64 KiB of JSON; escaping and UTF-8 can expand 20,000 characters.
              if (Buffer.byteLength(JSON.stringify(reply))>60_000) {
                let low=0,high=reply.body.length;
                while (low<high) {
                  const middle=Math.ceil((low+high)/2);
                  if (Buffer.byteLength(JSON.stringify({...reply,body:reply.body.slice(0,middle),truncated:true}))<=60_000)
                    low=middle;
                  else high=middle-1;
                }
                reply.body=reply.body.slice(0,low);
                reply.truncated=true;
              }
              await deliver(reply);
            }
          }
        }
        last=uid;
        await saveCursor(directory,{uid_validity:validity,uid:last});
      }
      if (selected.length<100 && last<upper) await saveCursor(directory,{uid_validity:validity,uid:upper});
    } finally { lock.release(); }
  } finally { await client.logout().catch(()=>{}); }
}

export function startInboxPoller(config:{directory:string;password:string;appOrigin:string;token:string},
  createClient:()=>ImapFlow=()=>new ImapFlow({host:'imap.timeweb.ru',port:993,secure:true,
    tls:{servername:'imap.timeweb.ru',rejectUnauthorized:true,minVersion:'TLSv1.2'},
    auth:{user:'info@ycs.bar',pass:config.password},
    logger:false,connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:30_000,
    maxLiteralSize:2_100_000,maxResponseSize:2_200_000,maxLineLength:65_536,disableAutoIdle:true})) {
  let running=false,active:Promise<void>|null=null,stopped=false,lastWarning=0;
  async function deliver(reply:ImportedReply) {
    const response=await fetch(`${config.appOrigin}/internal/mail/reply`,{
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},
      body:JSON.stringify(reply),signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('APP_REPLY_DELIVERY_FAILED');
    const answer=z.strictObject({linked:z.boolean(),duplicate:z.boolean().optional()}).parse(await response.json());
    if (!answer.linked) return; // Unmatched references never create an unrelated card.
  }
  function wake() {
    if (running || stopped) return;
    running=true;
    const client=createClient();
    client.on('error',()=>{}); // ImapFlow reports connection errors through both events and awaited calls.
    active=scanInboxOnce(client,config.directory,deliver).catch(()=>{
      if (Date.now()-lastWarning>60_000) {lastWarning=Date.now();console.error('MAIL_INBOX_POLL_FAILED');}
    }).finally(()=>{running=false;active=null;});
  }
  const timer=setInterval(wake,15_000);
  wake();
  return async()=>{stopped=true;clearInterval(timer);await active;};
}

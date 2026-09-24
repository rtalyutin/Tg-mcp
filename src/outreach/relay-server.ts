import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MailTransferError, type MailTransport, type OutboundMail } from './smtp.ts';

const mailSchema = z.strictObject({
  from:z.literal('info@ycs.bar'),replyTo:z.literal('info@ycs.bar'),
  to:z.literal('r.talyutin@gmail.com'),
  subject:z.string().min(1).max(300),body:z.string().min(1).max(20_000),
  messageId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@ycs\.bar$/),
});
type RecordState = {digest:string;status:'sending'|'sent'|'failed'|'unknown';smtp_code?:number;code?:string};
type Result = {status:'sent';smtp_code:250}|{status:'failed';code:string;smtp_code?:number}|{status:'unknown'};

async function syncDirectory(directory:string) {
  const handle=await open(directory,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function recordNew(path:string,directory:string,state:RecordState):Promise<boolean> {
  let file;
  try { file=await open(path,'wx',0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(directory);
  return true;
}
async function recordResult(path:string,directory:string,state:RecordState) {
  const temporary=join(directory,`${randomUUID()}.tmp`);
  try {
    const file=await open(temporary,'wx',0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary,path);
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(()=>{}); }
}
async function previous(path:string,digest:string):Promise<Result> {
  try {
    const state=JSON.parse(await readFile(path,'utf8')) as Partial<RecordState>;
    if (state.digest !== digest) return {status:'failed',code:'RELAY_MESSAGE_CONFLICT'};
    if (state.status === 'sent' && state.smtp_code === 250) return {status:'sent',smtp_code:250};
    if (state.status === 'failed' && typeof state.code === 'string')
      return {status:'failed',code:state.code,...(state.smtp_code?{smtp_code:state.smtp_code}:{})};
  } catch { /* A damaged ledger must never permit another SMTP send. */ }
  return {status:'unknown'};
}
async function readBody(request:IncomingMessage):Promise<unknown> {
  let bytes=0;const chunks:Buffer[]=[];
  for await (const chunk of request) {
    bytes+=chunk.length;
    if (bytes>64_000) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Call only after creating a durable, private ledger directory. Bind the returned server to loopback. */
export function createRelayServer(token:string,ledgerDir:string,smtp:MailTransport):Server {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid relay token');
  return createServer(async (request,response) => {
    const finish=(status:number,value:object)=>{
      response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify(value));
    };
    const authorization=request.headers.authorization ?? '';
    const candidate=/^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    if (!candidate || !timingSafeEqual(Buffer.from(candidate),Buffer.from(token))) {
      finish(401,{code:'UNAUTHORIZED'}); return;
    }
    if (request.url === '/v1/probe' && request.method === 'GET') {
      try { await smtp.probe();finish(200,{ready:true}); }
      catch (error) { finish(200,{ready:false,code:error instanceof MailTransferError?error.code:'SMTP_PROBE_FAILED'}); }
      return;
    }
    if (request.url !== '/v1/send' || request.method !== 'POST') { finish(404,{code:'NOT_FOUND'});return; }
    let mail:OutboundMail;
    try { mail=mailSchema.parse(await readBody(request)); }
    catch { finish(400,{code:'INVALID_MAIL'});return; }
    const digest=createHash('sha256').update(JSON.stringify(mail)).digest('hex');
    const path=join(ledgerDir,`${mail.messageId.slice(0,36)}.json`);
    try {
      const fresh=await recordNew(path,ledgerDir,{digest,status:'sending'});
      if (!fresh) { finish(200,await previous(path,digest));return; }
    } catch { finish(200,{status:'unknown'});return; }
    let result:Result;
    try {
      const code=await smtp.send(mail);
      result=code===250?{status:'sent',smtp_code:250}:{status:'unknown'};
    } catch (error) {
      result=error instanceof MailTransferError && !error.uncertain
        ? {status:'failed',code:error.code,...(error.smtpCode?{smtp_code:error.smtpCode}:{})}
        : {status:'unknown'};
    }
    try {
      await recordResult(path,ledgerDir,{digest,...result});
      finish(200,result);
    } catch { finish(200,{status:'unknown'}); }
  });
}

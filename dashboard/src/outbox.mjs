import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod, mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from './ingest.mjs';

const OUTBOX_SCHEMA='dashboard-outbox/1';
const ENCRYPTED_SCHEMA='dashboard-outbox/2';
const uuid=value=>typeof value==='string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const object=value=>value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype;

export function stableBatchKey({sourceId,baseVersion,cursorAfter,events}) {
  if (!uuid(sourceId) || !Number.isSafeInteger(baseVersion) || baseVersion<0 || !Array.isArray(events))
    throw new Error('INVALID_OUTBOX_BATCH');
  return `sha256:${digest({sourceId,baseVersion,cursorAfter,events})}`;
}

export async function enqueueBatch(root,input,{beforeCommit,encryptionKey}={}) {
  validateKey(encryptionKey);
  if (!object(input) || !uuid(input.sourceId) || !uuid(input.runId)
      || !Number.isSafeInteger(input.baseVersion) || input.baseVersion<0
      || !Object.hasOwn(input,'cursorAfter') || !Array.isArray(input.events))
    throw new Error('INVALID_OUTBOX_BATCH');
  const batchKey=input.batchKey??stableBatchKey(input);
  if (typeof batchKey!=='string' || batchKey.length<1 || batchKey.length>256)
    throw new Error('INVALID_OUTBOX_BATCH');
  const packet={...input,batchKey};
  const envelope=envelopeFor(packet);
  const name=fileName(packet.sourceId,packet.batchKey);
  const pending=join(root,'pending');
  const target=join(pending,name);
  const acknowledged=join(root,'acked',name);
  await ensureDirectories(root);
  try {
    const existing=await readAcknowledgement(acknowledged);
    if (existing.identityDigest!==envelope.identityDigest) throw new Error('OUTBOX_KEY_REUSED');
    return {queued:false,replayed:true,acknowledged:true,batchKey,path:acknowledged};
  } catch (error) {
    if (error.code!=='ENOENT') throw error;
  }
  try {
    const existing=await readEnvelope(target,encryptionKey);
    if (existing.identityDigest!==envelope.identityDigest) throw new Error('OUTBOX_KEY_REUSED');
    if (existing.packetDigest===envelope.packetDigest)
      return {queued:false,replayed:true,acknowledged:false,batchKey,path:target};
    // runId is not part of server packet identity. Rebinding lets an uncommitted
    // packet continue in a replacement run and remains safe if it had committed.
    const temporary=join(root,'tmp',`${name}.${randomUUID()}.rebind.tmp`);
    try {
      await durableWrite(temporary,encodePending(envelope,encryptionKey));
      await beforeCommit?.({temporary,target,packet});
      await rename(temporary,target);
      await syncDirectory(pending);
    } catch (error) {
      await rm(temporary,{force:true});
      throw error;
    }
    return {queued:true,replayed:true,rebound:true,acknowledged:false,batchKey,path:target};
  } catch (error) {
    if (error.code!=='ENOENT') throw error;
  }
  const temporary=join(root,'tmp',`${name}.${randomUUID()}.tmp`);
  try {
    await durableWrite(temporary,encodePending(envelope,encryptionKey));
    await beforeCommit?.({temporary,target,packet});
    // rename is the visibility boundary; scanners ignore tmp entirely.
    await rename(temporary,target);
    await syncDirectory(pending);
  } catch (error) {
    await rm(temporary,{force:true});
    throw error;
  }
  return {queued:true,replayed:false,batchKey,path:target};
}

export async function processOutbox(root,transport,{beforeApply,afterApply,maxPackets=Infinity,encryptionKey}={}) {
  validateKey(encryptionKey);
  if (!transport?.applyChangeBatch || !transport?.verifyChangeBatch)
    throw new Error('OUTBOX_TRANSPORT_REQUIRED');
  await ensureDirectories(root);
  const pending=join(root,'pending');
  const names=(await readdir(pending)).filter(name=>name.endsWith('.json')).sort().slice(0,maxPackets);
  const results=[];
  for (const name of names) {
    const path=join(pending,name);
    const envelope=await readEnvelope(path,encryptionKey);
    const packet=envelope.packet;
    await beforeApply?.({packet,path});
    const receipt=await transport.applyChangeBatch(packet);
    validateReceipt(receipt);
    await afterApply?.({packet,path,receipt});
    const verification=await transport.verifyChangeBatch(packet.sourceId,packet.batchKey);
    validateVerification(packet,receipt,verification);
    // Successful acknowledgements deliberately omit event payloads. The durable
    // receipt is enough to suppress requeue; raw content only lives while pending.
    const acknowledgementBody={schema:OUTBOX_SCHEMA,sourceId:packet.sourceId,batchKey:packet.batchKey,
      packetDigest:envelope.packetDigest,identityDigest:envelope.identityDigest,
      receipt,verification,ackedAt:new Date().toISOString()};
    const acknowledgement={...acknowledgementBody,ackDigest:digest(acknowledgementBody)};
    const ackPath=join(root,'acked',name);
    const temporary=join(root,'tmp',`${name}.${randomUUID()}.ack.tmp`);
    await durableWrite(temporary,acknowledgement);
    await rename(temporary,ackPath);
    await syncDirectory(join(root,'acked'));
    await rm(path);
    await syncDirectory(pending);
    results.push({batchKey:packet.batchKey,replayed:receipt.replayed,ackPath});
  }
  return results;
}

export async function rebindPendingBatches(root,runIdsBySource,{encryptionKey}={}) {
  validateKey(encryptionKey);
  if (!(runIdsBySource instanceof Map)) throw new Error('RUN_BINDINGS_REQUIRED');
  await ensureDirectories(root);
  const pending=join(root,'pending');
  const names=(await readdir(pending)).filter(name=>name.endsWith('.json')).sort();
  const results=[];
  for (const name of names) {
    const envelope=await readEnvelope(join(pending,name),encryptionKey);
    const runId=runIdsBySource.get(envelope.packet.sourceId);
    if (!uuid(runId)) throw new Error('PENDING_SOURCE_NOT_ENROLLED');
    results.push(await enqueueBatch(root,{...envelope.packet,runId},{encryptionKey}));
  }
  return results;
}

export function mcpBatchTransport(client) {
  if (!client?.callTool) throw new Error('MCP_CLIENT_REQUIRED');
  const call=async(name,args)=>{
    const response=await client.callTool({name,arguments:args});
    if (response.isError) throw new Error(parseToolError(response)??'MCP_TOOL_ERROR');
    return response.structuredContent;
  };
  return {
    applyChangeBatch:batch=>call('apply_change_batch',batch),
    verifyChangeBatch:(sourceId,batchKey)=>call('verify_change_batch',{sourceId,batchKey})
  };
}

async function ensureDirectories(root) {
  await Promise.all(['pending','acked','tmp'].map(async name=>{
    const path=join(root,name);
    await mkdir(path,{recursive:true,mode:0o700});
    await chmod(path,0o700);
  }));
}
function fileName(sourceId,batchKey) {
  const keyHash=createHash('sha256').update(batchKey).digest('hex');
  return `${sourceId}.${keyHash}.json`;
}
async function durableWrite(path,value) {
  const handle=await open(path,'wx',0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`,'utf8');
    await handle.sync();
  } finally {await handle.close();}
  return path;
}
async function syncDirectory(path) {
  const handle=await open(path,'r');
  try {await handle.sync();} finally {await handle.close();}
}
async function readEnvelope(path,encryptionKey) {
  const stored=JSON.parse(await readFile(path,'utf8'));
  if (stored?.schema===OUTBOX_SCHEMA && encryptionKey) throw new Error('OUTBOX_PLAINTEXT_PENDING');
  const parsed=stored?.schema===ENCRYPTED_SCHEMA?decodePending(stored,encryptionKey):stored;
  if (!object(parsed) || parsed.schema!==OUTBOX_SCHEMA || !object(parsed.packet)
      || parsed.packetDigest!==digest(parsed.packet)
      || parsed.identityDigest!==digest(packetIdentity(parsed.packet))) throw new Error('OUTBOX_CORRUPT');
  return parsed;
}
function validateKey(key) {
  if (key!==undefined && (!Buffer.isBuffer(key) || key.length!==32))
    throw new Error('OUTBOX_KEY_INVALID');
}
function encodePending(envelope,key) {
  if (!key) return envelope; // Legacy synthetic fixtures; collectAll requires a key.
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
  cipher.setAAD(Buffer.from(ENCRYPTED_SCHEMA));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(envelope),'utf8'),cipher.final()]);
  return {schema:ENCRYPTED_SCHEMA,cipher:'aes-256-gcm',nonce:nonce.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function decodePending(stored,key) {
  if (!key) throw new Error('OUTBOX_KEY_REQUIRED');
  try {
    if (stored.cipher!=='aes-256-gcm' || !canonicalBase64(stored.nonce,12)
        || !canonicalBase64(stored.tag,16) || !canonicalBase64(stored.ciphertext))
      throw new Error('OUTBOX_CORRUPT');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(stored.nonce,'base64'),{authTagLength:16});
    decipher.setAAD(Buffer.from(ENCRYPTED_SCHEMA));
    decipher.setAuthTag(Buffer.from(stored.tag,'base64'));
    const plain=Buffer.concat([decipher.update(Buffer.from(stored.ciphertext,'base64')),decipher.final()]);
    return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(plain));
  } catch {throw new Error('OUTBOX_CORRUPT');}
}
function canonicalBase64(value,size) {
  if (typeof value!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes=Buffer.from(value,'base64');
  return (size===undefined || bytes.length===size) && bytes.toString('base64')===value;
}
async function readAcknowledgement(path) {
  const parsed=JSON.parse(await readFile(path,'utf8'));
  if (!object(parsed) || parsed.schema!==OUTBOX_SCHEMA || !uuid(parsed.sourceId)
      || typeof parsed.batchKey!=='string' || parsed.batchKey.length<1
      || typeof parsed.packetDigest!=='string' || typeof parsed.identityDigest!=='string'
      || !object(parsed.receipt) || !object(parsed.verification) || typeof parsed.ackDigest!=='string')
    throw new Error('OUTBOX_CORRUPT');
  const {ackDigest,...body}=parsed;
  if (ackDigest!==digest(body)) throw new Error('OUTBOX_CORRUPT');
  return parsed;
}
function packetIdentity(packet) {
  const {runId,...identity}=packet;
  return identity;
}
function envelopeFor(packet) {
  return {schema:OUTBOX_SCHEMA,packet,packetDigest:digest(packet),identityDigest:digest(packetIdentity(packet))};
}
function validateReceipt(value) {
  if (!object(value) || typeof value.replayed!=='boolean'
      || !Number.isSafeInteger(value.committedVersion) || value.committedVersion<0
      || !Number.isSafeInteger(value.insertedCount) || value.insertedCount<0)
    throw new Error('INVALID_APPLY_RECEIPT');
}
function validateVerification(packet,receipt,value) {
  if (!object(value) || value.found!==true || value.verified!==true
      || value.digest!==digest(packetIdentity(packet))
      || value.committedVersion!==receipt.committedVersion
      || !Number.isSafeInteger(value.storedEvents)
      || value.storedEvents!==value.eventCount)
    throw new Error('OUTBOX_READBACK_FAILED');
}
function parseToolError(response) {
  try {return JSON.parse(response.content?.[0]?.text)?.error?.code;} catch {return null;}
}

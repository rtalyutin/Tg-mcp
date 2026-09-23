import {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {ingestBatch, readImportState, sanitizeIngestError, STABLE_INGEST_ERRORS, verifyBatch} from './ingest.mjs';
import {beginFullRun,completeRunSource,finalizeRun,STABLE_RUN_ERRORS} from './run-lifecycle.mjs';

export const MCP_LIMITS = Object.freeze({
  maxBatchBytes: 1_048_576,
  maxEventsPerBatch: 500,
  maxEventPayloadBytes: 65_536,
  maxIdentifierChars: 512,
  maxBatchKeyChars: 256,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000
});

// The protocol layer only checks that arguments are objects. Semantic validation is
// deliberately inside the handler so every invalid input gets a stable tool error;
// recursive z.json() can overflow before handler limits run.
const inputObject = fields => z.object(Object.fromEntries(fields.map(k=>[k,z.unknown().optional()]))).catchall(z.unknown());
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const anyJson = z.unknown();
const isoDateTime = z.iso.datetime({offset:true});

const knownErrors = new Set([...STABLE_INGEST_ERRORS,...STABLE_RUN_ERRORS,
  'BATCH_TOO_LARGE','EVENT_PAYLOAD_TOO_LARGE','INVALID_SOURCE_ID','INVALID_INPUT',
  'JSON_TOO_DEEP','JSON_TOO_COMPLEX']);

export function createDashboardMcpServer(db) {
  if (!db?.query || !db?.transaction) throw new Error('DATABASE_ADAPTER_REQUIRED');
  const server = new McpServer({name:'roman-dashboard',version:'0.4.0'});

  server.registerTool('begin_collection_run', {
    title: 'Begin a complete collection run',
    description: 'Atomically snapshot every registered source and its checkpoint. Requires at least one ChatGPT and one Codex source.',
    inputSchema: inputObject([]),
    outputSchema: z.object({
      runId:z.string(),sourceCount:z.number().int(),sourceKinds:z.array(z.enum(['chatgpt','codex'])),
      sources:z.array(z.object({sourceId:z.string(),kind:z.enum(['chatgpt','codex']),
        checkpoint:z.object({version:z.number().int(),cursor:anyJson})}))
    }),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false}
  }, async args => toolCall(async () => {
    validateExact(args,[]);
    return beginFullRun(db);
  }));

  server.registerTool('read_state', {
    title: 'Read dashboard import state',
    description: 'Read the technical checkpoint, latest collection-run state and last receipt for one registered source. Does not return conversation contents or canonical dashboard entities.',
    inputSchema: inputObject(['sourceId']),
    outputSchema: z.object({
      sourceId:z.string(),
      sourceKind:z.enum(['chatgpt','codex']),
      checkpoint:z.object({version:z.number().int(),cursor:anyJson,updatedAt:z.string()}),
      latestRun:anyJson.nullable(),
      lastBatch:anyJson.nullable()
    }),
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
  }, async args => toolCall(async () => {
    validateExact(args,['sourceId']);
    validateUuid(args.sourceId,'INVALID_SOURCE_ID');
    return readImportState(db,args.sourceId);
  }));

  server.registerTool('apply_change_batch', {
    title: 'Apply an idempotent source change batch',
    description: 'Atomically store immutable source revisions and advance one source checkpoint. Retrying the identical sourceId+batchKey returns the original receipt; changing content under the same key is rejected.',
    inputSchema: inputObject(['sourceId','runId','batchKey','baseVersion','cursorAfter','events']),
    outputSchema: z.object({replayed:z.boolean(),committedVersion:z.number().int(),insertedCount:z.number().int()}),
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}
  }, async batch => toolCall(async () => {
    validateBatch(batch);
    enforceByteLimits(batch);
    return ingestBatch(db,batch);
  }));

  server.registerTool('verify_change_batch', {
    title: 'Verify a stored change-batch receipt',
    description: 'Read back the durable receipt and stored-event count for a sourceId+batchKey. This checks storage consistency, not source coverage completeness.',
    inputSchema: inputObject(['sourceId','batchKey']),
    outputSchema: z.union([
      z.object({found:z.literal(false)}),
      z.object({found:z.literal(true),digest:z.string().regex(/^[a-f0-9]{64}$/),committedVersion:z.number().int(),eventCount:z.number().int(),insertedCount:z.number().int(),storedEvents:z.number().int(),verified:z.boolean()})
    ]),
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
  }, async args => toolCall(async () => {
    validateExact(args,['sourceId','batchKey']);
    validateUuid(args.sourceId,'INVALID_SOURCE_ID');
    validateString(args.batchKey,MCP_LIMITS.maxBatchKeyChars);
    return verifyBatch(db,args.sourceId,args.batchKey);
  }));

  server.registerTool('complete_source', {
    title: 'Record source coverage for a collection run',
    description: 'Mark one enrolled source complete only when its starting and ending checkpoint versions match. Evidence is a collector assertion and does not independently prove source API completeness.',
    inputSchema: inputObject(['runId','sourceId','fromVersion','toVersion','observedCount',
      'endOfSource','method','collectorVersion','watermark']),
    outputSchema: z.object({completed:z.literal(true),replayed:z.boolean(),
      fromVersion:z.number().int(),toVersion:z.number().int()}),
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}
  }, async args => toolCall(async () => {
    validateExact(args,['runId','sourceId','fromVersion','toVersion','observedCount',
      'endOfSource','method','collectorVersion','watermark']);
    validateJson(args.watermark);
    if (bytes(args)>MCP_LIMITS.maxBatchBytes) throw new Error('BATCH_TOO_LARGE');
    return completeRunSource(db,args);
  }));

  server.registerTool('finalize_run', {
    title: 'Finalize a fully covered collection run',
    description: 'Complete a run only when all currently registered sources are enrolled, both ChatGPT and Codex are present, every source has verified_complete evidence, and no checkpoint advanced afterward.',
    inputSchema: inputObject(['runId']),
    outputSchema: z.object({completed:z.literal(true),replayed:z.boolean(),sourceCount:z.number().int()}),
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}
  }, async args => toolCall(async () => {
    validateExact(args,['runId']);
    validateUuid(args.runId,'RUN_NOT_FOUND');
    return finalizeRun(db,args.runId);
  }));

  return server;
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value),'utf8');
}
function enforceByteLimits(batch) {
  if (bytes(batch) > MCP_LIMITS.maxBatchBytes) throw new Error('BATCH_TOO_LARGE');
  for (const event of batch.events)
    if (bytes(event.payload) > MCP_LIMITS.maxEventPayloadBytes) throw new Error('EVENT_PAYLOAD_TOO_LARGE');
}
function validateBatch(batch) {
  validateExact(batch,['sourceId','runId','batchKey','baseVersion','cursorAfter','events']);
  validateUuid(batch.sourceId);
  validateUuid(batch.runId);
  validateString(batch.batchKey,MCP_LIMITS.maxBatchKeyChars);
  if (!Number.isSafeInteger(batch.baseVersion) || batch.baseVersion < 0 || batch.baseVersion >= Number.MAX_SAFE_INTEGER)
    throw new Error('INVALID_INPUT');
  validateJson(batch.cursorAfter);
  if (!Array.isArray(batch.events) || batch.events.length > MCP_LIMITS.maxEventsPerBatch) throw new Error('INVALID_INPUT');
  const eventKeys=new Set();
  for (const event of batch.events) {
    validateExact(event,['nativeId','revision','threadId','occurredAt','payload']);
    for (const key of ['nativeId','revision','threadId']) validateString(event[key],MCP_LIMITS.maxIdentifierChars);
    if (typeof event.occurredAt !== 'string' || !isoDateTime.safeParse(event.occurredAt).success)
      throw new Error('INVALID_INPUT');
    if (!plainObject(event.payload)) throw new Error('INVALID_INPUT');
    validateJson(event.payload);
    const key=JSON.stringify([event.nativeId,event.revision]);
    if (eventKeys.has(key)) throw new Error('DUPLICATE_EVENT_IN_BATCH');
    eventKeys.add(key);
  }
}
function validateExact(value,allowed) {
  if (!plainObject(value)) throw new Error('INVALID_INPUT');
  if (Object.keys(value).some(k=>!allowed.includes(k)) || allowed.some(k=>!Object.hasOwn(value,k))) throw new Error('INVALID_INPUT');
}
function validateUuid(value,code='INVALID_INPUT') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(code);
}
function validateString(value,max) {
  if (typeof value !== 'string' || value.length===0 || value.length>max) throw new Error('INVALID_INPUT');
}
function plainObject(value) {
  return value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype;
}
function validateJson(root) {
  const seen=new WeakSet();
  const stack=[[root,0]];
  let nodes=0;
  while (stack.length) {
    const [value,depth]=stack.pop();
    if (++nodes>MCP_LIMITS.maxJsonNodes) throw new Error('JSON_TOO_COMPLEX');
    if (value===null || typeof value==='string' || typeof value==='boolean') continue;
    if (typeof value==='number' && Number.isFinite(value)) continue;
    if (!Array.isArray(value) && !plainObject(value)) throw new Error('INVALID_JSON');
    if (seen.has(value)) throw new Error('INVALID_JSON');
    seen.add(value);
    const children=Array.isArray(value)?value:Object.values(value);
    if (children.length && depth>=MCP_LIMITS.maxJsonDepth) throw new Error('JSON_TOO_DEEP');
    for (const child of children) stack.push([child,depth+1]);
  }
}
function externalCode(error) {
  const message = error instanceof Error ? error.message : '';
  return knownErrors.has(message) ? message : sanitizeIngestError(error);
}
function result(value) {
  return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
}
async function toolCall(fn) {
  try { return result(await fn()); }
  catch (error) {
    const code=externalCode(error);
    return {content:[{type:'text',text:JSON.stringify({error:{code}})}],isError:true};
  }
}

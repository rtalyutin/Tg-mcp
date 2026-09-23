import {digest} from './ingest.mjs';
import {enqueueBatch,mcpBatchTransport,processOutbox,rebindPendingBatches} from './outbox.mjs';

export const COLLECTOR_VERSION='dashboard-collector/0.4.0';
const MAX_EVENTS_PER_BATCH=500;
const MAX_PACKET_BYTES=1_000_000;
const MAX_EVENT_PAYLOAD_BYTES=65_536;
const object=value=>value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype;
const uuid=value=>typeof value==='string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export async function collectAll({providers,outboxRoot,transport,collectorVersion=COLLECTOR_VERSION,maxPagesPerSource=100_000}) {
  validateDependencies({providers,outboxRoot,transport,collectorVersion,maxPagesPerSource});
  const run=await transport.beginCollectionRun();
  validateRun(run);
  const providerBySource=new Map(providers.map(provider=>[provider.sourceId,provider]));
  if (providerBySource.size!==providers.length) throw new Error('DUPLICATE_PROVIDER');
  if (run.sources.length!==providerBySource.size
      || run.sources.some(source=>!providerBySource.has(source.sourceId))) throw new Error('PROVIDER_SET_MISMATCH');
  for (const source of run.sources) {
    const provider=providerBySource.get(source.sourceId);
    if (provider.kind!==source.kind) throw new Error('PROVIDER_KIND_MISMATCH');
  }

  await rebindPendingBatches(outboxRoot,new Map(run.sources.map(source=>[source.sourceId,run.runId])));
  await processOutbox(outboxRoot,transport);

  const completed=[];
  for (const source of run.sources) {
    const provider=providerBySource.get(source.sourceId);
    const result=await collectSource({source,runId:run.runId,provider,outboxRoot,transport,
      collectorVersion,maxPagesPerSource});
    completed.push(result);
  }
  const finalized=await transport.finalizeRun(run.runId);
  if (!object(finalized) || finalized.completed!==true) throw new Error('INVALID_FINALIZE_RECEIPT');
  return {runId:run.runId,sourceCount:run.sourceCount,completed,finalized};
}

async function collectSource({source,runId,provider,outboxRoot,transport,collectorVersion,maxPagesPerSource}) {
  let state=await transport.readState(source.sourceId);
  validateState(state,source.sourceId);
  if (state.checkpoint.version<source.checkpoint.version) throw new Error('CHECKPOINT_REGRESSED');
  let cursor=state.checkpoint.cursor;
  let version=state.checkpoint.version;
  let observedCount=0;
  let terminal=null;
  for (let pageNumber=0;pageNumber<maxPagesPerSource;pageNumber++) {
    const page=await provider.nextPage({cursor,sourceId:source.sourceId,kind:source.kind});
    validatePage(page,cursor);
    observedCount+=page.events.length;
    const groups=pageBatches(page.events,{sourceId:source.sourceId,runId,baseVersion:version,
      cursorBefore:cursor,cursorAfter:page.cursorAfter});
    if (!groups.length && digest(page.cursorAfter)!==digest(cursor)) groups.push([]);
    for (let index=0;index<groups.length;index++) {
      const packet={sourceId:source.sourceId,runId,baseVersion:version,
        cursorAfter:index===groups.length-1?page.cursorAfter:cursor,events:groups[index]};
      await enqueueBatch(outboxRoot,packet);
      const [receipt]=await processOutbox(outboxRoot,transport,{maxPackets:1});
      if (!receipt) throw new Error('OUTBOX_DRAIN_INCOMPLETE');
      state=await transport.readState(source.sourceId);
      validateState(state,source.sourceId);
      if (state.checkpoint.version!==version+1 || digest(state.checkpoint.cursor)!==digest(packet.cursorAfter))
        throw new Error('CHECKPOINT_READBACK_FAILED');
      version=state.checkpoint.version;
    }
    cursor=page.cursorAfter;
    if (page.endOfSource) {terminal=page;break;}
  }
  if (!terminal) throw new Error('SOURCE_PAGE_LIMIT');
  const evidence={runId,sourceId:source.sourceId,fromVersion:source.checkpoint.version,toVersion:version,
    observedCount,endOfSource:true,method:provider.coverageMethod,
    collectorVersion,watermark:terminal.watermark};
  const completion=await transport.completeSource(evidence);
  if (!object(completion) || completion.completed!==true) throw new Error('INVALID_COMPLETION_RECEIPT');
  return {sourceId:source.sourceId,fromVersion:source.checkpoint.version,toVersion:version,
    observedCount,completion};
}

export function mcpCollectorTransport(client) {
  const batch=mcpBatchTransport(client);
  if (!client?.callTool) throw new Error('MCP_CLIENT_REQUIRED');
  const call=async(name,args)=>{
    const response=await client.callTool({name,arguments:args});
    if (response.isError) throw new Error(parseToolError(response)??'MCP_TOOL_ERROR');
    return response.structuredContent;
  };
  return {...batch,
    beginCollectionRun:()=>call('begin_collection_run',{}),
    readState:sourceId=>call('read_state',{sourceId}),
    completeSource:evidence=>call('complete_source',evidence),
    finalizeRun:runId=>call('finalize_run',{runId})
  };
}

function validateDependencies({providers,outboxRoot,transport,collectorVersion,maxPagesPerSource}) {
  if (!Array.isArray(providers) || !providers.length || typeof outboxRoot!=='string' || !outboxRoot
      || typeof collectorVersion!=='string' || !collectorVersion || collectorVersion.length>128
      || !Number.isSafeInteger(maxPagesPerSource) || maxPagesPerSource<1) throw new Error('INVALID_COLLECTOR_CONFIG');
  for (const provider of providers) {
    if (!object(provider) || !uuid(provider.sourceId) || !['chatgpt','codex'].includes(provider.kind)
        || !['full_enumeration','incremental_since_watermark'].includes(provider.coverageMethod)
        || typeof provider.nextPage!=='function') throw new Error('INVALID_PROVIDER');
  }
  for (const method of ['beginCollectionRun','readState','applyChangeBatch','verifyChangeBatch','completeSource','finalizeRun'])
    if (typeof transport?.[method]!=='function') throw new Error('COLLECTOR_TRANSPORT_REQUIRED');
}
function validateRun(run) {
  if (!object(run) || !uuid(run.runId) || !Number.isSafeInteger(run.sourceCount)
      || !Array.isArray(run.sources) || run.sources.length!==run.sourceCount) throw new Error('INVALID_RUN_SNAPSHOT');
  for (const source of run.sources)
    if (!object(source) || !uuid(source.sourceId) || !['chatgpt','codex'].includes(source.kind)
        || !object(source.checkpoint) || !Number.isSafeInteger(source.checkpoint.version)
        || source.checkpoint.version<0 || !Object.hasOwn(source.checkpoint,'cursor')) throw new Error('INVALID_RUN_SNAPSHOT');
}
function validateState(state,sourceId) {
  if (!object(state) || state.sourceId!==sourceId || !object(state.checkpoint)
      || !Number.isSafeInteger(state.checkpoint.version) || state.checkpoint.version<0
      || !Object.hasOwn(state.checkpoint,'cursor')) throw new Error('INVALID_SOURCE_STATE');
}
function validatePage(page,priorCursor) {
  if (!object(page) || !Array.isArray(page.events) || !Object.hasOwn(page,'cursorAfter')
      || typeof page.endOfSource!=='boolean' || !Object.hasOwn(page,'watermark')) throw new Error('INVALID_PROVIDER_PAGE');
  if (!page.endOfSource && digest(page.cursorAfter)===digest(priorCursor)) throw new Error('SOURCE_CURSOR_STALLED');
}
function pageBatches(events,{sourceId,runId,baseVersion,cursorBefore,cursorAfter}) {
  const groups=[];
  let current=[];
  for (const event of events) {
    let payloadBytes;
    try {payloadBytes=Buffer.byteLength(JSON.stringify(event?.payload),'utf8');}
    catch {throw new Error('INVALID_PROVIDER_PAGE');}
    if (!Number.isFinite(payloadBytes) || payloadBytes>MAX_EVENT_PAYLOAD_BYTES)
      throw new Error('EVENT_EXCEEDS_COLLECTOR_LIMIT');
    const candidate=[...current,event];
    if (candidate.length>MAX_EVENTS_PER_BATCH
        || estimatedPacketBytes({sourceId,runId,baseVersion:baseVersion+groups.length,
          cursorBefore,cursorAfter,events:candidate})>MAX_PACKET_BYTES) {
      if (!current.length) throw new Error('EVENT_EXCEEDS_COLLECTOR_LIMIT');
      groups.push(current); current=[event];
      if (estimatedPacketBytes({sourceId,runId,baseVersion:baseVersion+groups.length,
        cursorBefore,cursorAfter,events:current})>MAX_PACKET_BYTES)
        throw new Error('EVENT_EXCEEDS_COLLECTOR_LIMIT');
    } else current=candidate;
  }
  if (current.length) groups.push(current);
  return groups;
}
function estimatedPacketBytes({sourceId,runId,baseVersion,cursorBefore,cursorAfter,events}) {
  const batchKey=`sha256:${'0'.repeat(64)}`;
  const packet=cursor=>({sourceId,runId,batchKey,baseVersion,cursorAfter:cursor,events});
  try {
    return Math.max(Buffer.byteLength(JSON.stringify(packet(cursorBefore)),'utf8'),
      Buffer.byteLength(JSON.stringify(packet(cursorAfter)),'utf8'));
  } catch {throw new Error('INVALID_PROVIDER_PAGE');}
}
function parseToolError(response) {
  try {return JSON.parse(response.content?.[0]?.text)?.error?.code;} catch {return null;}
}

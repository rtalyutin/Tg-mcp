// Read-only capability probe for the Codex App Server's local thread store.
// It deliberately returns counts, never thread content or identifiers.
export const CODEX_SOURCE_KINDS = Object.freeze([
  'cli','vscode','exec','appServer','subAgent','subAgentReview',
  'subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'
]);

export async function probeCodexSource(request, {pageLimit=10000}={}) {
  if (typeof request!=='function' || !Number.isSafeInteger(pageLimit) || pageLimit<1)
    throw new Error('INVALID_PROBE_CONFIG');
  const first=await enumerate(request,pageLimit);
  const second=await enumerate(request,pageLimit);
  if (!sameIds(first.ids,second.ids)) throw new Error('CODEX_SOURCE_CHANGED_DURING_PROBE');
  let turnCount=0;
  for (const id of first.ids) {
    const result=await request('thread/read',{threadId:id,includeTurns:true});
    if (result?.thread?.id!==id || !Array.isArray(result.thread.turns))
      throw new Error('CODEX_THREAD_READ_INCOMPLETE');
    turnCount+=result.thread.turns.length;
  }
  return {
    status:'read_only_probe_passed',
    scope:'local Codex App Server store; live completeness not established',
    sourceKinds:[...CODEX_SOURCE_KINDS],
    activeThreads:first.activeCount,
    archivedThreads:first.archivedCount,
    threadsRead:first.ids.length,
    turnsRead:turnCount,
    enumerationPasses:2,
    pagesRead:first.pagesRead+second.pagesRead
  };
}

async function enumerate(request,pageLimit) {
  const ids=new Set();
  let activeCount=0;
  let archivedCount=0;
  let pagesRead=0;
  for (const archived of [false,true]) {
    let cursor=null;
    const cursors=new Set();
    do {
      if (++pagesRead>pageLimit) throw new Error('CODEX_PAGE_LIMIT');
      const result=await request('thread/list',{
        cursor,limit:100,sortKey:'created_at',sortDirection:'desc',
        sourceKinds:[...CODEX_SOURCE_KINDS],archived
      });
      if (!Array.isArray(result?.data) ||
          !(result.nextCursor===null || typeof result.nextCursor==='string'))
        throw new Error('CODEX_LIST_INCOMPLETE');
      for (const thread of result.data) {
        if (typeof thread?.id!=='string' || !thread.id || ids.has(thread.id))
          throw new Error('CODEX_LIST_DUPLICATE_OR_INVALID_ID');
        ids.add(thread.id);
        if (archived) archivedCount++; else activeCount++;
      }
      cursor=result.nextCursor;
      if (cursor!==null) {
        if (!cursor || cursors.has(cursor)) throw new Error('CODEX_CURSOR_STALLED');
        cursors.add(cursor);
      }
    } while (cursor!==null);
  }
  return {ids:[...ids].sort(),activeCount,archivedCount,pagesRead};
}

function sameIds(a,b) {
  return a.length===b.length && a.every((id,index)=>id===b[index]);
}

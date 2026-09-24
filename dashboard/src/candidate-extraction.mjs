import {randomUUID} from 'node:crypto';
import {digest} from './ingest.mjs';

const uuid = value => typeof value==='string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const key = value => typeof value==='string' && /^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(value);
const bounded = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const plain = value => value && Object.getPrototypeOf(value)===Object.prototype;

function normalizeCandidates(value,eventId) {
  if (!plain(value) || Object.keys(value).some(k=>k!=='candidates') ||
      !Array.isArray(value.candidates) || value.candidates.length>20)
    throw new Error('INVALID_EXTRACTION');
  const seen=new Set();
  const candidates=value.candidates.map(item=>{
    if (!plain(item) || !['project','task'].includes(item.kind) || !key(item.key) ||
        !bounded(item.title,200) || !bounded(item.reason,1000) || seen.has(item.key))
      throw new Error('INVALID_CANDIDATE');
    seen.add(item.key);
    const common={key:item.key, title:item.title.trim(),reason:item.reason.trim(),
      evidenceEventIds:[eventId]};
    if (item.kind==='project') {
      if (Object.keys(item).some(k=>!['kind','key','title','reason'].includes(k)))
        throw new Error('INVALID_CANDIDATE');
      return {kind:'project_candidate',...common};
    }
    if (Object.keys(item).some(k=>!['kind','key','title','reason','expectedResult','projectHints'].includes(k)) ||
        !(item.expectedResult===null || bounded(item.expectedResult,2000)) ||
        !Array.isArray(item.projectHints) || item.projectHints.length>10 ||
        item.projectHints.some(hint=>!bounded(hint,200)) ||
        new Set(item.projectHints.map(x=>x.trim())).size!==item.projectHints.length)
      throw new Error('INVALID_CANDIDATE');
    return {kind:'task_candidate',...common,expectedResult:item.expectedResult?.trim()??null,
      projectHints:item.projectHints.map(x=>x.trim())};
  });
  return candidates.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
}

async function existingExtraction(db,eventId,extractorVersion) {
  const {rows:[marker]}=await db.query(`SELECT proposed_change FROM dashboard.change_proposal
    WHERE source_event_id=$1 AND extractor_version=$2 AND proposal_key='extract:complete'`,
  [eventId,extractorVersion]);
  if (!marker) return null;
  const {rows}=await db.query(`SELECT id,proposal_key,proposed_change FROM dashboard.change_proposal
    WHERE source_event_id=$1 AND extractor_version=$2 AND proposal_key LIKE 'candidate:%'
    ORDER BY proposal_key`,[eventId,extractorVersion]);
  const expected=marker.proposed_change;
  const byKey=new Map(rows.map(row=>[row.proposed_change.key,row]));
  if (expected.kind!=='extraction_completed' || !Array.isArray(expected.candidateKeys) ||
      byKey.size!==rows.length || byKey.size!==expected.candidateKeys.length ||
      expected.candidateKeys.some(key=>!byKey.has(key)))
    throw new Error('CORRUPT_EXTRACTION');
  const ordered=expected.candidateKeys.map(key=>byKey.get(key));
  if (expected.digest!==digest(ordered.map(row=>row.proposed_change)))
    throw new Error('CORRUPT_EXTRACTION');
  return {status:'replayed',proposalIds:ordered.map(row=>row.id),
    candidates:ordered.map(row=>({proposalId:row.id,...row.proposed_change})),
    candidateCount:rows.length,digest:expected.digest};
}

export async function readEventCandidates(db,{eventId,extractorVersion}) {
  if (!uuid(eventId) || !bounded(extractorVersion,100)) throw new Error('INVALID_EXTRACTION_INPUT');
  const result=await existingExtraction(db,eventId.toLowerCase(),extractorVersion);
  if (!result) throw new Error('EXTRACTION_NOT_COMPLETE');
  return result;
}

// One immutable message revision produces only candidates. Entity identity,
// merges, statuses and links require a separate semantic resolution step.
export async function extractEventCandidates(db,{eventId,extractorVersion,extract}) {
  if (!uuid(eventId) || !bounded(extractorVersion,100) || typeof extract!=='function')
    throw new Error('INVALID_EXTRACTION_INPUT');
  eventId=eventId.toLowerCase();
  const prior=await existingExtraction(db,eventId,extractorVersion);
  if (prior) return prior;
  const {rows:[event]}=await db.query(`SELECT id,source_id,thread_id,occurred_at,payload
    FROM dashboard.source_event WHERE id=$1`,[eventId]);
  if (!event) throw new Error('UNKNOWN_EVIDENCE_EVENT');
  const candidates=normalizeCandidates(await extract({id:event.id,sourceId:event.source_id,
    threadId:event.thread_id,occurredAt:new Date(event.occurred_at).toISOString(),
    payload:event.payload}),eventId);
  const hash=digest(candidates);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14527))',[eventId]);
    const existing=await existingExtraction(tx,eventId,extractorVersion);
    if (existing) {
      if (existing.digest!==hash) throw new Error('EXTRACTION_CONFLICT');
      return existing;
    }
    const proposalIds=[];
    for (const candidate of candidates) {
      const id=randomUUID();
      await tx.query(`INSERT INTO dashboard.change_proposal
        (id,source_event_id,extractor_version,proposal_key,proposed_change)
        VALUES ($1,$2,$3,$4,$5)`,[id,eventId,extractorVersion,
        `candidate:${candidate.key}`,JSON.stringify(candidate)]);
      proposalIds.push(id);
    }
    await tx.query(`INSERT INTO dashboard.change_proposal
      (id,source_event_id,extractor_version,proposal_key,proposed_change)
      VALUES ($1,$2,$3,'extract:complete',$4)`,[randomUUID(),eventId,extractorVersion,
        JSON.stringify({kind:'extraction_completed',candidateKeys:candidates.map(x=>x.key),digest:hash})]);
    return {status:'proposed',proposalIds,candidates:candidates.map((x,i)=>({proposalId:proposalIds[i],...x})),
      candidateCount:candidates.length,digest:hash};
  });
}

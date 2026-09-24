import {randomUUID} from 'node:crypto';
import {digest} from './ingest.mjs';

const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function validateInput({taskId,eventIds,extractorVersion,assess}) {
  if (!uuid(taskId) || !Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 25 ||
      eventIds.some(id => !uuid(id)) || new Set(eventIds).size !== eventIds.length ||
      typeof extractorVersion !== 'string' || extractorVersion.length < 1 || extractorVersion.length > 100 ||
      typeof assess !== 'function') throw new Error('INVALID_PROGRESS_INPUT');
}

export function validateProgressAssessment(assessment, availableIds) {
  const percent=assessment?.progressPercent;
  const reason=assessment?.reason;
  const ids=assessment?.evidenceEventIds;
  if (!assessment || Object.keys(assessment).some(key =>
    !['progressPercent','reason','evidenceEventIds'].includes(key)) ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
    throw new Error('INVALID_PROGRESS_ASSESSMENT');
  if (percent === null && Array.isArray(ids) && ids.length === 0)
    return {progressPercent:null,reason:reason.trim(),evidenceEventIds:[]};
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || !Array.isArray(ids) ||
      ids.length < 1 || ids.length > 25 || new Set(ids).size !== ids.length ||
      ids.some(id => !availableIds.has(id))) throw new Error('INVALID_PROGRESS_ASSESSMENT');
  return {progressPercent:percent,reason:reason.trim(),evidenceEventIds:[...ids].sort()};
}

// This prepares a grounded assistant estimate as a proposal. A separate
// evidence resolution step decides whether it changes canonical task progress.
// `assess` is supplied by the caller; this module never calls an external model.
export async function proposeTaskProgress(db,{taskId,eventIds,extractorVersion,assess}) {
  validateInput({taskId,eventIds,extractorVersion,assess});
  const {rows:tasks}=await db.query(
    'SELECT id,title,expected_result,state_value,version FROM dashboard.task WHERE id=$1',[taskId]);
  if (!tasks.length) throw new Error('UNKNOWN_TASK');
  const task=tasks[0];
  const version=Number(task.version);
  if (!Number.isSafeInteger(version)) throw new Error('CANONICAL_VERSION_OUT_OF_RANGE');
  const {rows:events}=await db.query(`SELECT id,source_id,thread_id,occurred_at,payload
    FROM dashboard.source_event WHERE id=ANY($1::uuid[]) ORDER BY occurred_at,id`,[eventIds]);
  if (events.length !== eventIds.length) throw new Error('UNKNOWN_EVIDENCE_EVENT');
  const availableIds=new Set(events.map(x=>x.id));
  const result=validateProgressAssessment(await assess({
    task:{id:task.id,title:task.title,expectedResult:task.expected_result,stateValue:task.state_value},
    evidence:events.map(x=>({id:x.id,sourceId:x.source_id,threadId:x.thread_id,
      occurredAt:new Date(x.occurred_at).toISOString(),payload:x.payload}))
  }),availableIds);
  if (result.progressPercent === null)
    return {status:'insufficient_evidence',progressPercent:null,reason:result.reason};

  const proposal={kind:'task_progress_assessment',taskId,taskVersion:version,...result};
  const proposalKey=`progress:${taskId}:${digest({taskVersion:version,eventIds:[...eventIds].sort()})}`;
  const anchorEventId=[...eventIds].sort()[0];
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14526))',[taskId]);
    const {rows:current}=await tx.query('SELECT version FROM dashboard.task WHERE id=$1 FOR SHARE',[taskId]);
    if (!current.length || Number(current[0].version) !== version) throw new Error('STALE_TASK');
    const {rows:inserted}=await tx.query(`INSERT INTO dashboard.change_proposal
      (id,source_event_id,extractor_version,proposal_key,proposed_change)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_event_id,extractor_version,proposal_key)
      DO NOTHING RETURNING id`,
      [randomUUID(),anchorEventId,extractorVersion,proposalKey,JSON.stringify(proposal)]);
    if (inserted.length) return {status:'proposed',proposalId:inserted[0].id,progressPercent:result.progressPercent};
    const {rows:[prior]}=await tx.query(`SELECT id,proposed_change FROM dashboard.change_proposal
      WHERE source_event_id=$1 AND extractor_version=$2 AND proposal_key=$3`,
      [anchorEventId,extractorVersion,proposalKey]);
    if (!prior || digest(prior.proposed_change) !== digest(proposal))
      throw new Error('PROGRESS_PROPOSAL_CONFLICT');
    return {status:'replayed',proposalId:prior.id,progressPercent:result.progressPercent};
  });
}

import {digest} from './ingest.mjs';
import {validateProgressAssessment} from './progress-assessment.mjs';

const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function normalizeTask(row) {
  const version=Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('CANONICAL_VERSION_OUT_OF_RANGE');
  return {id:row.id,title:row.title,expectedResult:row.expected_result,
    stateValue:row.state_value,progressPercent:row.progress_percent === null ? null : Number(row.progress_percent),
    progressMethod:row.progress_method,version};
}

async function readTask(db,taskId,lock=false) {
  const {rows}=await db.query(`SELECT id,title,expected_result,state_value,progress_percent,
    progress_method,version FROM dashboard.task WHERE id=$1${lock?' FOR UPDATE':''}`,[taskId]);
  if (!rows.length) throw new Error('UNKNOWN_TASK');
  return normalizeTask(rows[0]);
}

async function readProposals(db,taskId,version,lock=false) {
  const {rows}=await db.query(`SELECT id,proposed_change,extractor_version,source_event_id
    FROM dashboard.change_proposal
    WHERE proposed_change->>'kind'='task_progress_assessment'
      AND proposed_change->>'taskId'=$1 AND proposed_change->>'taskVersion'=$2
    ORDER BY id LIMIT 21${lock?' FOR SHARE':''}`,[taskId,String(version)]);
  if (rows.length>20) throw new Error('TOO_MANY_PROGRESS_PROPOSALS');
  for (const row of rows) {
    const x=row.proposed_change;
    if (!Number.isInteger(x.progressPercent) || x.progressPercent<0 || x.progressPercent>100 ||
        !Array.isArray(x.evidenceEventIds) || !x.evidenceEventIds.length ||
        x.evidenceEventIds.some(id=>!uuid(id))) throw new Error('INVALID_PROGRESS_PROPOSAL');
  }
  return rows;
}

// The caller supplies the semantic decision maker. No model client or external
// transmission is built in. A non-decisive judgement leaves canonical state as is.
export async function resolveTaskProgress(db,{taskId,resolverVersion,decide}) {
  if (!uuid(taskId) || typeof resolverVersion!=='string' || !resolverVersion ||
      resolverVersion.length>100 || typeof decide!=='function') throw new Error('INVALID_RESOLUTION_INPUT');
  const task=await readTask(db,taskId);
  if (task.progressMethod!==null && task.progressMethod!=='assistant_estimate')
    throw new Error('UNSUPPORTED_PROGRESS_METHOD');
  const proposals=await readProposals(db,taskId,task.version);
  if (!proposals.length) return {status:'no_proposals',progressPercent:task.progressPercent};
  const {rows:[history]}=await db.query(`SELECT after_value FROM dashboard.entity_history
    WHERE task_id=$1 AND resolution_rule='assistant_evidence' ORDER BY id DESC LIMIT 1`,[taskId]);
  const priorAccepted=history?.after_value??null;
  if (priorAccepted && (!Array.isArray(priorAccepted.evidenceEventIds) ||
      priorAccepted.evidenceEventIds.some(id=>!uuid(id)))) throw new Error('INVALID_PROGRESS_HISTORY');
  const ids=[...new Set([
    ...proposals.flatMap(row=>row.proposed_change.evidenceEventIds),
    ...(priorAccepted?.evidenceEventIds??[])
  ])].sort();
  const {rows:events}=await db.query(`SELECT id,source_id,thread_id,occurred_at,payload
    FROM dashboard.source_event WHERE id=ANY($1::uuid[]) ORDER BY occurred_at,id`,[ids]);
  if (events.length!==ids.length) throw new Error('UNKNOWN_EVIDENCE_EVENT');
  const decision=validateProgressAssessment(await decide({
    task,priorAccepted,
    proposals:proposals.map(row=>({id:row.id,extractorVersion:row.extractor_version,
      progressPercent:row.proposed_change.progressPercent,reason:row.proposed_change.reason,
      evidenceEventIds:row.proposed_change.evidenceEventIds})),
    evidence:events.map(row=>({id:row.id,sourceId:row.source_id,threadId:row.thread_id,
      occurredAt:new Date(row.occurred_at).toISOString(),payload:row.payload}))
  }),new Set(ids));
  if (decision.progressPercent===null)
    return {status:'unresolved',progressPercent:null,reason:decision.reason};

  const proposalDigest=digest(proposals);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14526))',[taskId]);
    const current=await readTask(tx,taskId,true);
    if (digest(current)!==digest(task)) throw new Error('STALE_TASK');
    const latest=await readProposals(tx,taskId,task.version,true);
    if (digest(latest)!==proposalDigest) throw new Error('STALE_PROGRESS_PROPOSALS');
    const {rows:[updated]}=await tx.query(`UPDATE dashboard.task
      SET progress_percent=$2,progress_method='assistant_estimate',version=version+1
      WHERE id=$1 AND version=$3 RETURNING version`,[taskId,decision.progressPercent,task.version]);
    if (!updated) throw new Error('STALE_TASK');
    const after={progressPercent:decision.progressPercent,progressMethod:'assistant_estimate',
      reason:decision.reason,evidenceEventIds:decision.evidenceEventIds,
      consideredProposalIds:proposals.map(row=>row.id),resolverVersion};
    await tx.query(`INSERT INTO dashboard.entity_history
      (task_id,actor,resolution_rule,before_value,after_value) VALUES ($1,$2,$3,$4,$5)`,
      [taskId,'assistant','assistant_evidence',JSON.stringify({progressPercent:task.progressPercent,
        progressMethod:task.progressMethod}),JSON.stringify(after)]);
    return {status:'applied',progressPercent:decision.progressPercent,version:Number(updated.version)};
  });
}

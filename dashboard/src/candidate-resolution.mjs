import {randomUUID} from 'node:crypto';
import {digest} from './ingest.mjs';
import {readEventCandidates} from './candidate-extraction.mjs';

const uuid = value => typeof value==='string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const reason = value => typeof value==='string' && value.trim().length>0 && value.length<=2000;

async function readProposal(db,proposalId,kind,lock=false) {
  const {rows:[row]}=await db.query(`SELECT id,source_event_id,extractor_version,proposed_change
    FROM dashboard.change_proposal WHERE id=$1${lock?' FOR SHARE':''}`,[proposalId]);
  if (!row || row.proposed_change.kind!==`${kind}_candidate` ||
      row.proposed_change.evidenceEventIds?.[0]!==row.source_event_id)
    throw new Error('INVALID_IDENTITY_CANDIDATE');
  const extracted=await readEventCandidates(db,{eventId:row.source_event_id,
    extractorVersion:row.extractor_version});
  if (!extracted.proposalIds.includes(proposalId)) throw new Error('INVALID_IDENTITY_CANDIDATE');
  return row;
}

async function readResolution(db,proposalId,kind) {
  const {rows:[row]}=await db.query(`SELECT project_id,task_id,action
    FROM dashboard.candidate_resolution WHERE proposal_id=$1`,[proposalId]);
  if (!row) return null;
  if ((kind==='project')!==Boolean(row.project_id)) throw new Error('INVALID_IDENTITY_CANDIDATE');
  return {status:'replayed',action:row.action,
    ...(row.project_id?{projectId:row.project_id}:{taskId:row.task_id})};
}

async function identityContext(db) {
  const {rows:projects}=await db.query(`SELECT p.id,p.title,p.version,
    (COALESCE(v.hidden,false) OR EXISTS (
      SELECT 1 FROM dashboard.project_folder pf
      JOIN dashboard.folder_visibility fv ON fv.folder_id=pf.folder_id
      WHERE pf.project_id=p.id AND fv.hidden)) AS hidden
    FROM dashboard.project p LEFT JOIN dashboard.project_visibility v ON v.project_id=p.id
    ORDER BY p.id LIMIT 1001`);
  const {rows:tasks}=await db.query(`SELECT id,title,expected_result,version
    FROM dashboard.task ORDER BY id LIMIT 1001`);
  const {rows:memberships}=await db.query(`SELECT task_id,project_id FROM dashboard.task_project
    ORDER BY task_id,project_id LIMIT 10001`);
  if (projects.length>1000 || tasks.length>1000 || memberships.length>10000)
    throw new Error('IDENTITY_CONTEXT_TOO_LARGE');
  return {
    projects:projects.map(x=>({id:x.id,title:x.title,version:String(x.version),hidden:x.hidden})),
    tasks:tasks.map(x=>({id:x.id,title:x.title,expectedResult:x.expected_result,
      version:String(x.version)})),
    taskProjects:memberships.map(x=>({taskId:x.task_id,projectId:x.project_id}))
  };
}

function validateDecision(value,kind,context) {
  if (!value || Object.getPrototypeOf(value)!==Object.prototype ||
      !['create','link','defer'].includes(value.action) || !reason(value.reason))
    throw new Error('INVALID_IDENTITY_DECISION');
  const allowed=kind==='project'?['action','reason','existingId']:
    ['action','reason','existingId','projectIds'];
  if (Object.keys(value).some(k=>!allowed.includes(k))) throw new Error('INVALID_IDENTITY_DECISION');
  if (value.action==='defer') {
    if (Object.keys(value).some(k=>!['action','reason'].includes(k)))
      throw new Error('INVALID_IDENTITY_DECISION');
    return {action:'defer',reason:value.reason.trim()};
  }
  if (value.action==='create' && value.existingId!==undefined ||
      value.action==='link' && (!uuid(value.existingId) ||
        !context[`${kind}s`].some(x=>x.id===value.existingId)))
    throw new Error('INVALID_IDENTITY_DECISION');
  if (kind==='task' && (!Array.isArray(value.projectIds) || !value.projectIds.length ||
      value.projectIds.length>10 || new Set(value.projectIds).size!==value.projectIds.length ||
      value.projectIds.some(id=>!uuid(id) || !context.projects.some(x=>x.id===id))))
    throw new Error('INVALID_IDENTITY_DECISION');
  return {...value,reason:value.reason.trim()};
}

async function resolveCandidate(db,{proposalId,resolverVersion,decide},kind) {
  if (!uuid(proposalId) || !reason(resolverVersion) || resolverVersion.length>100 ||
      typeof decide!=='function') throw new Error('INVALID_IDENTITY_INPUT');
  const prior=await readResolution(db,proposalId,kind);
  if (prior) return prior;
  const proposal=await readProposal(db,proposalId,kind);
  const context=await identityContext(db);
  const decision=validateDecision(await decide({candidate:proposal.proposed_change,
    sourceEventId:proposal.source_event_id,existing:context}),kind,context);
  if (decision.action==='defer') return {status:'deferred',reason:decision.reason};
  const snapshotHash=digest({proposal,context});
  return db.transaction(async tx=>{
    // Serialize all identity writes. A changed canonical context sends the
    // decision maker back through matching instead of silently duplicating.
    await tx.query('SELECT pg_advisory_xact_lock(410020260924)');
    const replay=await readResolution(tx,proposalId,kind);
    if (replay) return replay;
    const current=await readProposal(tx,proposalId,kind,true);
    const latest=await identityContext(tx);
    if (digest({proposal:current,context:latest})!==snapshotHash)
      throw new Error('STALE_IDENTITY_CONTEXT');
    const id=decision.action==='create'?randomUUID():decision.existingId;
    if (kind==='project') {
      if (decision.action==='create') await tx.query(
        'INSERT INTO dashboard.project(id,title) VALUES ($1,$2)',[id,proposal.proposed_change.title]);
    } else {
      if (decision.action==='create') await tx.query(
        'INSERT INTO dashboard.task(id,title,expected_result) VALUES ($1,$2,$3)',
        [id,proposal.proposed_change.title,proposal.proposed_change.expectedResult]);
      let added=false;
      for (const projectId of decision.projectIds) {
        const {rows}=await tx.query(`INSERT INTO dashboard.task_project(task_id,project_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING task_id`,[id,projectId]);
        if (rows.length) added=true;
      }
      if (added && decision.action==='link')
        await tx.query('UPDATE dashboard.task SET version=version+1 WHERE id=$1',[id]);
    }
    await tx.query(`INSERT INTO dashboard.candidate_resolution
      (proposal_id,project_id,task_id,action,reason,resolver_version)
      VALUES ($1,$2,$3,$4,$5,$6)`,[proposalId,kind==='project'?id:null,
        kind==='task'?id:null,decision.action==='create'?'created':'linked',
        decision.reason,resolverVersion]);
    const after={action:decision.action,reason:decision.reason,resolverVersion,
      candidateKey:proposal.proposed_change.key,evidenceEventIds:[proposal.source_event_id],
      ...(kind==='task'?{projectIds:decision.projectIds}:{}),
      ...(decision.action==='create'?{title:proposal.proposed_change.title}:{} )};
    await tx.query(`INSERT INTO dashboard.entity_history
      (project_id,task_id,proposal_id,actor,resolution_rule,before_value,after_value)
      VALUES ($1,$2,$3,'assistant','candidate_identity',$4,$5)`,
      [kind==='project'?id:null,kind==='task'?id:null,proposalId,
        decision.action==='create'?null:JSON.stringify({id}),JSON.stringify(after)]);
    return {status:decision.action==='create'?'created':'linked',
      ...(kind==='project'?{projectId:id}:{taskId:id})};
  });
}

export const resolveProjectCandidate=(db,args)=>resolveCandidate(db,args,'project');
export const resolveTaskCandidate=(db,args)=>resolveCandidate(db,args,'task');

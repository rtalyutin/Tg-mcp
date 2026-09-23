import {randomUUID} from 'node:crypto';
import {digest} from './ingest.mjs';
import {SOURCE_SET_ADVISORY_LOCK_SQL} from './locks.mjs';

const uuid=value=>typeof value==='string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const object=value=>value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype;

export const STABLE_RUN_ERRORS=new Set([
  'INVALID_COVERAGE_EVIDENCE','REQUIRED_SOURCE_KIND_MISSING','RUN_NOT_FOUND','RUN_NOT_RUNNING',
  'RUN_SOURCE_NOT_FOUND','COVERAGE_VERSION_MISMATCH','COVERAGE_ALREADY_RECORDED',
  'RUN_INCOMPLETE','SOURCE_SET_CHANGED','COVERAGE_STALE'
]);

export async function beginFullRun(db,id=randomUUID()) {
  return db.transaction(async tx=>{
    await tx.query(SOURCE_SET_ADVISORY_LOCK_SQL);
    const {rows}=await tx.query('SELECT id,kind FROM dashboard.source ORDER BY id');
    const kinds=new Set(rows.map(row=>row.kind));
    if (!kinds.has('chatgpt') || !kinds.has('codex')) throw new Error('REQUIRED_SOURCE_KIND_MISSING');
    await tx.query('INSERT INTO dashboard.collection_run(id) VALUES ($1)',[id]);
    const sources=[];
    for (const source of rows) {
      const {rows:checkpoints}=await tx.query(`SELECT version,cursor FROM dashboard.source_checkpoint
        WHERE source_id=$1 FOR SHARE`,[source.id]);
      if (!checkpoints.length) throw new Error('UNKNOWN_SOURCE');
      const checkpoint={version:Number(checkpoints[0].version),cursor:checkpoints[0].cursor};
      await tx.query(`INSERT INTO dashboard.run_source
        (run_id,source_id,checkpoint_version_start,cursor_start) VALUES ($1,$2,$3,$4)`,
        [id,source.id,checkpoint.version,JSON.stringify(checkpoint.cursor)]);
      sources.push({sourceId:source.id,kind:source.kind,checkpoint});
    }
    return {runId:id,sourceCount:rows.length,sourceKinds:[...kinds].sort(),sources};
  });
}

export async function completeRunSource(db,input) {
  validateEvidence(input);
  const evidence={method:input.method,collectorVersion:input.collectorVersion,
    fromVersion:input.fromVersion,toVersion:input.toVersion,observedCount:input.observedCount,
    endOfSource:true,watermark:input.watermark};
  return db.transaction(async tx=>{
    // Keep the same lock order as ingestBatch: checkpoint, run, then run_source.
    const {rows:checkpoints}=await tx.query(`SELECT version FROM dashboard.source_checkpoint
      WHERE source_id=$1 FOR UPDATE`,[input.sourceId]);
    const {rows}=await tx.query(`SELECT r.status AS run_status,rs.status,rs.coverage,rs.evidence,
      rs.checkpoint_version_start
      FROM dashboard.collection_run r JOIN dashboard.run_source rs ON rs.run_id=r.id
      WHERE r.id=$1 AND rs.source_id=$2 FOR UPDATE OF r,rs`,[input.runId,input.sourceId]);
    if (!rows.length) throw new Error('RUN_SOURCE_NOT_FOUND');
    const row=rows[0];
    if (row.status==='completed') {
      if (digest(row.evidence)===digest(evidence)) return {completed:true,replayed:true,
        fromVersion:input.fromVersion,toVersion:input.toVersion};
      throw new Error('COVERAGE_ALREADY_RECORDED');
    }
    if (row.run_status!=='running') throw new Error('RUN_NOT_RUNNING');
    if (Number(row.checkpoint_version_start)!==input.fromVersion
        || !checkpoints.length || Number(checkpoints[0].version)!==input.toVersion)
      throw new Error('COVERAGE_VERSION_MISMATCH');
    await tx.query(`UPDATE dashboard.run_source SET status='completed',coverage='verified_complete',
      evidence=$3,error_code=NULL WHERE run_id=$1 AND source_id=$2`,
      [input.runId,input.sourceId,JSON.stringify(evidence)]);
    return {completed:true,replayed:false,fromVersion:input.fromVersion,toVersion:input.toVersion};
  });
}

export async function finalizeRun(db,runId) {
  if (!uuid(runId)) throw new Error('RUN_NOT_FOUND');
  return db.transaction(async tx=>{
    // registerSource and both run starters take the same lock. This makes the
    // source-set check and completed status one serializable protocol step.
    await tx.query(SOURCE_SET_ADVISORY_LOCK_SQL);
    // Lock checkpoints first, in deterministic order, matching the ingest path.
    await tx.query(`SELECT sc.source_id FROM dashboard.run_source rs
      JOIN dashboard.source_checkpoint sc ON sc.source_id=rs.source_id
      WHERE rs.run_id=$1 ORDER BY sc.source_id FOR UPDATE OF sc`,[runId]);
    const {rows:runs}=await tx.query('SELECT status FROM dashboard.collection_run WHERE id=$1 FOR UPDATE',[runId]);
    if (!runs.length) throw new Error('RUN_NOT_FOUND');
    const {rows:enrolled}=await tx.query(`SELECT s.kind,rs.status,rs.coverage,rs.evidence,
      sc.version AS checkpoint_version_current
      FROM dashboard.run_source rs JOIN dashboard.source s ON s.id=rs.source_id
      JOIN dashboard.source_checkpoint sc ON sc.source_id=rs.source_id
      WHERE rs.run_id=$1 ORDER BY s.kind,s.id FOR UPDATE OF rs`,[runId]);
    if (runs[0].status==='completed') return {completed:true,replayed:true,sourceCount:enrolled.length};
    if (runs[0].status!=='running') throw new Error('RUN_NOT_RUNNING');
    const {rows:[registered]}=await tx.query(`SELECT count(*)::integer AS count,
      bool_or(kind='chatgpt') AS has_chatgpt,bool_or(kind='codex') AS has_codex FROM dashboard.source`);
    if (!registered.has_chatgpt || !registered.has_codex) throw new Error('REQUIRED_SOURCE_KIND_MISSING');
    if (enrolled.length!==registered.count) throw new Error('SOURCE_SET_CHANGED');
    if (enrolled.some(row=>row.status!=='completed' || row.coverage!=='verified_complete'))
      throw new Error('RUN_INCOMPLETE');
    if (enrolled.some(row=>Number(row.evidence?.toVersion)!==Number(row.checkpoint_version_current)))
      throw new Error('COVERAGE_STALE');
    await tx.query(`UPDATE dashboard.collection_run SET status='completed',finished_at=now() WHERE id=$1`,[runId]);
    return {completed:true,replayed:false,sourceCount:enrolled.length};
  });
}

function validateEvidence(input) {
  if (!object(input) || !uuid(input.runId) || !uuid(input.sourceId)
      || !Number.isSafeInteger(input.fromVersion) || input.fromVersion<0
      || !Number.isSafeInteger(input.toVersion) || input.toVersion<input.fromVersion
      || !Number.isSafeInteger(input.observedCount) || input.observedCount<0
      || input.endOfSource!==true
      || !['full_enumeration','incremental_since_watermark'].includes(input.method)
      || typeof input.collectorVersion!=='string' || input.collectorVersion.length<1
      || input.collectorVersion.length>128 || !Object.hasOwn(input,'watermark'))
    throw new Error('INVALID_COVERAGE_EVIDENCE');
  try {
    if (JSON.stringify(input.watermark)===undefined) throw new Error();
  } catch { throw new Error('INVALID_COVERAGE_EVIDENCE'); }
}

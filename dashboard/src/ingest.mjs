import { createHash, randomUUID } from 'node:crypto';
import {SOURCE_SET_ADVISORY_LOCK_SQL} from './locks.mjs';

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new Error('INVALID_JSON');
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const nonempty = s => typeof s === 'string' && s.length > 0;
const object = o => o && Object.getPrototypeOf(o) === Object.prototype;
export const STABLE_INGEST_ERRORS = new Set([
  'INVALID_BATCH','INVALID_EVENT','INVALID_JSON','UNKNOWN_FIELD','DUPLICATE_EVENT_IN_BATCH',
  'UNKNOWN_SOURCE','RUN_NOT_RUNNING','SOURCE_ALREADY_COMPLETED','BATCH_KEY_REUSED',
  'STALE_CHECKPOINT','EVENT_REVISION_REUSED'
]);
export function sanitizeIngestError(error) {
  const message = error instanceof Error ? error.message : '';
  return STABLE_INGEST_ERRORS.has(message) ? message : 'DATABASE_ERROR';
}

function validate(batch) {
  if (!object(batch) || !uuid(batch.sourceId) || !uuid(batch.runId) || !nonempty(batch.batchKey)
      || !Number.isSafeInteger(batch.baseVersion) || batch.baseVersion < 0 || batch.baseVersion >= Number.MAX_SAFE_INTEGER || !Array.isArray(batch.events)
      || !Object.hasOwn(batch, 'cursorAfter')) throw new Error('INVALID_BATCH');
  const allowed = ['sourceId','runId','batchKey','baseVersion','cursorAfter','events'];
  if (Object.keys(batch).some(k => !allowed.includes(k))) throw new Error('UNKNOWN_FIELD');
  const keys = new Set();
  for (const e of batch.events) {
    if (!object(e) || !nonempty(e.nativeId) || !nonempty(e.revision) || !nonempty(e.threadId)
        || typeof e.occurredAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(e.occurredAt)
        || !Number.isFinite(Date.parse(e.occurredAt)) || !object(e.payload)) throw new Error('INVALID_EVENT');
    if (Object.keys(e).some(k => !['nativeId','revision','threadId','occurredAt','payload'].includes(k))) throw new Error('UNKNOWN_FIELD');
    const key = canonical([e.nativeId, e.revision]);
    if (keys.has(key)) throw new Error('DUPLICATE_EVENT_IN_BATCH');
    keys.add(key);
  }
  canonical(batch);
}

// Registration is setup-only, not an MCP tool and not triggered by source contents.
export async function registerSource(db, {id, kind, externalScope}) {
  return db.transaction(async tx => {
    await tx.query(SOURCE_SET_ADVISORY_LOCK_SQL);
    await tx.query('INSERT INTO dashboard.source(id,kind,external_scope) VALUES ($1,$2,$3)', [id,kind,externalScope]);
    await tx.query('INSERT INTO dashboard.source_checkpoint(source_id) VALUES ($1)', [id]);
  });
}
export async function beginRun(db, sourceIds, id = randomUUID()) {
  if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length) throw new Error('INVALID_SOURCES');
  await db.transaction(async tx => {
    await tx.query(SOURCE_SET_ADVISORY_LOCK_SQL);
    await tx.query('INSERT INTO dashboard.collection_run(id) VALUES ($1)', [id]);
    for (const sourceId of [...sourceIds].sort()) {
      const {rows}=await tx.query('SELECT version,cursor FROM dashboard.source_checkpoint WHERE source_id=$1 FOR SHARE',[sourceId]);
      const checkpoint=rows[0]??{version:null,cursor:null};
      await tx.query(`INSERT INTO dashboard.run_source
        (run_id,source_id,checkpoint_version_start,cursor_start) VALUES ($1,$2,$3,$4)`,
        [id,sourceId,checkpoint.version,JSON.stringify(checkpoint.cursor)]);
    }
  });
  return id;
}

export async function ingestBatch(db, batch) {
  validate(batch);
  // A retry may be associated with another run without changing packet identity.
  const {runId, ...identity} = batch;
  const hash = digest(identity);
  try {
    return await db.transaction(async tx => {
      const {rows: checkpoints} = await tx.query('SELECT version FROM dashboard.source_checkpoint WHERE source_id=$1 FOR UPDATE', [batch.sourceId]);
      if (!checkpoints.length) throw new Error('UNKNOWN_SOURCE');
      const {rows: prior} = await tx.query('SELECT * FROM dashboard.ingest_batch WHERE source_id=$1 AND batch_key=$2', [batch.sourceId,batch.batchKey]);
      if (prior.length) {
        if (prior[0].digest !== hash) throw new Error('BATCH_KEY_REUSED');
        const {rows:runs} = await tx.query(`SELECT r.status FROM dashboard.collection_run r
          JOIN dashboard.run_source s ON s.run_id=r.id WHERE r.id=$1 AND s.source_id=$2 FOR SHARE OF r`, [runId,batch.sourceId]);
        // Receipt replay is independent of the run lifecycle. Audit it only when the
        // supplied run is still active; a lost response may be retried after closure.
        if (runs.length && runs[0].status === 'running') await attempt(tx, batch, 'replayed');
        return {replayed:true, committedVersion:Number(prior[0].committed_version), insertedCount:prior[0].inserted_count};
      }
      const {rows: runs} = await tx.query(`SELECT r.status,s.status AS source_status FROM dashboard.collection_run r
        JOIN dashboard.run_source s ON s.run_id=r.id WHERE r.id=$1 AND s.source_id=$2 FOR SHARE OF r`, [runId,batch.sourceId]);
      if (!runs.length || runs[0].status !== 'running') throw new Error('RUN_NOT_RUNNING');
      if (runs[0].source_status === 'completed') throw new Error('SOURCE_ALREADY_COMPLETED');
      if (Number(checkpoints[0].version) !== batch.baseVersion) throw new Error('STALE_CHECKPOINT');
      await tx.query(`INSERT INTO dashboard.ingest_batch
        (source_id,batch_key,run_id,digest,base_version,committed_version,cursor_after,event_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batch.sourceId,batch.batchKey,runId,hash,batch.baseVersion,batch.baseVersion+1,JSON.stringify(batch.cursorAfter),batch.events.length]);
      let insertedCount = 0;
      for (const event of batch.events) {
        const eventHash = digest(event);
        const {rows} = await tx.query(`SELECT id,digest FROM dashboard.source_event
          WHERE source_id=$1 AND native_id=$2 AND revision=$3`, [batch.sourceId,event.nativeId,event.revision]);
        let eventId = rows[0]?.id;
        if (eventId) {
          if (rows[0].digest !== eventHash) throw new Error('EVENT_REVISION_REUSED');
        } else {
          eventId = randomUUID();
          await tx.query(`INSERT INTO dashboard.source_event
            (id,source_id,native_id,revision,thread_id,occurred_at,payload,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [eventId,batch.sourceId,event.nativeId,event.revision,event.threadId,event.occurredAt,JSON.stringify(event.payload),eventHash]);
          insertedCount++;
        }
        await tx.query('INSERT INTO dashboard.batch_event(source_id,batch_key,event_id) VALUES ($1,$2,$3)', [batch.sourceId,batch.batchKey,eventId]);
      }
      await tx.query('UPDATE dashboard.ingest_batch SET inserted_count=$3 WHERE source_id=$1 AND batch_key=$2', [batch.sourceId,batch.batchKey,insertedCount]);
      await tx.query(`UPDATE dashboard.source_checkpoint SET version=version+1,cursor=$2,updated_at=now() WHERE source_id=$1`, [batch.sourceId,JSON.stringify(batch.cursorAfter)]);
      await tx.query(`UPDATE dashboard.run_source SET status='partial' WHERE run_id=$1 AND source_id=$2`, [runId,batch.sourceId]);
      await attempt(tx, batch, 'committed');
      return {replayed:false,committedVersion:batch.baseVersion+1,insertedCount};
    });
  } catch (error) {
    // Only stable codes, never payloads, credentials or raw database error messages.
    const code = sanitizeIngestError(error);
    try { await attempt(db, batch, 'rejected', code); }
    catch { /* Missing/invalid run or unavailable DB: caller must retain retry packet. */ }
    throw error;
  }
}
async function attempt(db, batch, outcome, errorCode = null) {
  return db.query('INSERT INTO dashboard.run_attempt(run_id,source_id,batch_key,outcome,error_code) VALUES ($1,$2,$3,$4,$5)',
    [batch.runId,batch.sourceId,batch.batchKey,outcome,errorCode]);
}
export async function readCheckpoint(db, sourceId) {
  const {rows} = await db.query('SELECT version,cursor FROM dashboard.source_checkpoint WHERE source_id=$1', [sourceId]);
  if (!rows.length) throw new Error('UNKNOWN_SOURCE');
  return {version:Number(rows[0].version),cursor:rows[0].cursor};
}

export async function readImportState(db, sourceId) {
  if (!uuid(sourceId)) throw new Error('INVALID_SOURCE_ID');
  const {rows} = await db.query(`SELECT s.id,s.kind,c.version,c.cursor,c.updated_at,
    (SELECT jsonb_build_object(
      'runId',rs.run_id,
      'runStatus',r.status,
      'sourceStatus',rs.status,
      'coverage',rs.coverage,
      'startedAt',r.started_at,
      'finishedAt',r.finished_at,
      'errorCode',rs.error_code
    ) FROM dashboard.run_source rs
      JOIN dashboard.collection_run r ON r.id=rs.run_id
      WHERE rs.source_id=s.id ORDER BY r.started_at DESC,rs.run_id DESC LIMIT 1) AS latest_run,
    (SELECT jsonb_build_object(
      'batchKey',b.batch_key,
      'digest',b.digest,
      'committedVersion',b.committed_version,
      'eventCount',b.event_count,
      'insertedCount',b.inserted_count,
      'committedAt',b.committed_at
    ) FROM dashboard.ingest_batch b
      WHERE b.source_id=s.id ORDER BY b.committed_at DESC,b.batch_key DESC LIMIT 1) AS last_batch
    FROM dashboard.source s
    JOIN dashboard.source_checkpoint c ON c.source_id=s.id
    WHERE s.id=$1`, [sourceId]);
  if (!rows.length) throw new Error('UNKNOWN_SOURCE');
  const row = rows[0];
  return {
    sourceId: row.id,
    sourceKind: row.kind,
    checkpoint: {version:Number(row.version),cursor:row.cursor,updatedAt:toIso(row.updated_at)},
    latestRun: normalizeDates(row.latest_run),
    lastBatch: normalizeNumbers(normalizeDates(row.last_batch))
  };
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function normalizeDates(value) {
  if (!value) return null;
  const copy = {...value};
  for (const key of ['startedAt','finishedAt','committedAt'])
    if (copy[key] !== null && copy[key] !== undefined) copy[key] = toIso(copy[key]);
  return copy;
}
function normalizeNumbers(value) {
  if (!value) return null;
  const copy = {...value};
  for (const key of ['committedVersion','eventCount','insertedCount'])
    if (copy[key] !== null && copy[key] !== undefined) copy[key] = Number(copy[key]);
  return copy;
}
export async function verifyBatch(db, sourceId, batchKey) {
  const {rows} = await db.query(`SELECT b.digest,b.committed_version,b.event_count,b.inserted_count,
    (SELECT count(*)::integer FROM dashboard.batch_event e WHERE e.source_id=b.source_id AND e.batch_key=b.batch_key) AS stored_events
    FROM dashboard.ingest_batch b WHERE b.source_id=$1 AND b.batch_key=$2`, [sourceId,batchKey]);
  if (!rows.length) return {found:false};
  const b = rows[0];
  return {found:true,digest:b.digest,committedVersion:Number(b.committed_version),eventCount:b.event_count,
    insertedCount:b.inserted_count,storedEvents:b.stored_events,verified:b.event_count===b.stored_events};
}

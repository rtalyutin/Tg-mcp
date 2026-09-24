import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { TestMailConfig } from './config.ts';
import { MailTransferError, TimewebSmtp, type MailTransport, type OutboundMail } from './smtp.ts';
import { RegistryError } from './registry.ts';

const id = z.uuid();
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const commandId = z.strictObject({ proposal_id:id, request_id:requestId });
export const draftInput = z.strictObject({
  opportunity_id:id, proposal_id:id.optional(), expected_version:z.number().int().positive().optional(),
  from:z.email().max(320), reply_to:z.email().max(320), to:z.email().max(320),
  subject:z.string().min(1).max(300), body:z.string().min(1).max(20_000),
  basis:z.literal('self_test'), request_id:requestId,
}).refine(value => Boolean(value.proposal_id) === Boolean(value.expected_version),
  'Editing requires proposal_id and expected_version');
export const submitInput = commandId.extend({ expected_version:z.number().int().positive() });
export const approveInput = submitInput.extend({content_hash:z.string().regex(/^[0-9a-f]{64}$/)});
export const noteInput = commandId.extend({ note:z.string().min(1).max(2000) });
export const reconcileInput = noteInput.extend({ result:z.enum(['sent','failed']) });
export const suppressInput = z.strictObject({ email:z.email().max(320), reason:z.string().min(1).max(2000),request_id:requestId });
export const togglePauseInput = z.strictObject({ paused:z.boolean(),request_id:requestId });

export const mailToolDefinitions = [
  { name:'get_proposal', description:'Read one proposal and its exact versions and send history.', inputSchema:z.toJSONSchema(z.strictObject({proposal_id:id})) as {type:'object'}, annotations:{readOnlyHint:true,openWorldHint:false} },
  { name:'save_proposal_draft', description:'Save a version of a self-test proposal; cannot send or approve.', inputSchema:z.toJSONSchema(draftInput) as {type:'object'}, annotations:{readOnlyHint:false,openWorldHint:false} },
  { name:'submit_for_review', description:'Submit the exact proposal version for owner review; cannot approve or send.', inputSchema:z.toJSONSchema(submitInput) as {type:'object'}, annotations:{readOnlyHint:false,openWorldHint:false} },
];

function parse<T extends z.ZodType>(schema:T, value:unknown):z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RegistryError('VALIDATION_ERROR',400,'Invalid mail command');
  return result.data;
}
function hash(value:unknown):string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function requireOwner(actor:string) { if (!actor.startsWith('owner:')) throw new RegistryError('FORBIDDEN',403,'Owner required'); }
function fail(code:string,status=409):never { throw new RegistryError(code,status,code); }
function safeEmail(value:string) { return value.toLowerCase(); }
function publicRow(row:Record<string,unknown>) { return JSON.parse(JSON.stringify(row)) as Record<string,unknown>; }

export class MailService {
  private readonly pool:Pool;
  private readonly config:TestMailConfig|null;
  private readonly clock:()=>Date;
  private readonly instanceId = randomUUID();
  private readonly transport: MailTransport | null;
  private processing = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(pool:Pool, config:TestMailConfig|null, transport?:MailTransport, clock:()=>Date=()=>new Date()) {
    this.pool=pool;this.config=config;this.clock=clock;
    this.transport = config ? transport ?? new TimewebSmtp(config) : null;
  }
  private async mutation<T extends {request_id:string}>(command:string,input:T,actor:string,perform:(client:PoolClient)=>Promise<Record<string,unknown>>) {
    const client = await this.pool.connect();
    const id = randomUUID(); const fingerprint = hash([command,input]);
    let deferred:RegistryError|undefined;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO outreach_mail_operations(id,request_id,command,payload_hash,actor_id,status)
        VALUES($1,$2,$3,$4,$5,'succeeded') ON CONFLICT(request_id) DO NOTHING RETURNING id`,
        [id,input.request_id,command,fingerprint,actor]);
      if (!inserted.rowCount) {
        const prev = (await client.query('SELECT * FROM outreach_mail_operations WHERE request_id=$1',[input.request_id])).rows[0];
        if (!prev || prev.payload_hash !== fingerprint || prev.command !== command || prev.actor_id !== actor) fail('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        if (prev.status === 'failed') throw new RegistryError(prev.error.code,prev.error.status,prev.error.code);
        return prev.result as Record<string,unknown>;
      }
      await client.query('SAVEPOINT mail_command');
      let output:Record<string,unknown> = {};
      try {
        output = publicRow({...await perform(client),operation_id:id});
        await client.query('UPDATE outreach_mail_operations SET result=$2::jsonb WHERE id=$1',[id,JSON.stringify(output)]);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT mail_command');
        deferred = error;
        await client.query("UPDATE outreach_mail_operations SET status='failed',error=$2::jsonb WHERE id=$1",
          [id,JSON.stringify({code:error.code,status:error.status})]);
      }
      await client.query('COMMIT');
      if (deferred) throw deferred;
      return output;
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  private event(client:PoolClient,proposalId:string,actor:string,action:string,jobId:string|null=null,details:Record<string,unknown>={}) {
    return client.query(`INSERT INTO outreach_mail_events(proposal_id,job_id,actor_id,action,details)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[proposalId,jobId,actor,action,JSON.stringify(details)]);
  }
  private async proposal(client:PoolClient,proposalId:string) {
    const row = (await client.query('SELECT * FROM outreach_mail_proposals WHERE id=$1 FOR UPDATE',[proposalId])).rows[0];
    if (!row) fail('PROPOSAL_NOT_FOUND',404);
    return row;
  }
  private async version(client:PoolClient,proposalId:string,version:number) {
    return (await client.query('SELECT * FROM outreach_mail_versions WHERE proposal_id=$1 AND version=$2',[proposalId,version])).rows[0];
  }
  private async opportunity(client:PoolClient,opportunityId:string) {
    const row = (await client.query(`SELECT o.* FROM outreach_opportunities o JOIN outreach_companies c ON c.id=o.company_id
      WHERE o.id=$1 AND c.workspace_id='ycs'`,[opportunityId])).rows[0];
    if (!row) fail('OPPORTUNITY_NOT_FOUND',404);
    return row;
  }
  private assertAddresses(version:{from_email:string;reply_to:string;to_email:string;basis:string}) {
    if (!this.config) fail('MAIL_DISABLED');
    if (version.from_email !== this.config.username || version.reply_to !== this.config.username ||
        version.to_email !== this.config.recipient || version.basis !== 'self_test') fail('MAIL_DESTINATION_DENIED');
  }
  private async assertAllowed(client:PoolClient,proposal:{opportunity_id:string},version:{to_email:string;from_email:string;reply_to:string;basis:string}) {
    this.assertAddresses(version);
    const op = await this.opportunity(client,proposal.opportunity_id);
    if (['agreed','declined','deferred','reply_received'].includes(op.status)) fail('OPPORTUNITY_BLOCKED');
    const emailKey = safeEmail(version.to_email);
    const blocked = await client.query('SELECT 1 FROM outreach_mail_suppressions WHERE email_key=$1',[emailKey]);
    if (blocked.rowCount) fail('CONTACT_SUPPRESSED');
    return op;
  }
  async saveDraft(value:unknown,actor:string) {
    const input = parse(draftInput,value);
    return this.mutation('save_proposal_draft',input,actor,async client => {
      await this.opportunity(client,input.opportunity_id);
      let proposal;
      if (input.proposal_id) {
        proposal = await this.proposal(client,input.proposal_id);
        if (proposal.opportunity_id !== input.opportunity_id) fail('OPPORTUNITY_MISMATCH');
        if (proposal.current_version !== input.expected_version) fail('VERSION_CONFLICT');
        const old = (await client.query('SELECT * FROM outreach_mail_jobs WHERE proposal_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[proposal.id])).rows[0];
        if (old && ['sending','sent','unknown'].includes(old.status)) fail('SEND_IN_PROGRESS');
        if (old?.status === 'queued' || old?.status === 'paused') {
          await client.query("UPDATE outreach_mail_jobs SET status='cancelled',updated_at=now() WHERE id=$1",[old.id]);
          await this.event(client,proposal.id,actor,'job_cancelled',old.id,{reason:'new_version'});
        }
        await client.query('UPDATE outreach_mail_approvals SET revoked_at=now() WHERE proposal_id=$1 AND revoked_at IS NULL',[proposal.id]);
        proposal.current_version++;
        await client.query("UPDATE outreach_mail_proposals SET current_version=$2,state='draft',updated_at=now() WHERE id=$1",[proposal.id,proposal.current_version]);
      } else {
        const existing = await client.query('SELECT id FROM outreach_mail_proposals WHERE opportunity_id=$1',[input.opportunity_id]);
        if (existing.rowCount) fail('PROPOSAL_ALREADY_EXISTS');
        proposal = {id:randomUUID(),current_version:1,opportunity_id:input.opportunity_id};
        const created=await client.query(`INSERT INTO outreach_mail_proposals(id,opportunity_id) VALUES($1,$2)
          ON CONFLICT(opportunity_id) DO NOTHING RETURNING id`,[proposal.id,input.opportunity_id]);
        if (!created.rowCount) fail('PROPOSAL_ALREADY_EXISTS');
      }
      const content = {from:input.from,reply_to:input.reply_to,to:input.to,subject:input.subject,body:input.body,basis:input.basis};
      const contentHash = hash(content);
      await client.query(`INSERT INTO outreach_mail_versions(proposal_id,version,from_email,reply_to,to_email,subject,body,content_hash,basis,author_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[proposal.id,proposal.current_version,input.from,input.reply_to,input.to,input.subject,input.body,contentHash,input.basis,actor]);
      await this.event(client,proposal.id,actor,'draft_saved',null,{version:proposal.current_version,content_hash:contentHash});
      return {proposal_id:proposal.id,version:proposal.current_version,content_hash:contentHash,state:'draft'};
    });
  }
  async submit(value:unknown,actor:string) {
    const input = parse(submitInput,value);
    return this.mutation('submit_for_review',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      if (row.current_version !== input.expected_version) fail('VERSION_CONFLICT');
      if (row.state !== 'draft') fail('INVALID_PROPOSAL_STATE');
      if ((await client.query('SELECT 1 FROM outreach_mail_approvals WHERE proposal_id=$1 AND version=$2',[row.id,row.current_version])).rowCount) fail('REVISION_REQUIRED');
      await client.query("UPDATE outreach_mail_proposals SET state='awaiting_approval',updated_at=now() WHERE id=$1",[row.id]);
      await client.query(`UPDATE outreach_opportunities SET status='awaiting_approval',last_action='mail_submitted',last_action_at=now(),
        version=version+1,updated_at=now() WHERE id=$1 AND status IN ('candidate','preparing','awaiting_approval')`,[row.opportunity_id]);
      await this.event(client,row.id,actor,'submitted',null,{version:row.current_version});
      return {proposal_id:row.id,version:row.current_version,state:'awaiting_approval'};
    });
  }
  async detail(proposalId:string) {
    if (!id.safeParse(proposalId).success) fail('VALIDATION_ERROR',400);
    const proposal = (await this.pool.query('SELECT * FROM outreach_mail_proposals WHERE id=$1',[proposalId])).rows[0];
    if (!proposal) fail('PROPOSAL_NOT_FOUND',404);
    const [versions,approvals,jobs,events,settings] = await Promise.all([
      this.pool.query('SELECT * FROM outreach_mail_versions WHERE proposal_id=$1 ORDER BY version DESC',[proposalId]),
      this.pool.query('SELECT * FROM outreach_mail_approvals WHERE proposal_id=$1 ORDER BY approved_at DESC',[proposalId]),
      this.pool.query(`SELECT j.*,a.actor_id AS approved_by FROM outreach_mail_jobs j JOIN outreach_mail_approvals a ON a.id=j.approval_id
        WHERE j.proposal_id=$1 ORDER BY j.created_at DESC`,[proposalId]),
      this.pool.query('SELECT * FROM outreach_mail_events WHERE proposal_id=$1 ORDER BY id DESC LIMIT 100',[proposalId]),
      this.pool.query('SELECT paused FROM outreach_mail_settings WHERE singleton=true'),
    ]);
    return {proposal,versions:versions.rows,approvals:approvals.rows,jobs:jobs.rows,events:events.rows,
      mail_enabled:Boolean(this.config),paused:settings.rows[0]?.paused ?? true};
  }
  async forCompany(companyId:string) {
    const result = await this.pool.query(`SELECT p.id,o.id AS opportunity_id FROM outreach_mail_proposals p
      JOIN outreach_opportunities o ON o.id=p.opportunity_id WHERE o.company_id=$1`,[companyId]);
    return Promise.all(result.rows.map(async row => ({opportunity_id:row.opportunity_id,...await this.detail(row.id)})));
  }
  async approve(value:unknown,actor:string) {
    requireOwner(actor); const input = parse(approveInput,value);
    return this.mutation('approve_mail',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      if (row.current_version !== input.expected_version) fail('VERSION_CONFLICT');
      if (row.state !== 'awaiting_approval') fail('NOT_AWAITING_APPROVAL');
      const version = await this.version(client,row.id,row.current_version);
      if (version.content_hash !== input.content_hash) fail('CONTENT_CHANGED');
      const approvalId = randomUUID();
      await client.query(`INSERT INTO outreach_mail_approvals(id,proposal_id,version,content_hash,actor_id)
        VALUES($1,$2,$3,$4,$5)`,[approvalId,row.id,row.current_version,input.content_hash,actor]);
      await client.query("UPDATE outreach_mail_proposals SET state='approved',updated_at=now() WHERE id=$1",[row.id]);
      await this.event(client,row.id,actor,'approved',null,{version:row.current_version,content_hash:input.content_hash});
      return {proposal_id:row.id,version:row.current_version,approval_id:approvalId,state:'approved'};
    });
  }
  async queue(value:unknown,actor:string) {
    requireOwner(actor); const input = parse(approveInput,value);
    return this.mutation('queue_mail',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      if (row.current_version !== input.expected_version) fail('VERSION_CONFLICT');
      if (row.state !== 'approved') fail('NOT_APPROVED');
      const version = await this.version(client,row.id,row.current_version);
      if (version.content_hash !== input.content_hash) fail('CONTENT_CHANGED');
      const settings = (await client.query('SELECT paused FROM outreach_mail_settings WHERE singleton=true')).rows[0];
      if (settings?.paused) fail('MAIL_PAUSED');
      const approval = (await client.query(`SELECT * FROM outreach_mail_approvals WHERE proposal_id=$1 AND version=$2
        AND revoked_at IS NULL AND content_hash=$3`,[row.id,row.current_version,input.content_hash])).rows[0];
      if (!approval) fail('APPROVAL_REVOKED');
      await this.assertAllowed(client,row,version);
      if ((await client.query('SELECT 1 FROM outreach_mail_jobs WHERE proposal_id=$1 AND version=$2',[row.id,row.current_version])).rowCount) fail('JOB_ALREADY_EXISTS');
      const jobId=randomUUID();
      await client.query(`INSERT INTO outreach_mail_jobs(id,proposal_id,version,approval_id,status,message_id)
        VALUES($1,$2,$3,$4,'queued',$5)`,[jobId,row.id,row.current_version,approval.id,`${jobId}@ycs.bar`]);
      await this.event(client,row.id,actor,'queued',jobId,{version:row.current_version});
      return {proposal_id:row.id,job_id:jobId,status:'queued',message_id:`${jobId}@ycs.bar`};
    });
  }
  async revoke(value:unknown,actor:string) {
    requireOwner(actor); const input = parse(commandId,value);
    return this.mutation('revoke_mail',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      const job = (await client.query('SELECT * FROM outreach_mail_jobs WHERE proposal_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[row.id])).rows[0];
      if (job && ['sending','sent','unknown'].includes(job.status)) fail('SEND_IN_PROGRESS');
      if (job && job.status === 'queued') await client.query("UPDATE outreach_mail_jobs SET status='cancelled',updated_at=now() WHERE id=$1",[job.id]);
      await client.query('UPDATE outreach_mail_approvals SET revoked_at=now() WHERE proposal_id=$1 AND revoked_at IS NULL',[row.id]);
      await client.query("UPDATE outreach_mail_proposals SET state='draft',updated_at=now() WHERE id=$1",[row.id]);
      await this.event(client,row.id,actor,'revoked',job?.id ?? null);
      return {proposal_id:row.id,state:'draft'};
    });
  }
  async pause(value:unknown,actor:string) {
    requireOwner(actor); const input=parse(togglePauseInput,value);
    return this.mutation('pause_mail',input,actor,async client => {
      await client.query('UPDATE outreach_mail_settings SET paused=$1,updated_at=now() WHERE singleton=true',[input.paused]);
      return {paused:input.paused};
    });
  }
  async suppress(value:unknown,actor:string) {
    requireOwner(actor); const input=parse(suppressInput,value);
    return this.mutation('suppress_mail',input,actor,async client => {
      // Serialize with claim and future suppression commands for this address.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ycs-mail-suppressions'))");
      await client.query(`INSERT INTO outreach_mail_suppressions(email_key,reason,actor_id) VALUES($1,$2,$3)
        ON CONFLICT(email_key) DO NOTHING`,[safeEmail(input.email),input.reason,actor]);
      return {email:input.email.toLowerCase(),suppressed:true};
    });
  }
  async closeUnknown(value:unknown,actor:string) {
    requireOwner(actor); const input=parse(noteInput,value);
    return this.mutation('close_unknown_mail',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      const job = (await client.query("SELECT * FROM outreach_mail_jobs WHERE proposal_id=$1 AND status='unknown' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[row.id])).rows[0];
      if (!job) fail('UNKNOWN_JOB_NOT_FOUND');
      await client.query(`UPDATE outreach_mail_jobs SET resolution='closed_without_retry',resolution_note=$2,
        resolved_by=$3,resolved_at=now(),updated_at=now() WHERE id=$1`,[job.id,input.note,actor]);
      await this.event(client,row.id,actor,'unknown_closed',job.id,{note:input.note});
      return {job_id:job.id,status:'unknown',resolution:'closed_without_retry'};
    });
  }
  async reconcile(value:unknown,actor:string) {
    requireOwner(actor); const input=parse(reconcileInput,value);
    return this.mutation('reconcile_mail',input,actor,async client => {
      const row = await this.proposal(client,input.proposal_id);
      const job = (await client.query("SELECT * FROM outreach_mail_jobs WHERE proposal_id=$1 AND status='unknown' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[row.id])).rows[0];
      if (!job) fail('UNKNOWN_JOB_NOT_FOUND');
      await client.query('UPDATE outreach_mail_jobs SET status=$2,failure_code=CASE WHEN $2=\'failed\' THEN \'RECONCILED_NO_ACCEPTANCE\' ELSE NULL END,finished_at=now(),updated_at=now() WHERE id=$1',[job.id,input.result]);
      if (input.result === 'sent') await this.markAwaitingReply(client,row.opportunity_id);
      await this.event(client,row.id,actor,'reconciled',job.id,{result:input.result,evidence:input.note});
      return {job_id:job.id,status:input.result};
    });
  }
  private async markAwaitingReply(client:PoolClient,opportunityId:string) {
    await client.query(`UPDATE outreach_opportunities SET status='awaiting_reply',last_action='smtp_accepted',
      last_action_at=now(),version=version+1,updated_at=now()
      WHERE id=$1 AND status IN ('candidate','preparing','awaiting_approval')`,[opportunityId]);
  }
  async probe(actor:string) {
    requireOwner(actor);
    if (!this.transport) fail('MAIL_DISABLED');
    try { await this.transport.probe(); return {ready:true,from:this.config!.username,port:this.config!.port}; }
    catch { return {ready:false,code:'SMTP_PROBE_FAILED'}; }
  }
  private window(now:Date) {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:this.config!.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const get=(key:string)=>parts.find(part=>part.type===key)!.value;
    const time=`${get('hour')}:${get('minute')}`;
    return {open:time>=this.config!.windowStart && time<this.config!.windowEnd,day:`${get('year')}-${get('month')}-${get('day')}`};
  }
  /** Claim persisted before network I/O; a crash can never silently resubmit a sending job. */
  private async claim():Promise<{mail:OutboundMail;jobId:string;attemptId:string;proposalId:string;opportunityId:string}|null> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const setting=(await client.query('SELECT paused FROM outreach_mail_settings WHERE singleton=true FOR SHARE')).rows[0];
      if (setting?.paused || !this.window(this.clock()).open) { await client.query('COMMIT'); return null; }
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ycs-mail-suppressions'))");
      const candidates=await client.query("SELECT id,proposal_id FROM outreach_mail_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 10");
      for (const candidate of candidates.rows) {
        const p=(await client.query('SELECT * FROM outreach_mail_proposals WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.proposal_id])).rows[0];
        if (!p) continue;
        const job=(await client.query('SELECT * FROM outreach_mail_jobs WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.id])).rows[0];
        if (!job || job.status !== 'queued') continue;
        const version=await this.version(client,p.id,job.version);
        const approval=(await client.query('SELECT * FROM outreach_mail_approvals WHERE id=$1',[job.approval_id])).rows[0];
        let failure:string|null=null;
        if (p.current_version !== job.version || p.state !== 'approved' || !approval || approval.revoked_at || approval.content_hash !== version.content_hash) failure='APPROVAL_INVALID';
        if (!failure) {
          try { await this.assertAllowed(client,p,version); } catch (error) { if (error instanceof RegistryError) failure=error.code; else throw error; }
        }
        if (failure) {
          await client.query("UPDATE outreach_mail_jobs SET status='cancelled',failure_code=$2,updated_at=now() WHERE id=$1",[job.id,failure]);
          await this.event(client,p.id,'system','job_cancelled',job.id,{reason:failure});
          continue;
        }
        const {day}=this.window(this.clock());
        const count=(await client.query(`SELECT count(*)::int AS count FROM outreach_mail_jobs
          WHERE window_day=$1 AND attempt_id IS NOT NULL`,[day])).rows[0].count;
        if (count>=this.config!.dailyLimit) break;
        const attemptId=randomUUID();
        await client.query(`UPDATE outreach_mail_jobs SET status='sending',attempt_id=$2,owner_instance_id=$3,
          attempt_started_at=now(),window_day=$4,updated_at=now() WHERE id=$1`,[job.id,attemptId,this.instanceId,day]);
        await client.query(`INSERT INTO outreach_mail_attempts(id,job_id,owner_instance_id,status)
          VALUES($1,$2,$3,'sending')`,[attemptId,job.id,this.instanceId]);
        await this.event(client,p.id,'system','sending',job.id,{attempt_id:attemptId});
        await client.query('COMMIT');
        return {jobId:job.id,attemptId,proposalId:p.id,opportunityId:p.opportunity_id,
          mail:{from:version.from_email,to:version.to_email,replyTo:version.reply_to,
            subject:version.subject,body:version.body,messageId:job.message_id}};
      }
      await client.query('COMMIT'); return null;
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  async recoverStale() {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // SMTP is bounded to 15s per step. A generous age prevents overlap from
      // changing a live attempt. A stale attempt is never retried automatically.
      const stale=await client.query(`UPDATE outreach_mail_jobs SET status='unknown',failure_code='PROCESS_RESULT_LOST',
        finished_at=now(),updated_at=now() WHERE status='sending' AND attempt_started_at < now()-interval '5 minutes' RETURNING *`);
      for (const row of stale.rows) {
        await client.query("UPDATE outreach_mail_attempts SET status='unknown',failure_code='PROCESS_RESULT_LOST',finished_at=now() WHERE id=$1 AND status='sending'",[row.attempt_id]);
        await this.event(client,row.proposal_id,'system','unknown',row.id,{attempt_id:row.attempt_id,reason:'PROCESS_RESULT_LOST'});
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  async tick() {
    if (!this.transport || this.processing) return;
    this.processing=true;
    try {
      await this.recoverStale();
      const claimed=await this.claim();
      if (!claimed) return;
      let status:'sent'|'failed'|'unknown'='unknown'; let code:number|null=null; let reason:string|null=null;
      try { code=await this.transport.send(claimed.mail); status='sent'; }
      catch (error) {
        if (error instanceof MailTransferError) {
          status=error.uncertain?'unknown':'failed'; code=error.smtpCode ?? null; reason=error.code;
        } else reason='SMTP_RESULT_UNKNOWN';
      }
      const client=await this.pool.connect();
      try {
        await client.query('BEGIN');
        const updated=await client.query(`UPDATE outreach_mail_jobs SET status=$3,smtp_code=$4,failure_code=$5,
          finished_at=now(),updated_at=now() WHERE id=$1 AND attempt_id=$2 AND status='sending' RETURNING id`,
          [claimed.jobId,claimed.attemptId,status,code,reason]);
        if (updated.rowCount) {
          await client.query('UPDATE outreach_mail_attempts SET status=$2,smtp_code=$3,failure_code=$4,finished_at=now() WHERE id=$1',[claimed.attemptId,status,code,reason]);
          if (status==='sent') await this.markAwaitingReply(client,claimed.opportunityId);
          await this.event(client,claimed.proposalId,'system',status,claimed.jobId,{attempt_id:claimed.attemptId,smtp_code:code,reason});
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
      finally { client.release(); }
    } finally { this.processing=false; }
  }
  start() {
    if (!this.transport || this.timer) return;
    this.timer=setInterval(() => { void this.tick().catch(()=>console.error('OUTREACH_MAIL_WORKER_UNAVAILABLE')); },15_000);
    void this.tick().catch(()=>console.error('OUTREACH_MAIL_WORKER_UNAVAILABLE'));
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer=undefined;
    while (this.processing) await new Promise(resolve=>setTimeout(resolve,25));
  }
}

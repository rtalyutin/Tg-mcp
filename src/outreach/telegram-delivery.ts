import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { FORMAT_POLICY, type PublishInput, type PublishResult } from '../publisher.ts';
import { splitStoryText, TextFormatError } from '../formatter.ts';
import type { RuntimeOptions } from '../publisher-runtime.ts';

export const deliveryMigrationSql = `
CREATE TABLE telegram_deliveries (
  attempt_id uuid PRIMARY KEY,
  instance_id uuid NOT NULL,
  task_id text NOT NULL,
  story_id text NOT NULL,
  channel_id text NOT NULL,
  content_hash text NOT NULL,
  parts jsonb,
  total_parts integer NOT NULL CHECK (total_parts > 0),
  next_part integer NOT NULL DEFAULT 0,
  confirmed jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL CHECK (state IN ('QUEUED','CLAIMED','SENDING','PUBLISHED','REJECTED','PARTIAL','UNKNOWN')),
  code text,
  resolved_channel_id text,
  lease_id uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, story_id),
  CHECK ((state IN ('CLAIMED','SENDING')) = (lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX telegram_deliveries_pending ON telegram_deliveries(available_at, created_at) WHERE state IN ('QUEUED','CLAIMED','SENDING');
CREATE TABLE telegram_channel_pins (
  configured_channel text PRIMARY KEY,
  resolved_channel_id text NOT NULL
);
CREATE TABLE telegram_worker_checks (
  task_id text PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  ready boolean NOT NULL,
  check_code text,
  channel_id text NOT NULL
);`;

const id = z.uuid();
export const workerInput = {
  claim: z.strictObject({}),
  begin: z.strictObject({ attempt_id: id, lease_id: id, resolved_channel_id: z.string().regex(/^-[1-9]\d*$/) }),
  complete: z.strictObject({ attempt_id: id, lease_id: id, outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('confirmed'), message_id: z.number().int().positive().safe() }),
    z.strictObject({ kind: z.literal('rejected'), code: z.enum(['SEND_REJECTED','RATE_LIMITED','BOT_FORBIDDEN']) }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]) }),
  defer: z.strictObject({ attempt_id: id, lease_id: id, code: z.string().regex(/^[A-Z_]{3,48}$/) }),
  check: z.strictObject({ task_id: z.string(), ready: z.boolean(), check_code: z.string().regex(/^[A-Z_]{3,48}$/).nullable() }),
};
type DeliveryRow = {
  attempt_id: string; instance_id: string; story_id: string; task_id: string; channel_id: string;
  content_hash: string; parts: string[] | null; total_parts: number; next_part: number; confirmed: PublishResult['confirmed_messages'];
  state: PublishResult['status']; code: string | null; resolved_channel_id: string | null; lease_id: string | null; lease_until: Date | null;
};
const terminal = (state: string) => ['PUBLISHED','REJECTED','PARTIAL','UNKNOWN'].includes(state);
const locked = async <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
};

export class QueuedPublisher {
  readonly profile: 'readonly' | 'publisher';
  readonly instanceId = randomUUID();
  readonly #pool: Pool;
  readonly #enabled: boolean;
  readonly #routes: Map<string,string>;
  #stopped = false;
  constructor(pool: Pool, options: RuntimeOptions) {
    this.#pool = pool; this.profile = options.profile; this.#enabled = options.publishEnabled;
    this.#routes = new Map(Object.entries(options.taskChannels ?? {}));
    if (options.channelId) this.#routes.set('', options.channelId);
    if (!this.#routes.size) throw new Error('Telegram routes required');
  }
  #result(row: DeliveryRow): PublishResult {
    return { story_id: row.story_id, attempt_id: row.attempt_id, instance_id: row.instance_id,
      task_id: row.task_id || null, channel_id: row.resolved_channel_id ?? row.channel_id,
      status: row.state, confirmed_messages: row.confirmed, uncertain_part_index: row.state === 'UNKNOWN' ? row.next_part + 1 : null,
      remaining_parts: row.total_parts - row.next_part, code: row.code,
      manual_check_required: ['UNKNOWN','PARTIAL'].includes(row.state), automatic_retry_allowed: false };
  }
  #empty(attempt: string, story: string | null, task: string | null, code: string, status: 'UNKNOWN' | 'REJECTED'): PublishResult {
    return { story_id: story, attempt_id: attempt, instance_id: this.instanceId, task_id: task,
      channel_id: null, status, confirmed_messages: [], uncertain_part_index: null, remaining_parts: null,
      code, manual_check_required: status === 'UNKNOWN', automatic_retry_allowed: false };
  }
  async publish(input: PublishInput): Promise<PublishResult> {
    const task = input.task_id ?? '';
    const channel = this.#routes.get(task);
    if (!channel) return this.#empty(input.attempt_id, input.story_id, task || null, task ? 'TASK_NOT_CONFIGURED' : 'TASK_REQUIRED', 'REJECTED');
    const hash = createHash('sha256').update(JSON.stringify([FORMAT_POLICY, task || null, channel, input.text])).digest('hex');
    return locked(this.#pool, async db => {
      // Lock the logical story key before checking either uniqueness constraint.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([task,input.story_id])]);
      const existing = await db.query<DeliveryRow>('SELECT * FROM telegram_deliveries WHERE attempt_id=$1 OR (task_id=$2 AND story_id=$3) FOR UPDATE', [input.attempt_id,task,input.story_id]);
      if (existing.rows.length) {
        const row = existing.rows[0]!;
        if (row.story_id === input.story_id && row.task_id === task && row.content_hash === hash) return this.#result(row);
        return this.#empty(input.attempt_id,input.story_id,task || null,row.attempt_id === input.attempt_id ? 'ATTEMPT_CONFLICT' : 'STORY_CONFLICT','UNKNOWN');
      }
      if (this.#stopped || !this.#enabled) return this.#empty(input.attempt_id,input.story_id,task || null,this.#stopped ? 'SHUTTING_DOWN' : 'PUBLISH_DISABLED','REJECTED');
      let parts: string[];
      try { parts = splitStoryText(input.text); }
      catch (error) { return this.#empty(input.attempt_id,input.story_id,task || null,error instanceof TextFormatError ? error.code : 'FORMAT_INVALID','REJECTED'); }
      const saved = await db.query<DeliveryRow>(`INSERT INTO telegram_deliveries
        (attempt_id,instance_id,task_id,story_id,channel_id,content_hash,parts,total_parts,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'QUEUED') RETURNING *`,
        [input.attempt_id,this.instanceId,task,input.story_id,channel,hash,JSON.stringify(parts),parts.length]);
      return this.#result(saved.rows[0]!);
    });
  }
  async attempt(input: {attempt_id: string; expected_instance_id: string}): Promise<PublishResult> {
    await this.#recoverExpired();
    const result = await this.#pool.query<DeliveryRow>('SELECT * FROM telegram_deliveries WHERE attempt_id=$1', [input.attempt_id]);
    return result.rows[0] ? this.#result(result.rows[0]) : this.#empty(input.attempt_id,null,null,'ATTEMPT_NOT_KNOWN','UNKNOWN');
  }
  async status() {
    await this.#recoverExpired();
    const checks = await this.#pool.query<{task_id: string;ready: boolean;check_code: string|null;channel_id:string;fresh:boolean}>(`
      SELECT task_id,ready,check_code,channel_id,checked_at > now() - interval '20 minutes' AS fresh FROM telegram_worker_checks`);
    const task_status = [...this.#routes].map(([task_id, channel]) => {
      const check = checks.rows.find(x => x.task_id === task_id && x.channel_id === channel);
      const ready = !this.#stopped && check?.ready === true && check.fresh;
      return { task_id, telegram_ready: ready, channel_title: null, channel_username: null, resolved_channel_id: null,
        check_code: ready ? null : check?.fresh ? check.check_code ?? 'WORKER_NOT_READY' : 'WORKER_NOT_READY' };
    });
    const pending = await this.#pool.query<{count:string}>("SELECT count(*) FROM telegram_deliveries WHERE state IN ('QUEUED','CLAIMED','SENDING')");
    const ready = task_status.length > 0 && task_status.every(x => x.telegram_ready);
    return { service_version: '0.12.0', instance_id: this.instanceId, delivery_mode: 'worker', publish_enabled: this.#enabled,
      telegram_ready: ready, channel_title: null, channel_username: null, format_policy: FORMAT_POLICY,
      task_status, queued_attempts: Number(pending.rows[0]?.count ?? 0),
      reason_code: this.#stopped ? 'SHUTTING_DOWN' : !this.#enabled ? 'PUBLISH_DISABLED' : ready ? null : 'WORKER_NOT_READY' };
  }
  routes() { return [...this.#routes].map(([task_id,channel_id]) => ({task_id,channel_id})); }
  async #recoverExpired() {
    // Sent but unacknowledged parts require a person to inspect the channel.
    await this.#pool.query(`UPDATE telegram_deliveries SET state='UNKNOWN',code='DELIVERY_UNKNOWN',lease_id=NULL,lease_until=NULL,
      parts=NULL,updated_at=now() WHERE state='SENDING' AND lease_until < now()`);
  }
  async check(data: z.infer<typeof workerInput.check>) {
    const channel = this.#routes.get(data.task_id);
    if (!channel) return { code: 'TASK_NOT_CONFIGURED' };
    await this.#pool.query(`INSERT INTO telegram_worker_checks(task_id,channel_id,ready,check_code)
      VALUES ($1,$2,$3,$4) ON CONFLICT(task_id) DO UPDATE SET
      channel_id=excluded.channel_id,ready=excluded.ready,check_code=excluded.check_code,checked_at=now()`,
      [data.task_id,channel,data.ready,data.ready ? null : data.check_code]);
    return { status:'ok' };
  }
  async claim() {
    if (!this.#enabled || this.#stopped) return { code: 'PUBLISH_DISABLED' };
    return locked(this.#pool, async db => {
      // A send may have succeeded before its acknowledgement was lost. Never resend it.
      await db.query(`UPDATE telegram_deliveries SET state='UNKNOWN',code='DELIVERY_UNKNOWN',lease_id=NULL,lease_until=NULL,
        parts=NULL,updated_at=now() WHERE state='SENDING' AND lease_until < now()`);
      const found = await db.query<DeliveryRow>(`SELECT * FROM telegram_deliveries WHERE
        (state='QUEUED' AND available_at<=now()) OR (state='CLAIMED' AND lease_until<now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = found.rows[0];
      if (!row) return { status:'empty' };
      if (this.#routes.get(row.task_id) !== row.channel_id) {
        await db.query(`UPDATE telegram_deliveries SET state=$2,code='ROUTE_CHANGED',parts=NULL,lease_id=NULL,lease_until=NULL WHERE attempt_id=$1`,
          [row.attempt_id,row.confirmed.length ? 'PARTIAL':'REJECTED']);
        return { status:'empty' };
      }
      const lease = randomUUID();
      await db.query(`UPDATE telegram_deliveries SET state='CLAIMED',lease_id=$2,lease_until=now()+interval '2 minutes',updated_at=now()
        WHERE attempt_id=$1`,[row.attempt_id,lease]);
      return { status:'claimed', attempt_id:row.attempt_id, lease_id:lease, task_id:row.task_id,
        channel_id:row.channel_id, part_index:row.next_part+1, text:row.parts![row.next_part] };
    });
  }
  async begin(data: z.infer<typeof workerInput.begin>) {
    return locked(this.#pool, async db => {
      const found = await db.query<DeliveryRow>(`SELECT * FROM telegram_deliveries WHERE attempt_id=$1 FOR UPDATE`,[data.attempt_id]);
      const row = found.rows[0];
      if (!this.#enabled || !row || row.state !== 'CLAIMED' || row.lease_id !== data.lease_id ||
          !row.lease_until || row.lease_until.getTime() <= Date.now() ||
          this.#routes.get(row.task_id) !== row.channel_id) return { code:'LEASE_INVALID' };
      if (row.channel_id.startsWith('-') && row.channel_id !== data.resolved_channel_id) return { code:'CHANNEL_ID_CHANGED' };
      const pin = await db.query(`INSERT INTO telegram_channel_pins(configured_channel,resolved_channel_id)
        VALUES ($1,$2) ON CONFLICT(configured_channel) DO UPDATE SET resolved_channel_id=excluded.resolved_channel_id
        WHERE telegram_channel_pins.resolved_channel_id=excluded.resolved_channel_id RETURNING resolved_channel_id`,
        [row.channel_id,data.resolved_channel_id]);
      if (!pin.rowCount) {
        await db.query(`UPDATE telegram_deliveries SET state=$2,code='CHANNEL_ID_CHANGED',parts=NULL,lease_id=NULL,
          lease_until=NULL,updated_at=now() WHERE attempt_id=$1`,[row.attempt_id,row.confirmed.length ? 'PARTIAL':'REJECTED']);
        return { code:'CHANNEL_ID_CHANGED' };
      }
      const result = await db.query(`UPDATE telegram_deliveries SET state='SENDING',resolved_channel_id=$3,
        lease_until=now()+interval '90 seconds',updated_at=now()
        WHERE attempt_id=$1 AND lease_id=$2 AND lease_until>now() RETURNING attempt_id`,
        [data.attempt_id,data.lease_id,data.resolved_channel_id]);
      return result.rowCount ? { status:'ready' } : { code:'LEASE_EXPIRED' };
    });
  }
  async complete(data: z.infer<typeof workerInput.complete>) {
    return locked(this.#pool, async db => {
      const found = await db.query<DeliveryRow>(`SELECT * FROM telegram_deliveries WHERE attempt_id=$1 FOR UPDATE`,[data.attempt_id]);
      const row = found.rows[0];
      if (!row || row.state !== 'SENDING' || row.lease_id !== data.lease_id || !this.#enabled) return { code:'LEASE_INVALID' };
      const confirmed = [...row.confirmed];
      if (data.outcome.kind === 'confirmed') confirmed.push({part_index:row.next_part+1,message_id:data.outcome.message_id,message_url:null});
      const next = row.next_part + (data.outcome.kind === 'confirmed' ? 1 : 0);
      const state = data.outcome.kind === 'confirmed' ? (next === row.parts!.length ? 'PUBLISHED':'QUEUED')
        : data.outcome.kind === 'unknown' ? 'UNKNOWN' : row.confirmed.length ? 'PARTIAL':'REJECTED';
      const code = data.outcome.kind === 'unknown' ? 'DELIVERY_UNKNOWN' : data.outcome.kind === 'rejected' ? data.outcome.code : null;
      const result = await db.query<DeliveryRow>(`UPDATE telegram_deliveries SET state=$2,code=$3,confirmed=$4::jsonb,next_part=$5,
        parts=CASE WHEN $2='QUEUED' THEN parts ELSE NULL END,lease_id=NULL,lease_until=NULL,updated_at=now()
        WHERE attempt_id=$1 RETURNING *`,[data.attempt_id,state,code,JSON.stringify(confirmed),next]);
      return this.#result(result.rows[0]!);
    });
  }
  async defer(data: z.infer<typeof workerInput.defer>) {
    const result = await this.#pool.query(`UPDATE telegram_deliveries SET state='QUEUED',code=$3,lease_id=NULL,
      lease_until=NULL,available_at=now()+interval '10 minutes',updated_at=now()
      WHERE attempt_id=$1 AND lease_id=$2 AND state='CLAIMED' AND lease_until>now() RETURNING attempt_id`,
      [data.attempt_id,data.lease_id,data.code]);
    return result.rowCount ? { status:'deferred' } : { code:'LEASE_INVALID' };
  }
  stop() { this.#stopped = true; return Promise.resolve(); }
}

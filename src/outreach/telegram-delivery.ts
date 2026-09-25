import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { FORMAT_POLICY, type PublishInput, type PublishResult } from '../publisher.ts';
import { splitCoverStoryText, splitStoryText, TextFormatError } from '../formatter.ts';
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

export const coverMigrationSql = `
ALTER TABLE telegram_deliveries ADD COLUMN cover_id uuid;
ALTER TABLE telegram_deliveries ADD COLUMN cover_sha256 text;
ALTER TABLE telegram_deliveries ADD COLUMN cover_bytes bytea;
ALTER TABLE telegram_deliveries ADD COLUMN cover_mime text;
CREATE TABLE telegram_story_covers (
  cover_id uuid PRIMARY KEY,
  task_id text NOT NULL,
  story_id text NOT NULL,
  sha256 text NOT NULL,
  mime_type text NOT NULL,
  image_bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,story_id)
);
CREATE INDEX telegram_story_covers_created ON telegram_story_covers(created_at);`;

export const coverTransferMigrationSql = `
CREATE TABLE telegram_cover_transfers (
  transfer_id uuid PRIMARY KEY,
  task_id text NOT NULL,
  story_id text NOT NULL,
  total_chunks integer NOT NULL CHECK (total_chunks BETWEEN 1 AND 200),
  next_chunk integer NOT NULL DEFAULT 0,
  chunk_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_bytes bytea NOT NULL DEFAULT ''::bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,story_id)
);
CREATE INDEX telegram_cover_transfers_created ON telegram_cover_transfers(created_at);`;

// NULL marks legacy cover-first rows, including rows already partially sent.
export const coverCaptionMigrationSql = `ALTER TABLE telegram_deliveries ADD COLUMN cover_caption text;`;

// The original ChatGPT connector advertises publish_story without cover_id.
// These exact markers allow it to stage an image without refreshing app actions.
export const COVER_CHUNK_PREFIX = 'YCS_COVER_CHUNK_V1:';
export const COVER_TEXT_PREFIX = 'YCS_COVER_TEXT_V1:\n';
export const COVER_ONLY_MARKER = 'YCS_COVER_ONLY_V1';
export const TEXT_ONLY_PREFIX = 'YCS_TEXT_ONLY_V1:\n';
const MAX_CHUNK_BYTES = 40 * 1024;
export const coverChunkSchema = z.strictObject({
  index: z.number().int().min(0).max(199),
  total: z.number().int().min(1).max(200),
  data: z.string().min(1).max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

const MAX_COVER_BYTES = 7 * 1024 * 1024;
function validCover(bytes: Buffer) {
  return bytes.length >= 45 && bytes.length <= MAX_COVER_BYTES &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(16) === bytes.readUInt32BE(20) && bytes.readUInt32BE(16) <= 10000 &&
    bytes.subarray(-8, -4).toString('ascii') === 'IEND';
}
export const coverInputSchema = z.strictObject({
  task_id: z.string().min(1).max(128), story_id: z.string().min(1).max(256),
  mime_type: z.literal('image/png'),
  image_base64: z.string().min(1).max(Math.ceil(MAX_COVER_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const queuedPublishInputSchema = z.strictObject({
  story_id: z.string().min(1).max(256).refine(s => s.trim().length > 0),
  task_id: z.string().min(1).max(128),
  attempt_id: z.uuid(), expected_instance_id: z.uuid(), cover_id: z.uuid(),
  text: z.string().min(1).refine(s => s.trim().length > 0 && s.isWellFormed() && Buffer.byteLength(s, 'utf8') <= 256 * 1024),
});
type QueuedPublishInput = z.infer<typeof queuedPublishInputSchema>;
export const queuedCoverOnlyInputSchema = queuedPublishInputSchema.omit({ text:true });
type QueuedCoverOnlyInput = z.infer<typeof queuedCoverOnlyInputSchema>;
export const queuedTextOnlyInputSchema = queuedPublishInputSchema.omit({ cover_id:true });
type QueuedTextOnlyInput = z.infer<typeof queuedTextOnlyInputSchema>;

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
  cover_id: string | null; cover_sha256: string | null; cover_bytes: Buffer | null; cover_mime: string | null;
  cover_caption: string | null;
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
  async uploadCover(input: z.infer<typeof coverInputSchema>) {
    if (this.#stopped || !this.#enabled) return { code: 'PUBLISH_DISABLED' };
    if (!this.#routes.has(input.task_id)) return { code: 'TASK_NOT_CONFIGURED' };
    const bytes = Buffer.from(input.image_base64, 'base64');
    // Require a canonical PNG and its square IHDR; do not store arbitrary encoded data.
    if (bytes.toString('base64') !== input.image_base64 || !validCover(bytes)) return { code: 'COVER_INVALID' };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const cover_id = randomUUID();
    await this.#pool.query("DELETE FROM telegram_story_covers WHERE created_at < now()-interval '24 hours'");
    await this.#pool.query(`INSERT INTO telegram_story_covers(cover_id,task_id,story_id,sha256,mime_type,image_bytes)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id,story_id) DO UPDATE SET
      cover_id=excluded.cover_id,sha256=excluded.sha256,mime_type=excluded.mime_type,
      image_bytes=excluded.image_bytes,created_at=now()`, [cover_id,input.task_id,input.story_id,sha256,input.mime_type,bytes]);
    return { cover_id, sha256, size_bytes:bytes.length };
  }
  async stageCoverChunk(input: PublishInput, part: z.infer<typeof coverChunkSchema>) {
    if (this.#stopped || !this.#enabled) return { code:'PUBLISH_DISABLED' };
    if (input.expected_instance_id !== this.instanceId) return { code:'INSTANCE_CHANGED' };
    const task = input.task_id ?? '';
    if (!this.#routes.has(task)) return { code:'TASK_NOT_CONFIGURED' };
    if (part.index >= part.total) return { code:'CHUNK_INVALID' };
    const bytes = Buffer.from(part.data,'base64');
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== part.data) return { code:'CHUNK_INVALID' };
    const digest = createHash('sha256').update(bytes).digest('hex');
    return locked(this.#pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify([task,input.story_id])]);
      await db.query("DELETE FROM telegram_cover_transfers WHERE created_at < now()-interval '24 hours'");
      const published = await db.query('SELECT attempt_id FROM telegram_deliveries WHERE task_id=$1 AND story_id=$2',[task,input.story_id]);
      if (published.rows.length) return { code:'STORY_ALREADY_QUEUED' };
      const ready = await db.query<{cover_id:string}>(`SELECT cover_id FROM telegram_story_covers
        WHERE task_id=$1 AND story_id=$2`,[task,input.story_id]);
      if (ready.rows.length) return ready.rows[0]!.cover_id === input.attempt_id
        ? { status:'COVER_READY',cover_id:input.attempt_id } : { code:'COVER_CONFLICT' };
      if (part.index === 0) await db.query(`INSERT INTO telegram_cover_transfers(transfer_id,task_id,story_id,total_chunks)
        VALUES($1,$2,$3,$4) ON CONFLICT(task_id,story_id) DO NOTHING`,[input.attempt_id,task,input.story_id,part.total]);
      const found = await db.query<{transfer_id:string;total_chunks:number;next_chunk:number;chunk_hashes:string[];image_bytes:Buffer}>(`
        SELECT * FROM telegram_cover_transfers WHERE task_id=$1 AND story_id=$2 FOR UPDATE`,[task,input.story_id]);
      const row = found.rows[0];
      if (!row || row.transfer_id !== input.attempt_id || row.total_chunks !== part.total) return { code:'TRANSFER_CONFLICT' };
      if (part.index < row.next_chunk) return row.chunk_hashes[part.index] === digest
        ? { status:'COVER_STAGED',next_chunk:row.next_chunk } : { code:'CHUNK_CONFLICT' };
      if (part.index !== row.next_chunk || row.image_bytes.length + bytes.length > MAX_COVER_BYTES) return { code:'CHUNK_INVALID' };
      const image = Buffer.concat([row.image_bytes,bytes]);
      if (part.index + 1 === part.total) {
        if (!validCover(image)) return { code:'COVER_INVALID' };
        await db.query(`INSERT INTO telegram_story_covers(cover_id,task_id,story_id,sha256,mime_type,image_bytes)
          VALUES($1,$2,$3,$4,'image/png',$5)`,[input.attempt_id,task,input.story_id,createHash('sha256').update(image).digest('hex'),image]);
        await db.query('DELETE FROM telegram_cover_transfers WHERE transfer_id=$1',[input.attempt_id]);
        return { status:'COVER_READY',cover_id:input.attempt_id };
      }
      await db.query(`UPDATE telegram_cover_transfers SET image_bytes=$2,chunk_hashes=$3::jsonb,next_chunk=$4
        WHERE transfer_id=$1`,[input.attempt_id,image,JSON.stringify([...row.chunk_hashes,digest]),part.index+1]);
      return { status:'COVER_STAGED',next_chunk:part.index+1 };
    });
  }
  async publish(input: QueuedPublishInput): Promise<PublishResult> {
    return this.#publish(input);
  }
  async publishCoverOnly(input: QueuedCoverOnlyInput): Promise<PublishResult> {
    return this.#publish({...input,text:null});
  }
  async publishTextOnly(input: QueuedTextOnlyInput): Promise<PublishResult> {
    return this.#publish({...input,cover_id:null});
  }
  async publishTextProbe(input: PublishInput): Promise<PublishResult> {
    const match = /^test-one:\d{4}-\d{2}-\d{2}:([0-9a-f-]{36})$/.exec(input.story_id);
    if (input.text !== '1' || !match || !z.uuid().safeParse(match[1]).success)
      return this.#empty(input.attempt_id,input.story_id,input.task_id ?? null,'TEST_ONLY','REJECTED');
    if (input.expected_instance_id !== this.instanceId)
      return this.#empty(input.attempt_id,input.story_id,input.task_id ?? null,'INSTANCE_CHANGED','UNKNOWN');
    return this.#publish({...input,task_id:input.task_id ?? '',cover_id:null});
  }
  async #publish(input: Omit<QueuedPublishInput,'cover_id'|'text'> & {cover_id:string|null;text:string|null}): Promise<PublishResult> {
    const task = input.task_id ?? '';
    const channel = this.#routes.get(task);
    if (!channel) return this.#empty(input.attempt_id, input.story_id, task || null, task ? 'TASK_NOT_CONFIGURED' : 'TASK_REQUIRED', 'REJECTED');
    return locked(this.#pool, async db => {
      // Lock the logical story key before checking either uniqueness constraint.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([task,input.story_id])]);
      const existing = await db.query<DeliveryRow>('SELECT * FROM telegram_deliveries WHERE attempt_id=$1 OR (task_id=$2 AND story_id=$3) FOR UPDATE', [input.attempt_id,task,input.story_id]);
      if (existing.rows.length) {
        const row = existing.rows[0]!;
        const hash = createHash('sha256').update(JSON.stringify([FORMAT_POLICY, task, channel, row.cover_sha256, input.text])).digest('hex');
        if (row.cover_id === input.cover_id && row.story_id === input.story_id && row.task_id === task && row.content_hash === hash) return this.#result(row);
        return this.#empty(input.attempt_id,input.story_id,task || null,row.attempt_id === input.attempt_id ? 'ATTEMPT_CONFLICT' : 'STORY_CONFLICT','UNKNOWN');
      }
      if (this.#stopped || !this.#enabled) return this.#empty(input.attempt_id,input.story_id,task || null,this.#stopped ? 'SHUTTING_DOWN' : 'PUBLISH_DISABLED','REJECTED');
      const cover = input.cover_id ? (await db.query<{sha256:string;image_bytes:Buffer;mime_type:string}>(`SELECT sha256,image_bytes,mime_type FROM telegram_story_covers
        WHERE cover_id=$1 AND task_id=$2 AND story_id=$3 AND created_at>now()-interval '24 hours' FOR UPDATE`,
        [input.cover_id,task,input.story_id])).rows[0] : null;
      if (input.cover_id && !cover) return this.#empty(input.attempt_id,input.story_id,task || null,'COVER_NOT_FOUND','REJECTED');
      if (input.text === null && !cover) return this.#empty(input.attempt_id,input.story_id,task || null,'COVER_REQUIRED','REJECTED');
      let parts: string[];
      let caption: string | null = null;
      try {
        if (input.text === null) parts = [];
        else if (cover) ({caption,parts} = splitCoverStoryText(input.text));
        else parts = splitStoryText(input.text);
      }
      catch (error) { return this.#empty(input.attempt_id,input.story_id,task || null,error instanceof TextFormatError ? error.code : 'FORMAT_INVALID','REJECTED'); }
      const hash = createHash('sha256').update(JSON.stringify([FORMAT_POLICY, task, channel, cover?.sha256 ?? null, input.text])).digest('hex');
      const saved = await db.query<DeliveryRow>(`INSERT INTO telegram_deliveries
        (attempt_id,instance_id,task_id,story_id,channel_id,content_hash,parts,total_parts,state,cover_id,cover_sha256,cover_bytes,cover_mime,cover_caption)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'QUEUED',$9,$10,$11,$12,$13) RETURNING *`,
        [input.attempt_id,this.instanceId,task,input.story_id,channel,hash,JSON.stringify(parts),parts.length+(input.cover_id ? 1 : 0),
          input.cover_id,cover?.sha256 ?? null,cover?.image_bytes ?? null,cover?.mime_type ?? null,caption]);
      if (input.cover_id) await db.query('DELETE FROM telegram_story_covers WHERE cover_id=$1',[input.cover_id]);
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
    return { service_version: '0.18.0', instance_id: this.instanceId, delivery_mode: 'worker', publish_enabled: this.#enabled,
      telegram_ready: ready, channel_title: null, channel_username: null, format_policy: 'cover_caption_then_sequential_text_posts',
      publication_modes: ['cover_text','cover_only','text_only'],
      task_status, queued_attempts: Number(pending.rows[0]?.count ?? 0),
      reason_code: this.#stopped ? 'SHUTTING_DOWN' : !this.#enabled ? 'PUBLISH_DISABLED' : ready ? null : 'WORKER_NOT_READY' };
  }
  routes() { return [...this.#routes].map(([task_id,channel_id]) => ({task_id,channel_id})); }
  async #recoverExpired() {
    // Sent but unacknowledged parts require a person to inspect the channel.
    await this.#pool.query(`UPDATE telegram_deliveries SET state='UNKNOWN',code='DELIVERY_UNKNOWN',lease_id=NULL,lease_until=NULL,
      parts=NULL,cover_bytes=NULL,updated_at=now() WHERE state='SENDING' AND lease_until < now()`);
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
    if (!this.#enabled || this.#stopped) return { code: 'PUBLISH_DISABLED' as const };
    return locked(this.#pool, async db => {
      // A send may have succeeded before its acknowledgement was lost. Never resend it.
      await db.query(`UPDATE telegram_deliveries SET state='UNKNOWN',code='DELIVERY_UNKNOWN',lease_id=NULL,lease_until=NULL,
        parts=NULL,cover_bytes=NULL,updated_at=now() WHERE state='SENDING' AND lease_until < now()`);
      const found = await db.query<DeliveryRow>(`SELECT * FROM telegram_deliveries WHERE
        (state='QUEUED' AND available_at<=now()) OR (state='CLAIMED' AND lease_until<now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = found.rows[0];
      if (!row) return { status:'empty' as const };
      if (this.#routes.get(row.task_id) !== row.channel_id) {
        await db.query(`UPDATE telegram_deliveries SET state=$2,code='ROUTE_CHANGED',parts=NULL,cover_bytes=NULL,lease_id=NULL,lease_until=NULL WHERE attempt_id=$1`,
          [row.attempt_id,row.confirmed.length ? 'PARTIAL':'REJECTED']);
        return { status:'empty' as const };
      }
      const lease = randomUUID();
      await db.query(`UPDATE telegram_deliveries SET state='CLAIMED',lease_id=$2,lease_until=now()+interval '2 minutes',updated_at=now()
        WHERE attempt_id=$1`,[row.attempt_id,lease]);
      return { status:'claimed' as const, attempt_id:row.attempt_id, lease_id:lease, task_id:row.task_id,
        channel_id:row.channel_id, part_index:row.next_part+1,
        ...(row.cover_id && row.next_part === 0
          ? { kind:'photo', mime_type:row.cover_mime, sha256:row.cover_sha256, image_base64:row.cover_bytes!.toString('base64'),
              ...(row.cover_caption === null ? {} : { caption:row.cover_caption }) }
          : { kind:'text', text:row.parts![row.next_part-(row.cover_id ? 1 : 0)] }) };
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
        await db.query(`UPDATE telegram_deliveries SET state=$2,code='CHANNEL_ID_CHANGED',parts=NULL,cover_bytes=NULL,lease_id=NULL,
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
      const state = data.outcome.kind === 'confirmed' ? (next === row.total_parts ? 'PUBLISHED':'QUEUED')
        : data.outcome.kind === 'unknown' ? 'UNKNOWN' : row.confirmed.length ? 'PARTIAL':'REJECTED';
      const code = data.outcome.kind === 'unknown' ? 'DELIVERY_UNKNOWN' : data.outcome.kind === 'rejected' ? data.outcome.code : null;
      const result = await db.query<DeliveryRow>(`UPDATE telegram_deliveries SET state=$2,code=$3,confirmed=$4::jsonb,next_part=$5,
        parts=CASE WHEN $2='QUEUED' THEN parts ELSE NULL END,
        cover_bytes=CASE WHEN $5=0 AND $2='QUEUED' THEN cover_bytes ELSE NULL END,
        lease_id=NULL,lease_until=NULL,updated_at=now()
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

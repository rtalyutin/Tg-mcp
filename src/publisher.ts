import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { splitStoryText, hasSafePartBoundaries, TextFormatError, MAX_MESSAGE_UNITS } from './formatter.ts';

export const FORMAT_POLICY = 'sequential_text_posts';
export const MAX_TEXT_BYTES = 256 * 1024;
export const DEFAULT_MAX_ATTEMPTS = 1000;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const CHANNEL_ID_PATTERN = /^-[1-9]\d*$/;
export const CHANNEL_DESTINATION_PATTERN = /^(?:-[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const validText = (s: string) => s.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(s);
export const publishInputSchema = z.strictObject({
  story_id: z.string().min(1).max(256).refine(s => s.trim().length > 0),
  task_id: z.string().regex(TASK_ID_PATTERN).optional(),
  attempt_id: z.uuid(), expected_instance_id: z.uuid(),
  text: z.string().refine(validText).refine(s => Buffer.byteLength(s, 'utf8') <= MAX_TEXT_BYTES),
});
export const attemptInputSchema = z.strictObject({ attempt_id: z.uuid(), expected_instance_id: z.uuid() });
export const publishResultSchema = z.strictObject({
  story_id: z.string().nullable(), attempt_id: z.uuid(), instance_id: z.uuid(),
  task_id: z.string().nullable(), channel_id: z.string().nullable(),
  status: z.enum(['PUBLISHED', 'REJECTED', 'PARTIAL', 'UNKNOWN', 'IN_PROGRESS', 'QUEUED', 'CLAIMED', 'SENDING']),
  confirmed_messages: z.array(z.strictObject({ part_index: z.number().int().positive(), message_id: z.number().int().positive().safe(), message_url: z.null() })),
  uncertain_part_index: z.number().int().positive().nullable(),
  remaining_parts: z.number().int().nonnegative().nullable(),
  code: z.string().nullable(), manual_check_required: z.boolean(), automatic_retry_allowed: z.literal(false),
});
export type PublishInput = z.infer<typeof publishInputSchema>;
export type PublishResult = z.infer<typeof publishResultSchema>;
const deliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirmed'), message_id: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal('rejected'), code: z.enum(['SEND_REJECTED', 'RATE_LIMITED', 'BOT_FORBIDDEN']) }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type DeliveryOutcome = z.infer<typeof deliverySchema>;
export interface Sender { send(channelId: string, text: string): Promise<unknown> }
export interface PublisherOptions {
  channelId?: string;
  taskChannels?: Readonly<Record<string, string>>;
  sender: Sender;
  // Supplied by the integration layer, which must authenticate the caller and
  // check Telegram channel type/rights. Defaults fail closed.
  readiness?: () => { publishEnabled: boolean; telegramReady: boolean };
  // Optional authoritative asynchronous check under the attempt/channel lock.
  // When present, replaces the synchronous telegramReady flag, never publishEnabled.
  // A verified @username may resolve to a numeric Telegram ID for this send.
  preflight?: (channelId: string) => Promise<boolean | string>;
  maxAttempts?: number;
  // RAM-only monotonic admission limit for new stories. Known attempts bypass it.
  minPublishIntervalMs?: number;
  // Internal dependency, never a public input. The whole package is checked.
  format?: (text: string) => string[];
}
type Attempt = { hash: string; result: PublishResult };

/** In-process coordination only. No disk, no restart recovery, no retries. */
export class Publisher {
  readonly instanceId = randomUUID();
  #attempts = new Map<string, Attempt>();
  #stories = new Map<string, string>();
  #busy = false;
  #channel?: string;
  #taskChannels?: Map<string, string>;
  #send: Sender['send'];
  #readiness: NonNullable<PublisherOptions['readiness']>;
  #format: NonNullable<PublisherOptions['format']>;
  #limit: number;
  #preflight: PublisherOptions['preflight'];
  #stopping = false;
  #minPublishIntervalMs: number;
  #lastPublishStarted = -Infinity;
  #idle: Promise<void> = Promise.resolve();
  constructor(options: PublisherOptions) {
    if (options.taskChannels !== undefined) {
      if (options.channelId !== undefined) throw new Error('Choose one channel configuration');
      const entries = Object.entries(options.taskChannels);
      if (!entries.length || entries.length > 32 || entries.some(([task, channel]) => !TASK_ID_PATTERN.test(task) || !CHANNEL_DESTINATION_PATTERN.test(channel))) {
        throw new Error('Invalid task channel configuration');
      }
      this.#taskChannels = new Map(entries);
    } else if (!options.channelId || !CHANNEL_DESTINATION_PATTERN.test(options.channelId)) throw new Error('Invalid configured channel ID');
    const limit = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid attempt limit');
    this.#limit = limit; this.#channel = options.channelId;
    this.#minPublishIntervalMs = options.minPublishIntervalMs ?? 0;
    if (!Number.isSafeInteger(this.#minPublishIntervalMs) || this.#minPublishIntervalMs < 0) throw new Error('Invalid publish interval');
    // Copy selected configuration; later mutation of options cannot switch channel.
    if (typeof options.sender?.send !== 'function') throw new Error('Sender is required');
    this.#send = options.sender.send.bind(options.sender);
    this.#readiness = options.readiness ?? (() => ({ publishEnabled: false, telegramReady: false }));
    this.#format = options.format ?? splitStoryText;
    this.#preflight = options.preflight;
  }
  /** Permanent for this instance. Wait for the current request, never start a new part. */
  stop(): Promise<void> { this.#stopping = true; return this.#idle; }
  #result(attemptId: string, storyId: string | null, status: PublishResult['status'], code: string | null, remaining: number | null = null, taskId: string | null = null, channelId: string | null = null): PublishResult {
    return { story_id: storyId, attempt_id: attemptId, instance_id: this.instanceId, status,
      task_id: taskId, channel_id: channelId,
      confirmed_messages: [], uncertain_part_index: null, remaining_parts: remaining,
      code, manual_check_required: status === 'UNKNOWN', automatic_retry_allowed: false };
  }
  getAttemptStatus(input: unknown): PublishResult {
    const data = attemptInputSchema.parse(input);
    if (data.expected_instance_id !== this.instanceId) return this.#result(data.attempt_id, null, 'UNKNOWN', 'INSTANCE_CHANGED');
    const found = this.#attempts.get(data.attempt_id);
    return found ? structuredClone(found.result) : this.#result(data.attempt_id, null, 'UNKNOWN', 'ATTEMPT_NOT_KNOWN');
  }
  async publish(input: unknown): Promise<PublishResult> {
    const data = publishInputSchema.parse(input);
    if (data.expected_instance_id !== this.instanceId) return this.#result(data.attempt_id, data.story_id, 'UNKNOWN', 'INSTANCE_CHANGED');
    const task = data.task_id ?? null;
    const channel = this.#taskChannels ? (task ? this.#taskChannels.get(task) : undefined) : this.#channel;
    // The route is server-owned. Never accept a caller-supplied Telegram chat ID.
    if (!channel) return this.#result(data.attempt_id, data.story_id, 'REJECTED', task ? 'TASK_NOT_CONFIGURED' : 'TASK_REQUIRED', null, task);
    const hash = createHash('sha256').update(JSON.stringify([FORMAT_POLICY, task, channel, data.text]), 'utf8').digest('hex');
    const byAttempt = this.#attempts.get(data.attempt_id);
    if (byAttempt) {
      if (byAttempt.hash === hash && byAttempt.result.story_id === data.story_id) return structuredClone(byAttempt.result);
      const conflict = this.#result(data.attempt_id, data.story_id, 'REJECTED', 'ATTEMPT_CONFLICT', null, task, channel);
      conflict.manual_check_required = true; return conflict;
    }
    const storyKey = JSON.stringify([task, data.story_id]);
    const canonical = this.#stories.get(storyKey);
    if (canonical) {
      const found = this.#attempts.get(canonical)!;
      if (found.hash === hash) return structuredClone(found.result);
      const conflict = this.#result(data.attempt_id, data.story_id, 'REJECTED', 'STORY_CONFLICT', null, task, channel);
      conflict.manual_check_required = true; return conflict;
    }
    // Only new attempts reach mutable configuration and readiness checks.
    if (this.#stopping) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'SHUTTING_DOWN');
    let readiness;
    try { readiness = this.#readiness(); }
    catch { return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'READINESS_FAILED'); }
    if (readiness?.publishEnabled !== true) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'PUBLISH_DISABLED');
    if (channel.startsWith('@') && !this.#preflight) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'TELEGRAM_NOT_READY');
    if (!this.#preflight && readiness.telegramReady !== true) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'TELEGRAM_NOT_READY');
    if (this.#attempts.size >= this.#limit) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'REGISTRY_FULL');
    if (this.#busy) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'BUSY');
    if (performance.now() - this.#lastPublishStarted < this.#minPublishIntervalMs) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'PUBLISH_RATE_LIMITED');
    let parts: string[];
    try { parts = this.#format(data.text); }
    catch (error) { return this.#result(data.attempt_id, data.story_id, 'REJECTED', error instanceof TextFormatError ? error.code : 'FORMAT_INVALID'); }
    // Validate all parts before any send, even when a formatter is injected.
    if (!Array.isArray(parts) || parts.length === 0 || parts.some(p => typeof p !== 'string' || !validText(p) || p.length > MAX_MESSAGE_UNITS) || parts.join('') !== data.text || !hasSafePartBoundaries(data.text, parts)) {
      return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'FORMAT_INVALID');
    }
    // Own the array: caller cannot change pending parts while send is awaited.
    parts = [...parts];
    const state = this.#result(data.attempt_id, data.story_id, 'IN_PROGRESS', null, parts.length, task, channel);
    this.#attempts.set(data.attempt_id, { hash, result: state });
    this.#stories.set(storyKey, data.attempt_id);
    this.#busy = true; // No await before atomic registration + channel lock.
    let idle!: () => void;
    this.#idle = new Promise<void>(resolve => { idle = resolve; });
    let deliveryChannel = channel;
    try {
      if (this.#preflight) {
        let ready = false;
        let code = 'TELEGRAM_NOT_READY';
        try {
          const verified = await this.#preflight(channel);
          if (verified === true && CHANNEL_ID_PATTERN.test(channel)) ready = true;
          else if (channel.startsWith('@') && typeof verified === 'string' && CHANNEL_ID_PATTERN.test(verified)) {
            deliveryChannel = verified; ready = true;
          }
        }
        catch { code = 'READINESS_FAILED'; }
        if (this.#stopping || !ready) {
          state.status = 'REJECTED'; state.code = this.#stopping ? 'SHUTTING_DOWN' : code;
          return structuredClone(state);
        }
        // Configuration may have changed while the asynchronous check was running.
        try { ready = this.#readiness().publishEnabled === true; }
        catch { ready = false; }
        if (!ready) { state.status = 'REJECTED'; state.code = 'PUBLISH_DISABLED'; return structuredClone(state); }
      }
      state.channel_id = deliveryChannel;
      // A failed rights check has not started a publication and must not
      // consume the global admission interval for another configured task.
      this.#lastPublishStarted = performance.now();
      for (let i = 0; i < parts.length; i++) {
        if (this.#stopping) {
          state.status = state.confirmed_messages.length ? 'PARTIAL' : 'REJECTED';
          state.code = 'SHUTTING_DOWN'; state.remaining_parts = parts.length - i;
          state.manual_check_required = state.status === 'PARTIAL';
          return structuredClone(state);
        }
        state.remaining_parts = parts.length - i - 1;
        let outcome: DeliveryOutcome;
        try {
          const parsed = deliverySchema.safeParse(await this.#send(deliveryChannel, parts[i]));
          outcome = parsed.success ? parsed.data : { kind: 'unknown' };
        } catch { outcome = { kind: 'unknown' }; }
        if (outcome.kind === 'unknown') {
          state.status = 'UNKNOWN'; state.code = 'DELIVERY_UNKNOWN';
          state.uncertain_part_index = i + 1; state.manual_check_required = true;
          return structuredClone(state);
        }
        if (outcome.kind === 'rejected') {
          state.status = state.confirmed_messages.length ? 'PARTIAL' : 'REJECTED';
          state.code = outcome.code;
          state.manual_check_required = state.status === 'PARTIAL';
          return structuredClone(state);
        }
        state.confirmed_messages.push({ part_index: i + 1, message_id: outcome.message_id, message_url: null });
      }
      state.status = 'PUBLISHED'; return structuredClone(state);
    } finally {
      this.#busy = false;
      idle();
      // Retained records contain IDs, hashes and results, never text/parts.
    }
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { splitStoryText, hasSafePartBoundaries, TextFormatError, MAX_MESSAGE_UNITS } from './formatter.ts';

export const FORMAT_POLICY = 'sequential_text_posts';
export const MAX_TEXT_BYTES = 256 * 1024;
export const DEFAULT_MAX_ATTEMPTS = 1000;
const validText = (s: string) => s.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(s);
export const publishInputSchema = z.strictObject({
  story_id: z.string().min(1).max(256).refine(s => s.trim().length > 0),
  attempt_id: z.uuid(), expected_instance_id: z.uuid(),
  text: z.string().refine(validText).refine(s => Buffer.byteLength(s, 'utf8') <= MAX_TEXT_BYTES),
});
export const attemptInputSchema = z.strictObject({ attempt_id: z.uuid(), expected_instance_id: z.uuid() });
export const publishResultSchema = z.strictObject({
  story_id: z.string().nullable(), attempt_id: z.uuid(), instance_id: z.uuid(),
  status: z.enum(['PUBLISHED', 'REJECTED', 'PARTIAL', 'UNKNOWN', 'IN_PROGRESS']),
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
  channelId: string;
  sender: Sender;
  // Supplied by the integration layer, which must authenticate the caller and
  // check Telegram channel type/rights. Defaults fail closed.
  readiness?: () => { publishEnabled: boolean; telegramReady: boolean };
  // Optional authoritative asynchronous check under the attempt/channel lock.
  // When present, replaces the synchronous telegramReady flag, never publishEnabled.
  preflight?: () => Promise<boolean>;
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
  #channel: string;
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
    if (!/^-[1-9]\d*$/.test(options.channelId)) throw new Error('Invalid configured channel ID');
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
  #result(attemptId: string, storyId: string | null, status: PublishResult['status'], code: string | null, remaining: number | null = null): PublishResult {
    return { story_id: storyId, attempt_id: attemptId, instance_id: this.instanceId, status,
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
    const hash = createHash('sha256').update(JSON.stringify([FORMAT_POLICY, data.text]), 'utf8').digest('hex');
    const byAttempt = this.#attempts.get(data.attempt_id);
    if (byAttempt) {
      if (byAttempt.hash === hash && byAttempt.result.story_id === data.story_id) return structuredClone(byAttempt.result);
      const conflict = this.#result(data.attempt_id, data.story_id, 'REJECTED', 'ATTEMPT_CONFLICT');
      conflict.manual_check_required = true; return conflict;
    }
    const canonical = this.#stories.get(data.story_id);
    if (canonical) {
      const found = this.#attempts.get(canonical)!;
      if (found.hash === hash) return structuredClone(found.result);
      const conflict = this.#result(data.attempt_id, data.story_id, 'REJECTED', 'STORY_CONFLICT');
      conflict.manual_check_required = true; return conflict;
    }
    // Only new attempts reach mutable configuration and readiness checks.
    if (this.#stopping) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'SHUTTING_DOWN');
    let readiness;
    try { readiness = this.#readiness(); }
    catch { return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'READINESS_FAILED'); }
    if (readiness?.publishEnabled !== true) return this.#result(data.attempt_id, data.story_id, 'REJECTED', 'PUBLISH_DISABLED');
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
    const state = this.#result(data.attempt_id, data.story_id, 'IN_PROGRESS', null, parts.length);
    this.#attempts.set(data.attempt_id, { hash, result: state });
    this.#stories.set(data.story_id, data.attempt_id);
    this.#busy = true; // No await before atomic registration + channel lock.
    this.#lastPublishStarted = performance.now();
    let idle!: () => void;
    this.#idle = new Promise<void>(resolve => { idle = resolve; });
    try {
      if (this.#preflight) {
        let ready = false;
        let code = 'TELEGRAM_NOT_READY';
        try { ready = await this.#preflight() === true; }
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
          const parsed = deliverySchema.safeParse(await this.#send(this.#channel, parts[i]));
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

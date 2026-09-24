import type { DeliveryOutcome, Sender } from './publisher.ts';
import { CHANNEL_DESTINATION_PATTERN } from './publisher.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const tokenPattern = /^[1-9]\d*:[A-Za-z0-9_-]+$/;
const channelPattern = /^-[1-9]\d*$/;

export interface TelegramSenderOptions {
  botToken: string;
  timeoutMs?: number;
  /** Internal test seam. Production code must keep the official HTTPS root. */
  apiRoot?: string;
}

function validateApiRoot(value: string): URL {
  const url = new URL(value);
  const production = url.protocol === 'https:' && url.hostname === 'api.telegram.org' && (url.port === '' || url.port === '443');
  const localTest = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '';
  if ((!production && !localTest) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Telegram API root');
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}

function configuration(options: TelegramSenderOptions) {
  if (!tokenPattern.test(options.botToken) || options.botToken.length > 256) throw new Error('Invalid Telegram bot token');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Invalid Telegram timeout');
  const root = validateApiRoot(options.apiRoot ?? 'https://api.telegram.org/');
  return { timeoutMs, root };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Telegram response too large');
  }
  if (!response.body) throw new Error('Telegram response missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Telegram response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function rejectedFor(code: number): DeliveryOutcome {
  if (code === 429) return { kind: 'rejected', code: 'RATE_LIMITED' };
  if (code === 401 || code === 403) return { kind: 'rejected', code: 'BOT_FORBIDDEN' };
  return { kind: 'rejected', code: 'SEND_REJECTED' };
}

function classify(responseStatus: number, body: unknown): DeliveryOutcome {
  if (responseStatus !== 200) {
    if (responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408) return rejectedFor(responseStatus);
    return { kind: 'unknown' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unknown' };
  const data = body as Record<string, unknown>;
  if (data.ok === true) {
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) return { kind: 'unknown' };
    const messageId = (data.result as Record<string, unknown>).message_id;
    return Number.isSafeInteger(messageId) && (messageId as number) > 0
      ? { kind: 'confirmed', message_id: messageId as number }
      : { kind: 'unknown' };
  }
  if (data.ok === false && Number.isSafeInteger(data.error_code)) {
    const code = data.error_code as number;
    if (code >= 400 && code < 500 && code !== 408) return rejectedFor(code);
  }
  return { kind: 'unknown' };
}

/** One application-level HTTP request per call. No retries and no redirects. */
export class TelegramSender implements Sender {
  #endpoint: URL;
  #photoEndpoint: URL;
  #timeoutMs: number;
  constructor(options: TelegramSenderOptions) {
    const { timeoutMs, root } = configuration(options);
    // `./` keeps the colon inside the token from being parsed as a URL scheme.
    this.#endpoint = new URL(`./bot${options.botToken}/sendMessage`, root);
    this.#photoEndpoint = new URL(`./bot${options.botToken}/sendPhoto`, root);
    this.#timeoutMs = timeoutMs;
  }

  async send(channelId: string, text: string): Promise<DeliveryOutcome> {
    if (!channelPattern.test(channelId) || typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.length > 4096) {
      return { kind: 'rejected', code: 'SEND_REJECTED' };
    }
    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ chat_id: channelId, text }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        await response.body?.cancel().catch(() => undefined);
        return rejectedFor(response.status);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'unknown' };
      }
      return classify(response.status, await readJson(response));
    } catch {
      return { kind: 'unknown' };
    }
  }

  async sendPhoto(channelId: string, photo: Buffer): Promise<DeliveryOutcome> {
    if (!channelPattern.test(channelId) || photo.length < 45 || photo.length > 7 * 1024 * 1024 ||
        photo.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { kind:'rejected',code:'SEND_REJECTED' };
    const body = new FormData();
    body.set('chat_id', channelId);
    body.set('photo', new Blob([new Uint8Array(photo)], { type:'image/png' }), 'cover.png');
    try {
      const response = await fetch(this.#photoEndpoint, {
        method:'POST', redirect:'error', headers:{ accept:'application/json' }, body,
        signal:AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        await response.body?.cancel().catch(() => undefined);
        return rejectedFor(response.status);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { kind:'unknown' };
      }
      return classify(response.status, await readJson(response));
    } catch { return { kind:'unknown' }; }
  }
}

export type TelegramReadiness =
  | { ready: true; channel_title: string; channel_username: string | null; resolved_channel_id?: string }
  | { ready: false; code: 'TELEGRAM_NOT_READY'; check_code?: 'CHANNEL_INVALID' | 'BOT_TOKEN_REJECTED' | 'BOT_HTTP_ERROR'
      | 'BOT_RESPONSE_INVALID' | 'BOT_TRANSPORT_FAILED' | 'BOT_IDENTITY_INVALID'
      | 'CHANNEL_CHECK_FAILED' | 'CHANNEL_MISMATCH' | 'BOT_MEMBERSHIP_CHECK_FAILED' | 'BOT_NOT_ADMIN'
      | 'BOT_IDENTITY_MISMATCH' | 'POST_PERMISSION_MISSING' };

class TelegramReadinessHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super('Telegram readiness HTTP failure'); this.status = status; }
}
class TelegramReadinessResponseError extends Error {
  constructor() { super('Telegram readiness response invalid'); }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read-only snapshot. Never calls sendMessage, logs responses, caches success or retries. */
export class TelegramReadinessChecker {
  #endpoints: Record<'getMe' | 'getChat' | 'getChatMember', URL>;
  #timeoutMs: number;
  constructor(options: TelegramSenderOptions) {
    const { timeoutMs, root } = configuration(options);
    this.#timeoutMs = timeoutMs;
    this.#endpoints = {
      getMe: new URL(`./bot${options.botToken}/getMe`, root),
      getChat: new URL(`./bot${options.botToken}/getChat`, root),
      getChatMember: new URL(`./bot${options.botToken}/getChatMember`, root),
    };
  }

  async #request(method: 'getMe' | 'getChat' | 'getChatMember', body: object, signal: AbortSignal) {
    const response = await fetch(this.#endpoints[method], {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramReadinessHttpError(response.status);
    }
    let data: Record<string, unknown> | null;
    try { data = record(await readJson(response)); }
    catch { throw new TelegramReadinessResponseError(); }
    if (data?.ok !== true) throw new TelegramReadinessResponseError();
    const result = record(data.result);
    if (!result) throw new TelegramReadinessResponseError();
    return result;
  }

  async check(channelId: string, diagnostics = false): Promise<TelegramReadiness> {
    const unavailable = (check_code: Extract<TelegramReadiness, { ready: false }>['check_code']) =>
      diagnostics ? ({ ready: false, code: 'TELEGRAM_NOT_READY', check_code } as const)
        : ({ ready: false, code: 'TELEGRAM_NOT_READY' } as const);
    if (!CHANNEL_DESTINATION_PATTERN.test(channelId)) return unavailable('CHANNEL_INVALID');
    // One deadline covers the complete sequence, including streamed bodies.
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let bot: Record<string, unknown>;
    try { bot = await this.#request('getMe', {}, signal); }
    catch (error) {
      if (error instanceof TelegramReadinessHttpError) return unavailable([401, 404].includes(error.status) ? 'BOT_TOKEN_REJECTED' : 'BOT_HTTP_ERROR');
      return unavailable(error instanceof TelegramReadinessResponseError ? 'BOT_RESPONSE_INVALID' : 'BOT_TRANSPORT_FAILED');
    }
    if (bot.is_bot !== true || !Number.isSafeInteger(bot.id) || (bot.id as number) <= 0) return unavailable('BOT_IDENTITY_INVALID');
    let chat: Record<string, unknown>;
    try { chat = await this.#request('getChat', { chat_id: channelId }, signal); }
    catch { return unavailable('CHANNEL_CHECK_FAILED'); }
    try {
      const resolvedId = String(chat.id);
      if (chat.type !== 'channel' || !Number.isSafeInteger(chat.id) || !channelPattern.test(resolvedId) || typeof chat.title !== 'string') return unavailable('CHANNEL_INVALID');
      if (chat.username !== undefined && typeof chat.username !== 'string') return unavailable('CHANNEL_INVALID');
      if (channelId.startsWith('@') ? typeof chat.username !== 'string' || `@${chat.username}`.toLowerCase() !== channelId.toLowerCase() : resolvedId !== channelId) return unavailable('CHANNEL_MISMATCH');
      let member: Record<string, unknown>;
      try { member = await this.#request('getChatMember', { chat_id: channelId.startsWith('@') ? resolvedId : channelId, user_id: bot.id }, signal); }
      catch { return unavailable('BOT_MEMBERSHIP_CHECK_FAILED'); }
      const user = record(member.user);
      if (user?.id !== bot.id || user?.is_bot !== true) return unavailable('BOT_IDENTITY_MISMATCH');
      if (member.status !== 'administrator') return unavailable('BOT_NOT_ADMIN');
      if (member.can_post_messages !== true) return unavailable('POST_PERMISSION_MISSING');
      return { ready: true, channel_title: chat.title, channel_username: typeof chat.username === 'string' ? chat.username : null,
        ...(channelId.startsWith('@') ? { resolved_channel_id: resolvedId } : {}) };
    } catch {
      // Never disclose Bot API URLs, tokens, server messages or response bodies.
      return unavailable('CHANNEL_CHECK_FAILED');
    }
  }
}

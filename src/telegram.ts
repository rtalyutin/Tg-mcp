import type { DeliveryOutcome, Sender } from './publisher.ts';

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
  #timeoutMs: number;
  constructor(options: TelegramSenderOptions) {
    if (!tokenPattern.test(options.botToken) || options.botToken.length > 256) throw new Error('Invalid Telegram bot token');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Invalid Telegram timeout');
    const root = validateApiRoot(options.apiRoot ?? 'https://api.telegram.org/');
    // `./` keeps the colon inside the token from being parsed as a URL scheme.
    this.#endpoint = new URL(`./bot${options.botToken}/sendMessage`, root);
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
}

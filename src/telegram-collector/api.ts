export class TelegramCollectorError extends Error {
  readonly code: string;
  readonly retryAfter: number;
  constructor(code: string, retryAfter = 5) {
    super(code); this.name = 'TelegramCollectorError'; this.code = code; this.retryAfter = retryAfter;
  }
}

export interface CollectorApi {
  getMe(signal?: AbortSignal): Promise<unknown>;
  getWebhookInfo(signal?: AbortSignal): Promise<unknown>;
  getBusinessConnection(id: string, signal?: AbortSignal): Promise<unknown>;
  getUpdates(offset: number | null, signal?: AbortSignal): Promise<unknown[]>;
}

const allowedUpdates = ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'];
const maxResponseBytes = 4 * 1024 * 1024;

/** Deliberately has no Telegram write methods or webhook mutation. */
export class TelegramCollectorApi implements CollectorApi {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) { this.token = token; this.fetcher = fetcher; }

  private async call(method: 'getMe' | 'getWebhookInfo' | 'getBusinessConnection' | 'getUpdates', body: object, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
      });
      if (Number(response.headers.get('content-length') ?? 0) > maxResponseBytes) {
        await response.body?.cancel(); throw new TelegramCollectorError('TGC_RESPONSE_TOO_LARGE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TelegramCollectorError('TGC_RESPONSE_INVALID');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxResponseBytes) { await reader.cancel(); throw new TelegramCollectorError('TGC_RESPONSE_TOO_LARGE'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new TelegramCollectorError('TGC_RESPONSE_INVALID'); }
      const data = result as { ok?: unknown; result?: unknown; error_code?: unknown; parameters?: { retry_after?: unknown } } | null;
      if (response.status === 429 || data?.error_code === 429) {
        const retry = Number(data?.parameters?.retry_after);
        throw new TelegramCollectorError('TGC_RATE_LIMITED', Number.isInteger(retry) ? Math.min(300, Math.max(1, retry)) : 30);
      }
      if (response.status === 401 || data?.error_code === 401) throw new TelegramCollectorError('TGC_UNAUTHORIZED', 30);
      if (response.status === 409 || data?.error_code === 409) throw new TelegramCollectorError('TGC_CONFLICT', 30);
      if (!response.ok || data?.ok !== true || !('result' in data)) throw new TelegramCollectorError('TGC_API_UNAVAILABLE');
      return data.result;
    } catch (error) {
      if (error instanceof TelegramCollectorError) throw error;
      // Transport errors often include the token-bearing URL; never propagate it.
      throw new TelegramCollectorError(signal?.aborted ? 'TGC_ABORTED' : 'TGC_NETWORK_UNAVAILABLE');
    }
  }
  getMe(signal?: AbortSignal) { return this.call('getMe', {}, signal); }
  getWebhookInfo(signal?: AbortSignal) { return this.call('getWebhookInfo', {}, signal); }
  getBusinessConnection(id: string, signal?: AbortSignal) { return this.call('getBusinessConnection', { business_connection_id: id }, signal); }
  async getUpdates(offset: number | null, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.call('getUpdates', { ...(offset === null ? {} : { offset }), timeout: 25, limit: 100, allowed_updates: allowedUpdates }, signal);
    if (!Array.isArray(result) || result.length > 100) throw new TelegramCollectorError('TGC_RESPONSE_INVALID');
    return result;
  }
}

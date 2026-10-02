/** Separate from MCP admission: SSR readers share one frontend IP. */
export class PublicReadLimit {
  private entries = new Map<string, { start: number; count: number }>();
  private maxPerMinute: number;
  private maxEntries: number;
  constructor(maxPerMinute = 120, maxEntries = 4096) { this.maxPerMinute=maxPerMinute; this.maxEntries=maxEntries; }
  admit(ip: string, now = Date.now()): boolean {
    for (const [key, entry] of this.entries) if (now - entry.start >= 60_000) this.entries.delete(key);
    const entry = this.entries.get(ip);
    if (entry) { if (entry.count >= this.maxPerMinute) return false; entry.count++; return true; }
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(ip, { start: now, count: 1 }); return true;
  }
}

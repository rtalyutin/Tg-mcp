/** Conservative UTF-16 budget; never split an extended grapheme cluster.
 * No normalization, trimming, markup, numbering, I/O or retained story data.
 */
export const MAX_MESSAGE_UNITS = 4096;
export class TextFormatError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('ru', { granularity: 'sentence' });
const words = new Intl.Segmenter('ru', { granularity: 'word' });

function upperBound(values: number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** limit is an internal test seam, not part of the MCP contract. */
export function splitStoryText(text: string, limit = MAX_MESSAGE_UNITS): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_UNITS) throw new TextFormatError('FORMAT_INVALID');
  if (typeof text !== 'string' || !text.isWellFormed() || !text.trim()) throw new TextFormatError('FORMAT_INVALID');
  if (text.length <= limit) return [text];

  const offsets = [0];
  const content: boolean[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment.length > limit) throw new TextFormatError('TEXT_GRAPHEME_TOO_LONG');
    offsets.push(index + segment.length);
    content.push(segment.trim().length > 0);
  }
  const n = content.length;
  // Suffix feasibility prevents a preferred cut from stranding whitespace or
  // a large cluster. DP range queries avoid backtracking/exponential search.
  const nextContent = new Int32Array(n + 1); nextContent[n] = n;
  const canFinish = new Uint8Array(n + 1); canFinish[n] = 1;
  const suffixCount = new Int32Array(n + 2); suffixCount[n] = 1;
  for (let i = n - 1; i >= 0; i--) {
    nextContent[i] = content[i] ? i : nextContent[i + 1];
    const first = nextContent[i] + 1;
    const last = upperBound(offsets, offsets[i] + limit) - 1;
    canFinish[i] = first <= last && suffixCount[first] > suffixCount[last + 1] ? 1 : 0;
    suffixCount[i] = suffixCount[i + 1] + canFinish[i];
  }
  if (!canFinish[0]) throw new TextFormatError('TEXT_CANNOT_SPLIT');

  // Rank complete separators with the preceding text. Only grapheme-safe,
  // feasible boundaries are considered below, even if ICU boundaries differ.
  const priority = new Map<number, number>();
  for (const { segment, index } of words.segment(text)) priority.set(index + segment.length, 1);
  for (const { segment, index } of sentences.segment(text)) priority.set(index + segment.length, 2);
  for (const match of text.matchAll(/(?:\r\n|[\r\n\u2028\u2029])(?:[ \t]*(?:\r\n|[\r\n\u2028\u2029]))*/g)) {
    priority.set(match.index + match[0].length, 3);
  }
  const parts: string[] = [];
  for (let start = 0; start < n;) {
    if (text.length - offsets[start] <= limit) { parts.push(text.slice(offsets[start])); break; }
    const last = upperBound(offsets, offsets[start] + limit) - 1;
    let chosen = -1, rank = -1;
    for (let end = nextContent[start] + 1; end <= last; end++) {
      if (!canFinish[end]) continue;
      const candidateRank = priority.get(offsets[end]) ?? 0;
      if (candidateRank >= rank) { chosen = end; rank = candidateRank; }
    }
    if (chosen < 0) throw new TextFormatError('TEXT_CANNOT_SPLIT');
    parts.push(text.slice(offsets[start], offsets[chosen]));
    start = chosen;
  }
  return parts;
}

/** Verify internal formatter injections against boundaries of the WHOLE input. */
export function hasSafePartBoundaries(text: string, parts: string[]): boolean {
  const cuts = new Set<number>();
  let offset = 0;
  for (const part of parts) { offset += part.length; cuts.add(offset); }
  for (const { segment, index } of graphemes.segment(text)) cuts.delete(index + segment.length);
  return cuts.size === 0;
}

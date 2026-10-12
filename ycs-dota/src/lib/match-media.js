import { getMatchMapSlots } from './match-center.js';

export const MATCH_MEDIA_SCHEMA = 1;
export const MATCH_MEDIA_MAX_TIME = 7 * 24 * 60 * 60;
export const mediaObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const mediaId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
export const mediaClipId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const mediaMapKey = (value) => typeof value === 'string' && /^(?:id:[a-zA-Z0-9_-]{1,128}|number:[1-9]\d?)$/.test(value);

// getRandomValues is also available on the existing HTTP local preview, unlike
// randomUUID. No timestamp/Math.random fallback weakens request identity.
export function createMediaRequestId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function mediaHttps(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch { return null; }
}

export function parseMediaTime(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,3}:)?\d{1,3}:[0-5]\d$/.test(value.trim())) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.length === 3 && parts[1] > 59) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds <= MATCH_MEDIA_MAX_TIME ? seconds : null;
}

export function formatMediaTime(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '';
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return `${h ? `${h}:` : ''}${String(h ? m : Math.floor(seconds / 60)).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// The external player owns playback. End time remains an editorial label;
// this application does not cut a file or promise the external player will stop.
export function matchMediaHref(clip) {
  const safe = mediaHttps(clip?.url);
  if (!safe) return null;
  if (clip.kind !== 'recording' || !Number.isSafeInteger(clip.startSeconds)) return safe;
  const url = new URL(safe);
  if ((url.hostname === 'youtu.be' && /^\/[\w-]+$/.test(url.pathname)) ||
      (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) && url.pathname === '/watch')) {
    url.searchParams.set('t', `${clip.startSeconds}s`);
  } else if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname) && /^\/videos\/\d+\/?$/.test(url.pathname)) {
    const n = clip.startSeconds;
    url.searchParams.set('t', `${Math.floor(n / 3600)}h${Math.floor(n / 60) % 60}m${n % 60}s`);
  }
  return url.href;
}

export function getMatchMediaMapCatalog(tournament, match) {
  return getMatchMapSlots({ ...match, discipline: match.discipline || tournament.discipline })
    .filter((slot) => slot.map !== null && !['scheduled', 'not-played'].includes(slot.state) && mediaMapKey(slot.key))
    .map((slot) => ({ mapKey: slot.key, mapNumber: slot.number, mapId: slot.mapId === null ? null : String(slot.mapId), name: slot.name }));
}

export function validMediaClip(clip) {
  if (!mediaObject(clip) || !mediaClipId(clip.id) || !mediaId(clip.tournamentId) || !mediaId(clip.matchId) ||
      !mediaMapKey(clip.mapKey) || !Number.isSafeInteger(clip.mapNumber) || clip.mapNumber < 1 || clip.mapNumber > 99 ||
      !(clip.mapId === null || typeof clip.mapId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(clip.mapId)) ||
      clip.mapKey !== (clip.mapId ? `id:${clip.mapId}` : `number:${clip.mapNumber}`) ||
      !['clip', 'recording'].includes(clip.kind) || mediaHttps(clip.url) !== clip.url ||
      typeof clip.title !== 'string' || clip.title.length > 160 || /[\u0000-\u001f\u007f]/.test(clip.title)) return false;
  const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MATCH_MEDIA_MAX_TIME;
  return clip.kind === 'clip' ? clip.startSeconds === null && clip.endSeconds === null :
    time(clip.startSeconds) && (clip.endSeconds === null || time(clip.endSeconds) && clip.endSeconds > clip.startSeconds);
}

export function getMatchMapClips(clips, slot) {
  if (!Array.isArray(clips) || !slot?.map || ['scheduled', 'not-played'].includes(slot.state)) return [];
  const mapId = slot.mapId === null || slot.mapId === undefined ? null : String(slot.mapId);
  return clips.filter((clip) => clip.mapKey === slot.key && clip.mapNumber === slot.number && clip.mapId === mapId && matchMediaHref(clip));
}

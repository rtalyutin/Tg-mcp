import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { flattenMatches } from '../src/lib/community.js';
import { applyDotaSnapshot, DOTA_RESULTS_URL, validateDotaSnapshot } from '../src/lib/dota-results.js';
import { getMatchMediaMapCatalog, matchMediaHref, mediaClipId, mediaHttps, mediaId, mediaMapKey, mediaObject, validMediaClip } from '../src/lib/match-media.js';
import { createMatchMediaS3Store, mediaFail } from './match-media-store.mjs';

const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matchesMap = (catalog) => new Map(catalog.map((match) => [`${match.tournamentId}/${match.id}`, match]));
const inMap = (clip, map) => clip.mapKey === map.mapKey && clip.mapNumber === map.mapNumber && clip.mapId === map.mapId;
const publicClip = (clip) => ({ id: clip.id, mapKey: clip.mapKey, mapNumber: clip.mapNumber, mapId: clip.mapId,
  kind: clip.kind, url: clip.url, title: clip.title, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds, href: matchMediaHref(clip) });

export function buildMatchMediaCatalog(tournaments) {
  const byId = new Map(tournaments.map((tournament) => [tournament.id, tournament]));
  return flattenMatches(tournaments).filter((match) => match.published !== false)
    .map((match) => ({ tournamentId: match.tournamentId, id: match.id, tournamentTitle: byId.get(match.tournamentId).title,
      team1: match.team1 || null, team2: match.team2 || null, bestOf: match.bestOf || null,
      maps: getMatchMediaMapCatalog(byId.get(match.tournamentId), match) }));
}

// Public-only catalog. Organizer assignments, sessions and captain state are never loaded here.
export function createMatchMediaCatalogSource({ fetcher = fetch, now = Date.now, baseline = null } = {}) {
  let baselinePromise, latest, refreshedAt = -Infinity, pending;
  return async () => {
    const original = await (baselinePromise ||= baseline ? Promise.resolve(structuredClone(baseline)) :
      Promise.all(['current-cs2-2026', 'dota2-autumn-2026', 'dota2-main-2026', 'cs2-february-2026', 'dota2-qual-2026']
        .map((name) => readFile(new URL(`../src/data/tournaments/${name}.json`, import.meta.url), 'utf8').then(JSON.parse))));
    const dota = original.find((tournament) => tournament.id === 'dota2-autumn-2026');
    if (dota && !pending && now() - refreshedAt >= 60_000) {
      pending = (async () => {
        try {
          const response = await fetcher(DOTA_RESULTS_URL, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
          if (response.ok) {
            const next = validateDotaSnapshot(await response.json(), dota);
            if (!latest || next.revision > latest.revision) latest = next;
            else if (next.revision === latest.revision && JSON.stringify(next) !== JSON.stringify(latest)) throw new Error();
          }
        } catch { /* Retain confirmed public fixtures; a failed read does not invent maps. */ }
        finally { refreshedAt = now(); }
      })().finally(() => { pending = null; });
    }
    if (pending) await pending;
    return buildMatchMediaCatalog(original.map((tournament) => tournament.id === dota?.id && latest ? applyDotaSnapshot(tournament, latest) : tournament));
  };
}

export function createMatchMediaService({ env = process.env, store = createMatchMediaS3Store({ env }),
  getCatalog = createMatchMediaCatalogSource(), now = Date.now, randomId = () => randomBytes(16).toString('hex') } = {}) {
  const catalog = async () => {
    const rows = await getCatalog();
    if (!Array.isArray(rows) || rows.some((row) => !mediaId(row.tournamentId) || !mediaId(row.id) || !Array.isArray(row.maps))) mediaFail('media_storage_unavailable', 503);
    return rows;
  };
  const currentClips = (value, rows) => {
    const matches = matchesMap(rows);
    return value.clips.filter((clip) => matches.get(`${clip.tournamentId}/${clip.matchId}`)?.maps.some((map) => inMap(clip, map)));
  };
  const organizerProjection = (value, rows) => ({ schemaVersion: 1, revision: value.revision, updatedAt: value.updatedAt,
    matches: rows.map((row) => ({ tournamentId: row.tournamentId, id: row.id, tournamentTitle: row.tournamentTitle,
      team1: row.team1, team2: row.team2, bestOf: row.bestOf || null,
      maps: row.maps.map((map) => ({ mapKey: map.mapKey, mapNumber: map.mapNumber, mapId: map.mapId, name: map.name })) })),
    clips: currentClips(value, rows).map((clip) => ({ ...publicClip(clip), tournamentId: clip.tournamentId, matchId: clip.matchId })) });
  return {
    async publicRead({ tournamentId, matchId } = {}) {
      if (!mediaId(tournamentId) || !mediaId(matchId)) mediaFail('media_invalid_request', 400);
      const rows = await catalog();
      const match = matchesMap(rows).get(`${tournamentId}/${matchId}`);
      if (!match) mediaFail('media_not_found', 404);
      const { value } = await store.read();
      const catalogVersion = hash(match.maps.map((map) => ({ mapKey: map.mapKey, mapNumber: map.mapNumber, mapId: map.mapId })));
      return { schemaVersion: 1, revision: value.revision, catalogVersion, updatedAt: value.updatedAt, tournamentId, matchId,
        clips: currentClips(value, rows).filter((clip) => clip.tournamentId === tournamentId && clip.matchId === matchId).map(publicClip) };
    },
    async organizer(body = null) {
      // This entry is reachable only after organizer-api authenticates the session.
      if (body !== null && (!mediaObject(body) || !only(body, ['action', 'requestId', 'expectedRevision', 'tournamentId', 'matchId', 'mapKey', 'clipId', 'kind', 'url', 'title', 'startSeconds', 'endSeconds']) ||
          !['upsert', 'delete'].includes(body.action) || !mediaClipId(body.requestId) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
          !mediaId(body.tournamentId) || !mediaId(body.matchId) || !mediaMapKey(body.mapKey) ||
          body.clipId !== undefined && !mediaClipId(body.clipId))) mediaFail('media_invalid_request', 400);
      const rows = await catalog();
      const previous = await store.read();
      if (body === null) return organizerProjection(previous.value, rows);
      const fingerprint = hash(body);
      const receipt = previous.value.requests[body.requestId];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) mediaFail('media_idempotency_conflict', 409);
        return organizerProjection(previous.value, rows);
      }
      const match = matchesMap(rows).get(`${body.tournamentId}/${body.matchId}`);
      const map = match?.maps.find((item) => item.mapKey === body.mapKey);
      if (!map) mediaFail('media_not_found', 404);
      if (body.expectedRevision !== previous.value.revision) mediaFail('media_conflict', 409);
      const value = structuredClone(previous.value);
      const existing = body.clipId && value.clips.find((clip) => clip.id === body.clipId);
      if (body.clipId && (!existing || existing.tournamentId !== body.tournamentId || existing.matchId !== body.matchId || !inMap(existing, map))) mediaFail('media_not_found', 404);
      if (body.action === 'delete') {
        if (!existing || !only(body, ['action', 'requestId', 'expectedRevision', 'tournamentId', 'matchId', 'mapKey', 'clipId'])) mediaFail('media_invalid_request', 400);
        value.clips = value.clips.filter((clip) => clip.id !== body.clipId);
      } else {
        const url = mediaHttps(body.url);
        if (!url) mediaFail('media_invalid_url', 400);
        const clip = { id: body.clipId || randomId(), tournamentId: body.tournamentId, matchId: body.matchId,
          mapKey: map.mapKey, mapNumber: map.mapNumber, mapId: map.mapId, kind: body.kind, url,
          title: body.title === undefined ? '' : body.title, startSeconds: body.startSeconds ?? null, endSeconds: body.endSeconds ?? null };
        if (!validMediaClip(clip)) mediaFail('media_invalid_request', 400);
        if (existing) value.clips[value.clips.indexOf(existing)] = clip;
        else value.clips.push(clip);
      }
      if (value.clips.length > 2048 || Object.keys(value.requests).length >= 8192) mediaFail('media_capacity_reached', 503);
      value.revision++;
      value.updatedAt = new Date(now()).toISOString();
      value.requests[body.requestId] = { fingerprint, revision: value.revision };
      const saved = await store.compareAndSet(previous, value, body.requestId);
      return organizerProjection(saved.value, rows);
    },
  };
}

export function createMatchMediaPublicHandler({ service, env = process.env } = {}) {
  const originAllowed = env.YCS_ORGS_ALLOWED_ORIGIN || 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
  return async (request, response, url) => {
    if (url.pathname !== '/api/match-media') return false;
    const send = (status, body, extra = {}) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body)); return true; };
    const origin = request.headers.origin;
    if (origin && origin !== originAllowed) return send(403, { error: 'origin_denied' });
    if (origin) { response.setHeader('access-control-allow-origin', origin); response.setHeader('vary', 'Origin'); }
    if (request.method === 'OPTIONS') return send(204, null, { 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' });
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD, OPTIONS' });
    if ([...url.searchParams.keys()].some((key) => !['tournamentId', 'matchId'].includes(key)) || url.searchParams.getAll('tournamentId').length !== 1 || url.searchParams.getAll('matchId').length !== 1) return send(400, { error: 'media_invalid_request' });
    try { return send(200, await service.publicRead({ tournamentId: url.searchParams.get('tournamentId'), matchId: url.searchParams.get('matchId') })); }
    catch (error) { return send(error.status || 503, { error: error.code || 'media_storage_unavailable' }); }
  };
}

import { normalizeResult } from './community.js';

const unique = (values) => [...new Set(values)];
const positiveId = (value) => /^[1-9]\d*$/.test(String(value ?? ''));
const bestOfCount = (value) => /^BO[135]$/.test(value || '') ? Number(value.slice(2)) : null;

export function getOpenDotaMapId(map) {
  for (const value of [map?.matchId, map?.id]) if (positiveId(value)) return String(value);
  try {
    const url = new URL(map?.url);
    const id = url.pathname.match(/^\/matches\/([1-9]\d*)\/?$/)?.[1];
    return url.protocol === 'https:' && ['opendota.com', 'www.opendota.com'].includes(url.hostname) ? id || null : null;
  } catch { return null; }
}

function sourceMapId(map, dota) {
  if (dota) return getOpenDotaMapId(map);
  const value = map?.matchId ?? map?.id;
  if (typeof value === 'string') return value.trim() || null;
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function publishedMaps(match, dota) {
  const records = [];
  for (const map of [...(match.maps || []), ...(match.mapLinks || [])]) {
    if (!map || map.published === false) continue;
    const id = sourceMapId(map, dota);
    const existing = id && records.find((record) => sourceMapId(record, dota) === id);
    if (existing) {
      // Maps carry statistics; supplemental links fill only missing values.
      for (const [key, value] of Object.entries(map)) if (existing[key] == null) existing[key] = value;
    } else records.push({ ...map });
  }
  if (!records.length && match.mapId) records.push({ id: match.mapId, name: match.map || undefined });
  // A confirmed BO1 round score is already the result of its one actual CS2 map.
  if (!dota && match.discipline === 'Counter-Strike 2' && match.bestOf === 'BO1' &&
      match.status === 'completed' && match.resultConfirmed === true && match.scoreKind === 'rounds') {
    if (!records.length) records.push({ name: match.map || undefined });
    if (records.length === 1 && records[0].resultConfirmed !== false) {
      for (const key of ['score1', 'score2']) if (records[0][key] == null) records[0][key] = match[key];
      if (!records[0].winnerTeamId && [match.team1Id, match.team2Id].includes(match.winnerTeamId)) records[0].winnerTeamId = match.winnerTeamId;
    }
  }
  return records;
}

/** One map order for the match center and manual clip catalog. No clock-based states. */
export function getMatchMapSlots(match, snapshot = null) {
  const dota = match.discipline === 'Dota 2';
  const records = publishedMaps(match, dota);
  const formatCount = bestOfCount(match.bestOf);
  const count = Math.max(formatCount || 1, records.length);
  const technical = ['walkover', 'bye'].includes(match.status) || match.scoreKind === 'technical';
  const confirmed = match.status === 'completed' && match.resultConfirmed === true;
  const series = normalizeResult(match, match.discipline).series;
  const requiredWins = formatCount ? Math.ceil(formatCount / 2) : null;
  const finalPlayedCount = confirmed && series && requiredWins &&
    Math.max(...series) === requiredWins && Math.min(...series) < requiredWins &&
    series[0] + series[1] <= formatCount ? series[0] + series[1] : null;
  // Only a BO1 snapshot with one explicit fixture binding can fill an absent map link.
  if (snapshot && !records.length && formatCount === 1 && snapshot.tournamentId === match.tournamentId) {
    const ids = unique([
      ...Object.entries(snapshot.maps || {}).filter(([, map]) => map.fixtureId === match.id).map(([id]) => id),
      ...(snapshot.players || []).flatMap((player) => player.records || [])
        .filter((record) => record.fixtureId === match.id).map((record) => record.matchId),
    ].filter(positiveId).map(String));
    if (ids.length === 1) records.push({ matchId: ids[0] });
  }
  return Array.from({ length: count }, (_, index) => {
    const raw = records[index] || null;
    const mapId = sourceMapId(raw, dota);
    const mapConfirmed = raw && raw.resultConfirmed !== false && !['scheduled', 'live', 'postponed', 'cancelled'].includes(raw.status) &&
      (confirmed || raw.resultConfirmed === true);
    const result = mapConfirmed ? normalizeResult({ maps: [raw], status: 'completed', resultConfirmed: true }, match.discipline).maps[0] : null;
    const explicitWinner = typeof raw?.winnerTeamId === 'string' && raw.winnerTeamId &&
      [match.team1Id, match.team2Id].includes(raw.winnerTeamId) ? raw.winnerTeamId : null;
    const csWinner = match.discipline === 'Counter-Strike 2' &&
      (confirmed || raw?.status === 'completed' && raw.resultConfirmed === true) &&
      result?.score && result.score[0] !== result.score[1]
      ? match[result.score[0] > result.score[1] ? 'team1Id' : 'team2Id'] || null : null;
    const winnerTeamId = technical || !mapConfirmed ? null : explicitWinner || csWinner;
    const statistics = Boolean(result?.score || result?.kills || result?.durationSeconds || winnerTeamId ||
      getPublishedMapStats(match, { map: raw, state: 'awaiting-data' }));
    const snapshotReady = dota && mapId && ['ready', 'estimated'].includes(snapshot?.maps?.[mapId]?.status);
    const technicalMap = confirmed && match.resultSource === 'organizer' && !raw &&
      match.technicalMapNumbers?.includes(index + 1);
    const notPlayed = technical || technicalMap || raw?.status === 'cancelled' || finalPlayedCount !== null && index >= finalPlayedCount || !raw && match.status === 'cancelled';
    const explicitlyScheduled = raw?.status === 'scheduled' || raw?.status === 'postponed';
    const state = notPlayed ? 'not-played' : explicitlyScheduled ? 'scheduled'
      : raw?.resultConfirmed === false || ['live', 'unknown'].includes(raw?.status) ? 'awaiting-data'
      : statistics || snapshotReady ? 'available'
        : raw || confirmed || match.status === 'completed' || match.status === 'live' ? 'awaiting-data' : 'scheduled';
    const number = index + 1;
    return { key: mapId ? `id:${mapId}` : raw ? `number:${number}` : `slot:${number}`,
      index, number, name: raw?.name || raw?.map || `Карта ${number}`, state, mapId,
      map: notPlayed ? null : raw, result: notPlayed ? null : result, winnerTeamId: notPlayed ? null : winnerTeamId,
      technical: Boolean(technical || technicalMap) };
  });
}

/** Optional published CS2 player statistics. Missing values stay null; no rating formula is inferred. */
export function getPublishedMapStats(match, slot) {
  const map = slot?.map;
  if (match.discipline !== 'Counter-Strike 2' || !map || ['scheduled', 'not-played'].includes(slot.state) ||
      ['walkover', 'bye'].includes(match.status) || match.scoreKind === 'technical' ||
      map.resultConfirmed === false || ['scheduled', 'live', 'postponed', 'cancelled'].includes(map.status)) return null;
  const confirmed = match.status === 'completed' && match.resultConfirmed === true || map.resultConfirmed === true;
  if (!confirmed || !Array.isArray(map.playerStats) || map.playerStats.length !== 10 ||
      new Set([match.team1Id, match.team2Id]).size !== 2 || !match.team1Id || !match.team2Id) return null;
  const players = [];
  const ids = new Set();
  for (const source of map.playerStats) {
    if (!source || typeof source !== 'object') return null;
    const accountId = typeof source.accountId === 'string' ? source.accountId.trim()
      : Number.isSafeInteger(source.accountId) && source.accountId > 0 ? String(source.accountId) : null;
    if (!accountId || ids.has(accountId) || typeof source.nickname !== 'string' || !source.nickname.trim() ||
        ![match.team1Id, match.team2Id].includes(source.teamId)) return null;
    ids.add(accountId);
    const player = { accountId, nickname: source.nickname.trim(), teamId: source.teamId };
    for (const field of ['kills', 'deaths', 'assists', 'adr', 'headshotPercent']) {
      const value = source[field];
      if (value == null) { player[field] = null; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
          (['kills', 'deaths', 'assists'].includes(field) && !Number.isSafeInteger(value)) ||
          (field === 'headshotPercent' && value > 100)) return null;
      player[field] = value;
    }
    players.push(player);
  }
  if ([match.team1Id, match.team2Id].some((teamId) => players.filter((player) => player.teamId === teamId).length !== 5)) return null;
  const declared = map.mvpAccountIds;
  const mvpDeclared = Array.isArray(declared) && declared.length > 0;
  const references = mvpDeclared ? declared.map((id) => typeof id === 'string' ? id.trim() : Number.isSafeInteger(id) && id > 0 ? String(id) : null) : [];
  const validReferences = mvpDeclared && references.every((id) => id && ids.has(id)) && new Set(references).size === references.length;
  const leaders = validReferences ? references.map((id) => players.find((player) => player.accountId === id)) : [];
  return { players, leaders, coverageComplete: true, mvpDeclared,
    mvpReason: !mvpDeclared ? 'not-declared' : validReferences ? null : 'invalid-reference' };
}

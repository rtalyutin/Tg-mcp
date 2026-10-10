import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { scoreDotaMap, buildMvpSnapshot, validateMvpSnapshot, validateMvpEstimates, DOTA_MVP_FORMULA_VERSION } from '../src/lib/dota-mvp.js';
import { fixtureFor, sideMatches, inFixtureWindow } from '../src/lib/dota-import.js';

export const DOTA_RESULTS_BUCKET = 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
const api = 'https://api.opendota.com/api';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => /^[1-9]\d*$/.test(String(value));
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
export const importSignal = (signal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);

export async function readJsonObject(s3, key, signal, validate = (value) => value) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: DOTA_RESULTS_BUCKET, Key: key }), { abortSignal: importSignal(signal) });
    return { value: validate(JSON.parse(await response.Body.transformToString())), etag: response.ETag || null };
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return { value: null, etag: null };
    throw error;
  }
}

// Compare the last confirmed revision again and use the storage precondition when
// available. A transport error is successful only if exact readback proves it.
export async function writeJsonObject(s3, key, value, previous, signal, validate = (item) => item,
  cacheControl = 'public, max-age=30') {
  const current = await readJsonObject(s3, key, signal, validate);
  if (JSON.stringify(current.value) !== JSON.stringify(previous.value)) throw new Error(`Concurrent S3 revision at ${key}`);
  const intended = JSON.stringify(value);
  const input = { Bucket: DOTA_RESULTS_BUCKET, Key: key, Body: JSON.stringify(value, null, 2) + '\n',
    ContentType: 'application/json; charset=utf-8', CacheControl: cacheControl,
    ...(current.etag ? { IfMatch: current.etag } : !current.value ? { IfNoneMatch: '*' } : {}) };
  try {
    await s3.send(new PutObjectCommand(input), { abortSignal: importSignal(signal) });
  } catch (error) {
    const afterError = await readJsonObject(s3, key, signal, validate);
    if (JSON.stringify(afterError.value) !== intended) throw error;
    return afterError.value;
  }
  const saved = await readJsonObject(s3, key, signal, validate);
  if (JSON.stringify(saved.value) !== intended) throw new Error(`S3 readback differs at ${key}`);
  return saved.value;
}

function cacheFor(tournament) {
  return { schemaVersion: 1, tournamentId: tournament.id, leagueId: tournament.leagueId, revision: 0,
    formulaVersion: DOTA_MVP_FORMULA_VERSION, heroNames: {}, playerNicknames: {}, maps: {} };
}
export function validateMvpCache(cache, tournament) {
  const estimates = new Set(validateMvpEstimates(tournament.mvpEstimates || [], tournament).map((entry) => entry.matchId));
  if (!object(cache) || cache.schemaVersion !== 1 || cache.tournamentId !== tournament.id || cache.leagueId !== tournament.leagueId ||
    !Number.isSafeInteger(cache.revision) || cache.revision < 1 || !object(cache.maps) || !object(cache.heroNames) ||
    !object(cache.playerNicknames) || (own(cache, 'discoveryPending') && typeof cache.discoveryPending !== 'boolean')) throw new Error('Invalid MVP import cache');
  for (const [matchId, entry] of Object.entries(cache.maps)) {
    if (!id(matchId) || !object(entry) || !['pending', 'ready', 'excluded', 'unmatched'].includes(entry.status) ||
      (entry.source && (String(entry.source.match_id) !== matchId || Number(entry.source.leagueid) !== tournament.leagueId &&
        !(estimates.has(matchId) && Number(entry.source.leagueid) === 0))) ||
      (entry.record && String(entry.record.matchId) !== matchId)) throw new Error(`Invalid MVP cached map ${matchId}`);
  }
  return cache;
}
export function validateImportedMvpSnapshot(snapshot, tournament) {
  validateMvpSnapshot(snapshot, tournament);
  if (own(snapshot, 'ingestionComplete') || own(snapshot, 'ingestionPendingMatchIds')) {
    if (typeof snapshot.ingestionComplete !== 'boolean' || !Array.isArray(snapshot.ingestionPendingMatchIds) ||
      snapshot.ingestionPendingMatchIds.some((value) => typeof value !== 'string' || !id(value)) ||
      new Set(snapshot.ingestionPendingMatchIds).size !== snapshot.ingestionPendingMatchIds.length ||
      snapshot.ingestionComplete !== (snapshot.ingestionPendingMatchIds.length === 0 && snapshot.discoveryPending !== true)) throw new Error('Invalid MVP ingestion coverage');
  }
  if (own(snapshot, 'correctionPendingMatchIds') && (!Array.isArray(snapshot.correctionPendingMatchIds) ||
    snapshot.correctionPendingMatchIds.some((value) => typeof value !== 'string' || !id(value) || snapshot.maps[value]?.status !== 'ready') ||
    new Set(snapshot.correctionPendingMatchIds).size !== snapshot.correctionPendingMatchIds.length)) throw new Error('Invalid MVP correction coverage');
  return snapshot;
}

// Keep the exact required source collections, rather than derived OpenDota
// totals, together with the fields consumed by the existing series collector.
export function mvpSource(map) {
  const result = {};
  for (const key of ['match_id', 'leagueid', 'start_time', 'duration', 'pre_game_duration', 'radiant_win', 'radiant_score', 'dire_score',
    'series_id', 'series_type', 'radiant_name', 'dire_name', 'radiant_team_id', 'dire_team_id', 'radiant_team', 'dire_team', 'version']) {
    if (own(map, key)) result[key] = map[key];
  }
  if (Array.isArray(map.players)) result.players = map.players.map((player) => {
    const selected = {};
    for (const key of ['account_id', 'player_slot', 'hero_id', 'personaname', 'name', 'kills', 'assists', 'deaths',
      'damage_targets', 'damage', 'healing', 'stuns', 'camps_stacked', 'obs_log', 'obs_left_log']) {
      if (own(player, key)) selected[key] = player[key];
    }
    return selected;
  });
  return result;
}
function fixtureContext(map, fixture) {
  const firstIsRadiant = sideMatches(map, 'radiant', fixture, 1);
  return { fixtureId: fixture.id, sideTeamIds: {
    radiant: { id: firstIsRadiant ? fixture.team1Id : fixture.team2Id, name: firstIsRadiant ? fixture.team1 : fixture.team2 },
    dire: { id: firstIsRadiant ? fixture.team2Id : fixture.team1Id, name: firstIsRadiant ? fixture.team2 : fixture.team1 },
  } };
}
function accountId(identity) {
  if (id(identity.accountId ?? identity.account_id)) return String(identity.accountId ?? identity.account_id);
  if (!id(identity.steamId ?? identity.steamid)) return null;
  const number = BigInt(identity.steamId ?? identity.steamid) - 76561197960265728n;
  return number > 0n && number <= 4294967295n ? String(number) : null;
}
async function fetchHeroes(cache, fetchJson, signal) {
  if (Object.keys(cache.heroNames).length) return;
  const heroes = await fetchJson(`${api}/heroes`, signal);
  if (!Array.isArray(heroes) || !heroes.length || heroes.some((hero) => !id(hero.id) || !/^npc_dota_hero_[a-z0-9_]+$/.test(hero.name))) {
    throw new Error('Invalid OpenDota hero registry');
  }
  cache.heroNames = Object.fromEntries(heroes.map((hero) => [String(hero.id), hero.name]));
}
async function resolveNicknames(map, context, cache, rosterIdentities, fetchJson, signal, warnings) {
  let complete = true;
  for (const player of map.players || []) {
    const account = accountId(player);
    if (!account) continue; // The scorer reports an anonymous/missing account.
    const side = player.player_slot < 128 ? 'radiant' : 'dire';
    if (rosterIdentities.some((entry) => entry.teamId === context.sideTeamIds[side].id && accountId(entry) === account &&
      typeof (entry.nickname ?? entry.name) === 'string' && (entry.nickname ?? entry.name).trim())) continue;
    // The match player is already identified by account_id, so this name is a
    // valid ID lookup even if the player is not in the registered team roster.
    if (typeof player.personaname === 'string' && player.personaname.trim()) cache.playerNicknames[account] = player.personaname;
    if (cache.playerNicknames[account]) continue;
    try {
      const profile = await fetchJson(`${api}/players/${account}`, signal);
      if (Number(profile.profile?.account_id) !== Number(account) || typeof profile.profile?.personaname !== 'string' || !profile.profile.personaname.trim()) {
        throw new Error('Profile has no confirmed account nickname');
      }
      cache.playerNicknames[account] = profile.profile.personaname;
    } catch (error) { complete = false; warnings.push(`Nickname for account ${account}: ${error.message}`); }
  }
  return complete;
}
const sameSnapshot = (left, right) => JSON.stringify(left && { maps: left.maps, players: left.players, formulaVersion: left.formulaVersion,
  ingestionComplete: left.ingestionComplete, ingestionPendingMatchIds: left.ingestionPendingMatchIds, correctionPendingMatchIds: left.correctionPendingMatchIds,
  estimation: left.estimation, discoveryPending: left.discoveryPending, coverageComplete: left.coverageComplete }) ===
  JSON.stringify(right && { maps: right.maps, players: right.players, formulaVersion: right.formulaVersion,
    ingestionComplete: right.ingestionComplete, ingestionPendingMatchIds: right.ingestionPendingMatchIds, correctionPendingMatchIds: right.correctionPendingMatchIds,
    estimation: right.estimation, discoveryPending: right.discoveryPending, coverageComplete: right.coverageComplete });

function confirmedMapContext(source, confirmation, tournament) {
  const fixture = (tournament.stages || []).flatMap((stage) => (stage.rounds || [{ matches: stage.matches || [] }])
    .flatMap((round) => round.matches || [])).find((candidate) => candidate.id === confirmation.fixtureId);
  if (!fixture || !inFixtureWindow(source, fixture)) throw new Error('Confirmed played map is outside its fixture window');
  const matched = fixtureFor(source, tournament);
  let context = matched?.id === fixture.id ? fixtureContext(source, fixture) : null;
  if (confirmation.players?.length) {
    if (!Array.isArray(source.players) || source.players.length !== 10) throw new Error('Confirmed map player identities unavailable');
    const supplied = new Map(confirmation.players.map((player) => [player.accountId, player]));
    const teamsBySide = { radiant: new Set(), dire: new Set() }, accounts = new Set(), slots = new Set();
    for (const player of source.players) {
      const account = accountId(player), expected = supplied.get(account);
      if (!expected || accounts.has(account) || slots.has(player.player_slot) ||
        ![0, 1, 2, 3, 4, 128, 129, 130, 131, 132].includes(player.player_slot) || Number(player.hero_id) !== expected.heroId) {
        throw new Error('API player identity conflicts with organizer-confirmed map');
      }
      accounts.add(account); slots.add(player.player_slot);
      teamsBySide[player.player_slot < 128 ? 'radiant' : 'dire'].add(expected.teamId);
    }
    if (teamsBySide.radiant.size !== 1 || teamsBySide.dire.size !== 1 ||
      [...teamsBySide.radiant][0] === [...teamsBySide.dire][0]) throw new Error('API sides conflict with confirmed map teams');
    const sideTeamIds = Object.fromEntries(['radiant', 'dire'].map((side) => {
      const teamId = [...teamsBySide[side]][0];
      return [side, { id: teamId, name: fixture.team1Id === teamId ? fixture.team1 : fixture.team2 }];
    }));
    if (context && ['radiant', 'dire'].some((side) => context.sideTeamIds[side].id !== sideTeamIds[side].id)) throw new Error('API names conflict with confirmed map player teams');
    context = { fixtureId: fixture.id, sideTeamIds };
  }
  if (!context || typeof source.radiant_win !== 'boolean' ||
    context.sideTeamIds[source.radiant_win ? 'radiant' : 'dire'].id !== confirmation.winnerTeamId) throw new Error('API map winner conflicts with confirmed played result');
  return { fixture, context };
}

function verifiedResultSource(source, fixture) {
  return positive(source.match_id) && positive(source.start_time) && positive(source.duration) &&
    typeof source.radiant_win === 'boolean' && Number.isSafeInteger(source.radiant_score) && source.radiant_score >= 0 &&
    Number.isSafeInteger(source.dire_score) && source.dire_score >= 0 &&
    (fixture.bestOf === 'BO1' || positive(source.series_id));
}
function pendingIngestionIds(cache, tournament) {
  const confirmedIds = new Set((tournament.mvpEstimates || []).map((map) => map.matchId));
  const fixtures = (tournament.stages || []).flatMap((stage) => (stage.rounds || [{ matches: stage.matches || [] }])
    .flatMap((round) => round.matches || [])).filter((fixture) => fixture.team1Id && fixture.team2Id);
  const publishedStart = Date.parse(`${tournament.dates?.start}T00:00:00+03:00`);
  const publishedEnd = Date.parse(`${tournament.dates?.end}T00:00:00+03:00`) + 24 * 60 * 60_000;
  return Object.entries(cache.maps).filter(([matchId, entry]) => {
    // A confirmed played map has a trusted result/fixture binding even while
    // its MVP source is missing; retries remain tracked separately below.
    if (confirmedIds.has(matchId)) return false;
    if (!entry.source || !positive(entry.source.start_time)) return true;
    const start = Number(entry.source.start_time) * 1000;
    const inPublishedPeriod = start >= publishedStart && start < publishedEnd;
    // Future rounds need their real fixtures before they can be associated.
    // Absence of a published later-round fixture never proves a map unrelated.
    if (!inPublishedPeriod && !fixtures.some((fixture) => inFixtureWindow(entry.source, fixture))) return false;
    const fixture = fixtureFor(entry.source, tournament);
    return !fixture || !verifiedResultSource(entry.source, fixture);
  }).map(([matchId]) => matchId);
}

export async function collectMvpImport({ tournament, now = new Date(), fetchJson, signal, cache: previousCache = null,
  rosterIdentities = [], pendingOnly = false, knownMatchIds = [], rescanMatchIds = [], excludedReasons = {} }) {
  if (!Array.isArray(knownMatchIds) || knownMatchIds.some((value) => !id(value))) throw new Error('Invalid known retry match IDs');
  const estimates = validateMvpEstimates(tournament.mvpEstimates || [], tournament);
  const confirmedMaps = new Map(estimates.map((estimate) => [estimate.matchId, estimate]));
  if (previousCache) validateMvpCache(previousCache, tournament);
  const cache = previousCache ? structuredClone(previousCache) : cacheFor(tournament);
  cache.formulaVersion = DOTA_MVP_FORMULA_VERSION;
  const warnings = [];
  let ids = [...new Set([...Object.keys(cache.maps), ...knownMatchIds.map(String), ...confirmedMaps.keys()])];
  if (!pendingOnly) {
    try {
      const discovered = await fetchJson(`${api}/leagues/${tournament.leagueId}/matchIds`, signal);
      if (!Array.isArray(discovered) || discovered.some((value) => !id(value))) throw new Error('Invalid OpenDota league match IDs');
      ids = [...new Set([...ids, ...discovered.map(String)])];
      delete cache.discoveryPending;
    } catch (error) {
      signal?.throwIfAborted();
      if (!ids.length) throw error;
      cache.discoveryPending = true;
      warnings.push(`League discovery pending: ${error.message}; retrying only ${ids.length} known/confirmed map(s)`);
    }
  }
  const identities = rosterIdentities.filter((entry) => !entry.tournamentId || entry.tournamentId === tournament.id);
  const rescan = rescanMatchIds === 'all' ? new Set(ids) : new Set(rescanMatchIds.map(String));
  for (const matchId of ids) {
    signal?.throwIfAborted();
    let entry = cache.maps[matchId];
    const confirmedSource = entry?.confirmedSource || (entry?.record?.status === 'ready' ? entry.source : null);
    if (!entry || entry.status === 'pending' || entry.ingestionPending || entry.correctionPending || rescan.has(matchId)) {
      try {
        const raw = await fetchJson(`${api}/matches/${matchId}`, signal);
        if (String(raw?.match_id) !== matchId || Number(raw.leagueid) !== tournament.leagueId &&
          !(confirmedMaps.has(matchId) && Number(raw.leagueid) === 0)) throw new Error('Foreign or conflicting map ID');
        entry = { ...entry, source: mvpSource(raw), fetchedAt: now.toISOString(), lastAttemptAt: now.toISOString() };
        cache.maps[matchId] = entry;
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`Map ${matchId}: ${error.message}`);
        if (!entry) cache.maps[matchId] = { status: 'pending', reason: error.message, lastAttemptAt: now.toISOString() };
        else if (entry.record?.status === 'ready' && rescan.has(matchId)) {
          entry.correctionPending = true; entry.reason = error.message; entry.lastAttemptAt = now.toISOString();
        }
        continue; // A failed correction/retry never erases a confirmed record.
      }
    }
    if (!entry.source) continue;
    let fixture, context;
    try {
      const confirmation = confirmedMaps.get(matchId);
      if (confirmation) ({ fixture, context } = confirmedMapContext(entry.source, confirmation, tournament));
      else { fixture = fixtureFor(entry.source, tournament); if (fixture) context = fixtureContext(entry.source, fixture); }
    } catch (error) {
      warnings.push(`Confirmed map ${matchId}: ${error.message}`);
      if (entry.record?.status === 'ready') { entry.correctionPending = true; entry.confirmedSource = confirmedSource; }
      else Object.assign(entry, { status: 'pending', reason: error.message });
      continue;
    }
    if (!fixture) {
      if (!entry.record) Object.assign(entry, { status: 'unmatched', reason: 'No unique published fixture' });
      warnings.push(`Unmatched map ${matchId}`); continue;
    }
    if (own(excludedReasons, matchId)) {
      if (typeof excludedReasons[matchId] === 'string' && excludedReasons[matchId].trim()) entry.excludedReason = excludedReasons[matchId];
      else delete entry.excludedReason;
    }
    let record;
    try {
      await fetchHeroes(cache, fetchJson, signal);
      const nicknamesComplete = await resolveNicknames(entry.source, context, cache, identities, fetchJson, signal, warnings);
      record = scoreDotaMap(entry.source, { ...context, heroNames: cache.heroNames, rosterIdentities: identities,
        playerNicknames: cache.playerNicknames, excludedReason: entry.excludedReason });
      if (!nicknamesComplete && record.status === 'ready') record = { ...record, status: 'pending',
        reason: 'Player nickname lookup pending', players: record.players.map(({ metrics, scoreExact, ...player }) => player) };
    } catch (error) {
      warnings.push(`MVP map ${matchId}: ${error.message}`);
      record = { matchId, fixtureId: fixture.id, status: 'pending', reason: error.message, players: [] };
    }
    if (entry.record?.status === 'ready' && record.status === 'pending') {
      // Preserve the exact confirmed calculation until replacement is complete.
      entry.correctionPending = true; entry.reason = record.reason;
      entry.confirmedSource = confirmedSource;
    } else {
      entry.record = record; entry.status = record.status; delete entry.correctionPending;
      delete entry.confirmedSource;
      if (record.reason) entry.reason = record.reason; else delete entry.reason;
    }
    entry.fixtureId = fixture.id; entry.sourceVersion = entry.source.version ?? null;
    entry.formulaVersion = DOTA_MVP_FORMULA_VERSION;
  }
  const records = Object.values(cache.maps).flatMap((entry) => entry.record ? [entry.record] : []);
  const correctionPendingMatchIds = Object.entries(cache.maps).filter(([, entry]) => entry.correctionPending && entry.record?.status === 'ready')
    .map(([matchId]) => matchId);
  const ingestionPendingMatchIds = pendingIngestionIds(cache, tournament);
  cache.ingestionPendingMatchIds = ingestionPendingMatchIds;
  const pendingIds = new Set(ingestionPendingMatchIds);
  for (const [matchId, entry] of Object.entries(cache.maps)) {
    if (pendingIds.has(matchId)) entry.ingestionPending = true; else delete entry.ingestionPending;
  }
  for (const [matchId, entry] of Object.entries(cache.maps)) if (entry.status === 'pending' || entry.correctionPending) pendingIds.add(matchId);
  const pendingMaps = pendingIds.size;
  const changed = JSON.stringify(cache) !== JSON.stringify(previousCache || cacheFor(tournament));
  if (changed) { cache.revision = (previousCache?.revision || 0) + 1; cache.updatedAt = now.toISOString(); }
  return { cache, cacheChanged: changed, records, maps: Object.values(cache.maps).flatMap((entry) => entry.source ? [entry.source] : []),
    pendingMaps, ingestionPendingMatchIds, correctionPendingMatchIds, discoveryPending: cache.discoveryPending === true, warnings };
}

export async function publishMvpImport({ s3, tournament, now, signal, collection, previousCache, previousSnapshot }) {
  const cacheKey = `results/${tournament.id}-mvp-cache.json`;
  const snapshotKey = `results/${tournament.id}-mvp.json`;
  if (collection.cacheChanged) await writeJsonObject(s3, cacheKey, collection.cache, previousCache, signal,
    (cache) => validateMvpCache(cache, tournament), 'private, no-store');
  if (!collection.records.length && !collection.ingestionPendingMatchIds.length && !tournament.mvpEstimates?.length && !collection.discoveryPending) return { snapshot: previousSnapshot.value, changed: false, pendingMaps: collection.pendingMaps };
  const snapshot = buildMvpSnapshot(collection.records, { tournamentId: tournament.id, leagueId: tournament.leagueId,
    revision: (previousSnapshot.value?.revision || 0) + 1, updatedAt: now.toISOString(),
    ingestionComplete: collection.ingestionPendingMatchIds.length === 0 && !collection.discoveryPending,
    ingestionPendingMatchIds: collection.ingestionPendingMatchIds,
    ...(collection.discoveryPending ? { discoveryPending: true } : {}), estimates: tournament.mvpEstimates || [] });
  snapshot.ingestionComplete = collection.ingestionPendingMatchIds.length === 0 && !collection.discoveryPending;
  snapshot.ingestionPendingMatchIds = collection.ingestionPendingMatchIds;
  snapshot.correctionPendingMatchIds = collection.correctionPendingMatchIds || [];
  validateImportedMvpSnapshot(snapshot, tournament);
  if (sameSnapshot(snapshot, previousSnapshot.value)) return { snapshot: previousSnapshot.value, changed: false, pendingMaps: collection.pendingMaps };
  await writeJsonObject(s3, snapshotKey, snapshot, previousSnapshot, signal, (value) => validateImportedMvpSnapshot(value, tournament));
  return { snapshot, changed: true, pendingMaps: collection.pendingMaps };
}

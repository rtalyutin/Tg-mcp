// Regulation §9.4. All comparisons use rational arithmetic; rounding is display-only.
// OpenDota parsed collections must be present. A missing collection is never a zero.
export const DOTA_MVP_FORMULA_VERSION = 'ycs-dota-mvp-9.4-v1';
export const DOTA_MVP_ESTIMATION_VERSION = 'ycs-dota-mvp-missing-map-v1';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveId = (value) => /^[1-9]\d*$/.test(String(value)) &&
  (typeof value === 'string' || Number.isSafeInteger(value));
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
const rational = (numerator, denominator = 1n) => {
  if (denominator <= 0n) throw new Error('Invalid rational denominator');
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
};
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const compare = (a, b) => { const difference = a.n * b.d - b.n * a.d; return difference < 0n ? -1 : difference > 0n ? 1 : 0; };
const encode = (value) => ({ numerator: String(value.n), denominator: String(value.d) });
function decode(value) {
  if (!object(value) || typeof value.numerator !== 'string' || typeof value.denominator !== 'string' ||
    !/^-?(0|[1-9]\d*)$/.test(value.numerator) || !/^[1-9]\d*$/.test(value.denominator)) throw new Error('Invalid exact MVP score');
  const result = rational(BigInt(value.numerator), BigInt(value.denominator));
  if (String(result.n) !== value.numerator || String(result.d) !== value.denominator) throw new Error('Noncanonical exact MVP score');
  return result;
}
function decimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid stuns');
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Missing stuns');
  const string = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(string);
  if (!match || string.length > 100) throw new Error('Invalid stuns decimal');
  const exponent = Number(match[3] || 0) - (match[2]?.length || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Invalid stuns exponent');
  const whole = BigInt(match[1] + (match[2] || ''));
  return exponent >= 0 ? rational(whole * 10n ** BigInt(exponent)) : rational(whole, 10n ** BigInt(-exponent));
}
function validateMetrics(metrics) {
  if (!object(metrics)) throw new Error('Missing MVP metrics');
  for (const key of ['K', 'A', 'L', 'D', 'T', 'H', 'V', 'S']) if (!count(metrics[key])) throw new Error(`Invalid MVP metric ${key}`);
  decimal(metrics.C);
  return metrics;
}
export function mvpContributions(metrics) {
  validateMetrics(metrics);
  const stuns = decimal(metrics.C);
  return {
    combat: encode(rational(BigInt(metrics.K) + BigInt(metrics.A) - BigInt(metrics.L), 3n)),
    damage: encode(rational(BigInt(metrics.D) + BigInt(metrics.T), 1500n)),
    healing: encode(rational(BigInt(metrics.H), 500n)),
    control: encode(rational(stuns.n, stuns.d * 15n)),
    wards: encode(rational(BigInt(metrics.V), 2n)),
    stacks: encode(rational(BigInt(metrics.S), 6n)),
  };
}
export function scoreMvpMetrics(metrics) {
  return encode(Object.values(mvpContributions(metrics)).map(decode).reduce(add, rational(0n)));
}
export function formatMvpScore(exact, decimals = 2) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 6) throw new Error('Invalid display precision');
  const value = decode(exact), factor = 10n ** BigInt(decimals), negative = value.n < 0n;
  const magnitude = (negative ? -value.n : value.n) * factor;
  const rounded = magnitude / value.d + (magnitude % value.d * 2n >= value.d ? 1n : 0n);
  const digits = String(rounded).padStart(decimals + 1, '0');
  return `${negative && rounded !== 0n ? '-' : ''}${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits}`;
}
export function steamIdFromAccount(accountId) {
  if (!positiveId(accountId) || BigInt(accountId) > 4294967295n) throw new Error('Invalid Dota account ID');
  return String(76561197960265728n + BigInt(accountId));
}
function accountIdOf(identity) {
  const supplied = identity.accountId ?? identity.account_id;
  if (supplied !== undefined && supplied !== null) return positiveId(supplied) && BigInt(supplied) <= 4294967295n ? String(supplied) : null;
  const steam = identity.steamId ?? identity.steamid;
  if (!positiveId(steam)) return null;
  const value = BigInt(steam) - 76561197960265728n;
  return value > 0n && value <= 4294967295n ? String(value) : null;
}
function heroNameFor(heroNames, id) {
  const hero = heroNames instanceof Map ? heroNames.get(id) ?? heroNames.get(String(id)) : heroNames?.[id];
  const name = object(hero) ? hero.name : hero;
  return typeof name === 'string' && /^npc_dota_hero_[a-z0-9_]+$/.test(name) ? name : null;
}
function teamFor(map, side, sideTeamIds) {
  const supplied = sideTeamIds?.[side];
  const id = object(supplied) ? supplied.id ?? supplied.teamId : supplied;
  const sourceName = map[`${side}_team`]?.name ?? map[`${side}_name`];
  const name = object(supplied) ? supplied.name ?? supplied.teamName ?? sourceName : sourceName;
  return text(id) && text(name) ? { id, name } : null;
}
function sumTargets(collection, isTarget) {
  if (!object(collection)) throw new Error('Missing parsed target collection');
  let total = 0;
  for (const [target, value] of Object.entries(collection)) {
    if (!count(value)) throw new Error(`Invalid parsed target value: ${target}`);
    if (isTarget(target)) total += value;
    if (!Number.isSafeInteger(total)) throw new Error('Parsed target total exceeds integer precision');
  }
  return total;
}
function actualHeroDamage(collection, enemyNames) {
  if (!object(collection)) throw new Error('Missing damage_targets');
  let total = 0;
  for (const targets of Object.values(collection)) total += sumTargets(targets, (name) => enemyNames.has(name));
  if (!Number.isSafeInteger(total)) throw new Error('Hero damage exceeds integer precision');
  return total;
}
function enemyBuilding(name, enemySide) {
  // OpenDota target names are engine unit names; side filtering excludes denies.
  const faction = enemySide === 'radiant' ? 'goodguys' : 'badguys';
  return new RegExp(`^npc_dota_${faction}_(?:tower\\d+(?:_[a-z]+)?|melee_rax_[a-z]+|range_rax_[a-z]+|fort)$`).test(name);
}
function wardCounts(map, identities) {
  const counts = new Map(identities.map((identity) => [identity.accountId, 0]));
  const byHero = new Map(identities.map((identity) => [identity.heroName, identity]));
  const events = new Map();
  for (const owner of identities) {
    const logs = owner.source.obs_left_log;
    if (!Array.isArray(logs)) throw new Error(`Missing obs_left_log for ${owner.accountId}`);
    for (const event of logs) {
      if (!object(event)) throw new Error('Invalid observer removal event');
      const attacker = byHero.get(event.attackername);
      // Expiration, unknown attackers and allied ward denies are not confirmed enemy kills.
      if (!attacker || attacker.side === owner.side) continue;
      if (typeof event.time !== 'number' || !Number.isFinite(event.time)) throw new Error('Observer kill has no event time');
      if (event.time > map.duration) continue;
      if (event.time < 0) {
        if (!Number.isFinite(map.pre_game_duration) || map.pre_game_duration < 0) throw new Error('Negative observer event has no known pregame time bound');
        if (event.time < -map.pre_game_duration) continue;
      }
      const expectedSlot = owner.source.player_slot % 128 + (owner.side === 'dire' ? 5 : 0);
      if ((own(event, 'slot') && event.slot !== expectedSlot) ||
        (own(event, 'player_slot') && event.player_slot !== owner.source.player_slot)) {
        throw new Error('Observer event owner conflicts with its player log');
      }
      // ehandle identifies a ward entity. Without it, the parser's position key +
      // destruction time + owner identifies duplicates of the same event.
      const entity = event.ehandle ?? event.entity_id;
      const key = entity !== undefined && entity !== null
        ? `entity:${String(entity)}`
        : text(event.key) ? `position:${event.key}:time:${String(event.time)}:owner:${owner.accountId}` : null;
      if (!key) throw new Error('Observer kill has no deduplication identity');
      const existing = events.get(key);
      const signature = `${owner.accountId}/${attacker.accountId}/${event.time}`;
      if (existing && existing.signature !== signature) throw new Error('Conflicting observer destruction events');
      events.set(key, { signature, attackerId: attacker.accountId });
    }
  }
  for (const event of events.values()) counts.set(event.attackerId, counts.get(event.attackerId) + 1);
  return counts;
}
export function scoreDotaMap(map, { heroNames = {}, rosterIdentities = [], playerNicknames = {}, fixtureId = null,
  sideTeamIds, excludedReason } = {}) {
  const result = { matchId: String(map?.match_id ?? ''), fixtureId, status: 'pending', players: [] };
  try {
    if (!object(map) || !positiveId(map.match_id)) throw new Error('Missing match ID');
    if (!Array.isArray(map.players) || map.players.length !== 10) throw new Error('Expected exactly ten players');
    const seenAccounts = new Set(), seenSlots = new Set();
    const identities = map.players.map((source) => {
      if (!object(source)) throw new Error('Invalid player');
      if (![0, 1, 2, 3, 4, 128, 129, 130, 131, 132].includes(source.player_slot) || seenSlots.has(source.player_slot)) throw new Error('Duplicate or invalid player slot');
      seenSlots.add(source.player_slot);
      const accountId = accountIdOf(source);
      if (!accountId || seenAccounts.has(accountId)) throw new Error('Missing, anonymous or duplicate account ID');
      seenAccounts.add(accountId);
      const heroName = heroNameFor(heroNames, source.hero_id);
      const side = source.player_slot < 128 ? 'radiant' : 'dire';
      const team = teamFor(map, side, sideTeamIds);
      if (!team) throw new Error('Missing team identity');
      const matching = rosterIdentities.filter((entry) => entry.teamId === team.id && accountIdOf(entry) === accountId);
      const names = [...new Set(matching.map((entry) => entry.nickname ?? entry.name).filter(text))];
      if (names.length > 1) throw new Error('Ambiguous roster nickname');
      const fetched = playerNicknames instanceof Map ? playerNicknames.get(accountId) : playerNicknames[accountId];
      const apiNickname = object(fetched) ? fetched.personaname ?? fetched.name : fetched;
      const nickname = names[0] ?? (text(apiNickname) ? apiNickname : null) ??
        (text(source.personaname) ? source.personaname : text(source.name) ? source.name : `Steam ${steamIdFromAccount(accountId)}`);
      return { accountId, steamId: steamIdFromAccount(accountId), nickname, teamId: team.id, teamName: team.name,
        heroId: Number(source.hero_id), heroName, side, source };
    });
    if (new Set(identities.map((identity) => identity.teamId)).size !== 2) throw new Error('Opponents must have different team identities');
    const publicIdentity = ({ source, side, heroName, ...identity }) => identity;
    result.players = identities.map(publicIdentity);
    if (text(excludedReason)) return { ...result, status: 'excluded', reason: excludedReason };
    if (identities.some((identity) => !positiveId(identity.heroId) || !identity.heroName) ||
      new Set(identities.map((identity) => identity.heroName)).size !== 10) throw new Error('Unknown or ambiguous hero identity');
    if (!Number.isFinite(map.version) || map.version <= 0) throw new Error('Replay not yet parsed');
    if (!Number.isFinite(map.duration) || map.duration <= 0) throw new Error('Missing map duration');
    const wards = wardCounts(map, identities);
    result.players = identities.map((identity) => {
      const player = identity.source;
      for (const key of ['kills', 'assists', 'deaths', 'camps_stacked']) if (!own(player, key) || !count(player[key])) throw new Error(`Missing or invalid ${key} for ${identity.accountId}`);
      const enemies = new Set(identities.filter((candidate) => candidate.side !== identity.side).map((candidate) => candidate.heroName));
      const allies = new Set(identities.filter((candidate) => candidate.side === identity.side && candidate.accountId !== identity.accountId).map((candidate) => candidate.heroName));
      decimal(player.stuns);
      const metrics = {
        K: player.kills, A: player.assists, L: player.deaths,
        D: actualHeroDamage(player.damage_targets, enemies),
        T: sumTargets(player.damage, (name) => enemyBuilding(name, identity.side === 'radiant' ? 'dire' : 'radiant')),
        H: sumTargets(player.healing, (name) => allies.has(name)),
        C: String(player.stuns), V: wards.get(identity.accountId), S: player.camps_stacked,
      };
      return { ...publicIdentity(identity), metrics, scoreExact: scoreMvpMetrics(metrics) };
    });
    result.status = 'ready';
    return result;
  } catch (error) {
    // A map is atomic: no subset of its ten players may receive ratings.
    result.players = result.players.map(({ metrics, scoreExact, ...identity }) => identity);
    if (object(map) && positiveId(map.match_id) && text(excludedReason)) {
      return { ...result, status: 'excluded', reason: excludedReason };
    }
    return { ...result, reason: error.message };
  }
}
function rankedPlayers(players) {
  const ranked = [...players].sort((a, b) => {
    if (a.countedMaps === 0 || b.countedMaps === 0) return Number(b.countedMaps > 0) - Number(a.countedMaps > 0) || String(a.accountId).localeCompare(String(b.accountId));
    return -compare(decode(a.ratingExact), decode(b.ratingExact)) || String(a.accountId).localeCompare(String(b.accountId));
  });
  let previous = null, rank = null;
  return ranked.map((player, index) => {
    if (!player.countedMaps) return { ...player, rank: null };
    const exact = decode(player.ratingExact);
    if (!previous || compare(exact, previous) !== 0) rank = index + 1;
    previous = exact;
    return { ...player, rank };
  });
}
export function topMvpPlayers(players, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid top MVP limit');
  const ranked = rankedPlayers(players).filter((player) => player.countedMaps > 0);
  if (ranked.length <= limit) return ranked;
  const cutoff = decode(ranked[limit - 1].ratingExact);
  return ranked.filter((player) => compare(decode(player.ratingExact), cutoff) >= 0);
}
function validateIngestionMetadata(snapshot) {
  const hasComplete = own(snapshot, 'ingestionComplete'), hasPending = own(snapshot, 'ingestionPendingMatchIds');
  const hasDiscovery = own(snapshot, 'discoveryPending');
  if (!hasComplete && !hasPending && !hasDiscovery) return;
  if (!hasComplete || !hasPending || typeof snapshot.ingestionComplete !== 'boolean' ||
    (hasDiscovery && typeof snapshot.discoveryPending !== 'boolean') ||
    !Array.isArray(snapshot.ingestionPendingMatchIds) || snapshot.ingestionPendingMatchIds.some((id) => typeof id !== 'string' || !positiveId(id)) ||
    new Set(snapshot.ingestionPendingMatchIds).size !== snapshot.ingestionPendingMatchIds.length ||
    snapshot.ingestionComplete !== (snapshot.ingestionPendingMatchIds.length === 0 && snapshot.discoveryPending !== true)) throw new Error('Invalid MVP ingestion metadata');
}
function validateCorrectionMetadata(snapshot) {
  if (!own(snapshot, 'correctionPendingMatchIds')) return;
  if (!Array.isArray(snapshot.correctionPendingMatchIds) ||
    snapshot.correctionPendingMatchIds.some((id) => typeof id !== 'string' || !positiveId(id) || snapshot.maps[id]?.status !== 'ready') ||
    new Set(snapshot.correctionPendingMatchIds).size !== snapshot.correctionPendingMatchIds.length) throw new Error('Invalid MVP correction metadata');
}
const tournamentFixtures = (tournament) => (tournament?.stages || []).flatMap((stage) =>
  (stage.rounds || [{ matches: stage.matches || [] }]).flatMap((round) => round.matches || []));
function completeIdentities(players) {
  if (!Array.isArray(players) || players.length !== 10) throw new Error('MVP map needs ten actual player identities');
  const accounts = new Set(), heroes = new Set(), teams = new Map();
  for (const player of players) {
    if (!object(player) || typeof player.accountId !== 'string' || !positiveId(player.accountId) ||
      accounts.has(player.accountId) || !text(player.nickname) || !text(player.teamId) || !text(player.teamName) ||
      !Number.isSafeInteger(player.heroId) || player.heroId <= 0 || heroes.has(player.heroId)) throw new Error('Invalid or duplicate MVP map identity');
    steamIdFromAccount(player.accountId);
    accounts.add(player.accountId); heroes.add(player.heroId);
    const team = teams.get(player.teamId) || { count: 0, name: player.teamName };
    if (team.name !== player.teamName) throw new Error('Conflicting MVP team name');
    team.count++; teams.set(player.teamId, team);
  }
  if (teams.size !== 2 || [...teams.values()].some((team) => team.count !== 5)) throw new Error('MVP map needs two five-player teams');
  return teams;
}
// This registry confirms a particular PLAYED map, never a current team roster.
// Missing identities are allowed only as an explicit pending state.
export function validateMvpEstimates(estimates = [], tournament) {
  if (!Array.isArray(estimates)) throw new Error('Invalid MVP estimate registry');
  const seen = new Set(), fixtures = new Map(tournamentFixtures(tournament).map((fixture) => [fixture.id, fixture]));
  const byFixture = new Map();
  for (const map of estimates) {
    if (!object(map) || typeof map.matchId !== 'string' || !positiveId(map.matchId) || seen.has(map.matchId) ||
      !text(map.fixtureId) || map.confirmed !== true || map.played !== true || !text(map.winnerTeamId) || !text(map.reason)) {
      throw new Error('Invalid or duplicate organizer-confirmed played MVP map');
    }
    seen.add(map.matchId);
    const fixture = fixtures.get(map.fixtureId);
    if (fixtures.size && (!fixture || ![fixture.team1Id, fixture.team2Id].includes(map.winnerTeamId))) throw new Error('MVP estimate does not match tournament fixture');
    if (fixture && (fixture.status === 'walkover' || fixture.scoreKind === 'technical')) throw new Error('Technical victory without a played map cannot receive MVP estimates');
    if (fixture?.resultConfirmed === true && fixture.winnerTeamId && fixture.winnerTeamId !== map.winnerTeamId) throw new Error('MVP estimate winner conflicts with confirmed fixture result');
    if (fixture) {
      const assigned = byFixture.get(fixture.id) || [];
      assigned.push(map.matchId); byFixture.set(fixture.id, assigned);
    }
    if (map.players !== undefined && (!Array.isArray(map.players) || (map.players.length && map.players.length !== 10))) throw new Error('Incomplete MVP estimate identities');
    if (map.players?.length) {
      const teams = completeIdentities(map.players);
      if (!teams.has(map.winnerTeamId) || fixture && [...teams.keys()].some((team) => ![fixture.team1Id, fixture.team2Id].includes(team))) {
        throw new Error('MVP estimate player teams do not match confirmed result');
      }
      if (map.players.some((player) => own(player, 'metrics') || own(player, 'scoreExact'))) throw new Error('Estimate input must not fabricate real metrics or scores');
    }
  }
  for (const [fixtureId, matchIds] of byFixture) {
    const fixture = fixtures.get(fixtureId), bestOf = Number(String(fixture.bestOf).replace(/^BO/, ''));
    const played = fixture.resultConfirmed === true && count(fixture.score1) && count(fixture.score2) ? fixture.score1 + fixture.score2 : null;
    if ((Number.isSafeInteger(bestOf) && bestOf > 0 && matchIds.length > bestOf) || (played !== null && matchIds.length > played)) {
      throw new Error('MVP estimates exceed confirmed fixture played map count');
    }
    const knownIds = new Set((fixture.maps || []).map((map) => String(map.matchId ?? map.id ?? '')).filter(positiveId));
    if (played !== null && played > 0 && fixture.maps?.length === played && knownIds.size === played &&
      matchIds.some((matchId) => !knownIds.has(matchId))) throw new Error('MVP estimate ID conflicts with confirmed fixture map IDs');
  }
  return estimates;
}
function estimationBaseline(records) {
  let total = rational(0n), realPlayerMapCount = 0;
  for (const record of records) {
    if (record.status !== 'ready') continue;
    completeIdentities(record.players);
    for (const player of record.players) {
      const score = scoreMvpMetrics(player.metrics);
      if (compare(decode(score), decode(player.scoreExact)) !== 0) throw new Error('Map score conflicts with metrics');
      total = add(total, decode(score)); realPlayerMapCount++;
    }
  }
  return { realPlayerMapCount, meanExact: realPlayerMapCount ? encode(rational(total.n, total.d * BigInt(realPlayerMapCount))) : null };
}
function withEstimatedMaps(latest, estimates, baseline) {
  for (const estimate of estimates) {
    // Real recovery replaces the estimate; an explicit exclusion still wins.
    if (['ready', 'excluded'].includes(latest.get(estimate.matchId)?.status)) continue;
    const { matchId, fixtureId, winnerTeamId, reason } = estimate;
    const players = estimate.players || [];
    if (!players.length || !baseline.realPlayerMapCount) {
      latest.set(matchId, { matchId, fixtureId, winnerTeamId, status: 'pending', estimatePending: true,
        reason: !players.length ? 'Confirmed played map identities unavailable' : 'No complete real tournament statistics for estimation', players });
      continue;
    }
    latest.set(matchId, { matchId, fixtureId, winnerTeamId, reason, status: 'estimated',
      players: players.map((player) => {
        const factorExact = encode(rational(player.teamId === winnerTeamId ? 115n : 85n, 100n));
        return { ...player, estimation: { factorExact }, scoreExact: encode(multiply(decode(baseline.meanExact), decode(factorExact))) };
      }) });
  }
}
export function buildMvpSnapshot(records, { tournamentId, leagueId, revision = 1, updatedAt = new Date().toISOString(),
  ingestionComplete, ingestionPendingMatchIds, correctionPendingMatchIds, discoveryPending, estimates = [] } = {}) {
  if (!Array.isArray(records) || !text(tournamentId) || !Number.isSafeInteger(leagueId) || leagueId <= 0 ||
    !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid MVP snapshot inputs');
  const maps = {}, identities = new Map();
  // Reimport replaces the same map, rather than adding its score again.
  const latest = new Map(records.map((record) => [String(record.matchId), record]));
  if ([...latest.values()].some((record) => !['ready', 'pending', 'excluded'].includes(record.status))) throw new Error('Estimated scores must be derived from confirmed map inputs');
  validateMvpEstimates(estimates);
  const baseline = estimationBaseline([...latest.values()]);
  withEstimatedMaps(latest, estimates, baseline);
  for (const [matchId, map] of latest) {
    if (!positiveId(matchId) || !['ready', 'estimated', 'pending', 'excluded'].includes(map.status) || !Array.isArray(map.players)) throw new Error('Invalid scored MVP map');
    if (map.status !== 'ready' && !text(map.reason)) throw new Error('MVP pending/excluded map needs a reason');
    if (map.status === 'ready' && (map.players.length !== 10 || new Set(map.players.map((player) => player.accountId)).size !== 10)) throw new Error('Ready map must contain ten unique accounts');
    maps[matchId] = { status: map.status, ...(map.reason ? { reason: map.reason } : {}),
      ...(map.status === 'estimated' || map.estimatePending ? { fixtureId: map.fixtureId, winnerTeamId: map.winnerTeamId } : {}),
      ...(map.estimatePending ? { estimatePending: true } : {}) };
    for (const player of map.players) {
      if (typeof player.accountId !== 'string' || !positiveId(player.accountId) || !text(player.nickname) || !text(player.teamId) || !text(player.teamName)) throw new Error('Invalid MVP player identity');
      let aggregate = identities.get(player.accountId);
      if (!aggregate) { aggregate = { accountId: player.accountId, steamId: steamIdFromAccount(player.accountId),
        nickname: player.nickname, teamIds: [], teamNames: [], countedMaps: 0, playedMaps: 0,
        ratingExact: encode(rational(0n)), rank: null, records: [] }; identities.set(player.accountId, aggregate); }
      aggregate.nickname = player.nickname;
      aggregate.playedMaps++;
      if (!aggregate.teamIds.includes(player.teamId)) { aggregate.teamIds.push(player.teamId); aggregate.teamNames.push(player.teamName); }
      if (!['ready', 'estimated'].includes(map.status)) continue;
      const score = map.status === 'estimated' ? player.scoreExact : scoreMvpMetrics(player.metrics);
      if (compare(decode(score), decode(player.scoreExact)) !== 0) throw new Error('Map score conflicts with metrics');
      aggregate.countedMaps++;
      aggregate.ratingExact = encode(add(decode(aggregate.ratingExact), decode(score)));
      aggregate.records.push({ matchId, fixtureId: map.fixtureId ?? null, heroId: player.heroId,
        teamId: player.teamId, ...(map.status === 'estimated' ? { estimation: player.estimation } : { metrics: player.metrics }), scoreExact: score });
    }
  }
  const snapshot = { schemaVersion: 1, tournamentId, leagueId, formulaVersion: DOTA_MVP_FORMULA_VERSION, revision, updatedAt,
    maps, players: rankedPlayers([...identities.values()]) };
  if (estimates.length) snapshot.estimation = { ruleVersion: DOTA_MVP_ESTIMATION_VERSION, ...baseline };
  if (ingestionComplete !== undefined || ingestionPendingMatchIds !== undefined) {
    snapshot.ingestionComplete = ingestionComplete;
    snapshot.ingestionPendingMatchIds = ingestionPendingMatchIds;
  }
  if (correctionPendingMatchIds !== undefined) snapshot.correctionPendingMatchIds = correctionPendingMatchIds;
  if (discoveryPending !== undefined) snapshot.discoveryPending = discoveryPending;
  if (discoveryPending === true) snapshot.coverageComplete = false;
  validateIngestionMetadata(snapshot);
  validateCorrectionMetadata(snapshot);
  return snapshot;
}
export function validateMvpSnapshot(snapshot, tournament) {
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || snapshot.tournamentId !== tournament.id ||
    snapshot.leagueId !== tournament.leagueId || snapshot.formulaVersion !== DOTA_MVP_FORMULA_VERSION ||
    !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
    !object(snapshot.maps) || !Array.isArray(snapshot.players)) throw new Error('Invalid MVP snapshot header');
  validateIngestionMetadata(snapshot);
  validateCorrectionMetadata(snapshot);
  const seenAccounts = new Set(), accountsByMap = new Map(), slotsByPlayer = new Map(), heroesByMap = new Map(), teamsByMap = new Map();
  const estimatedEntries = []; let realTotal = rational(0n), realPlayerMapCount = 0;
  const confirmations = new Map(validateMvpEstimates(tournament.mvpEstimates || [], tournament).map((map) => [map.matchId, map]));
  const fixtures = new Map((tournament.stages || []).flatMap((stage) =>
    (stage.rounds || [{ matches: stage.matches || [] }]).flatMap((round) => round.matches || [])).map((fixture) => [fixture.id, fixture]));
  for (const [id, map] of Object.entries(snapshot.maps)) {
    if (!positiveId(id) || !object(map) || !['pending', 'ready', 'estimated', 'excluded'].includes(map.status) ||
      (map.status !== 'ready' && !text(map.reason))) throw new Error(`Invalid MVP map ${id}`);
    if (map.status === 'estimated' || own(map, 'estimatePending')) {
      const fixture = fixtures.get(map.fixtureId);
      const confirmation = confirmations.get(id);
      if (!text(map.fixtureId) || !text(map.winnerTeamId) ||
        !confirmation || confirmation.fixtureId !== map.fixtureId || confirmation.winnerTeamId !== map.winnerTeamId ||
        (fixtures.size && (!fixture || ![fixture.team1Id, fixture.team2Id].includes(map.winnerTeamId))) ||
        (own(map, 'estimatePending') && (map.estimatePending !== true || map.status !== 'pending'))) throw new Error('Invalid MVP estimated map confirmation');
    }
    accountsByMap.set(id, new Set());
    heroesByMap.set(id, new Set()); teamsByMap.set(id, new Map());
  }
  for (const player of snapshot.players) {
    if (!object(player) || typeof player.accountId !== 'string' || !positiveId(player.accountId) || seenAccounts.has(player.accountId) ||
      player.steamId !== steamIdFromAccount(player.accountId) || !text(player.nickname) ||
      !Array.isArray(player.teamIds) || !player.teamIds.length || !player.teamIds.every(text) ||
      new Set(player.teamIds).size !== player.teamIds.length || !Array.isArray(player.teamNames) ||
      player.teamIds.length !== player.teamNames.length || !player.teamNames.every(text) ||
      !count(player.countedMaps) || !count(player.playedMaps) || player.playedMaps < player.countedMaps ||
      player.playedMaps > Object.keys(snapshot.maps).length || !Array.isArray(player.records) || player.records.length !== player.countedMaps) throw new Error('Invalid MVP aggregate player');
    seenAccounts.add(player.accountId);
    const seenMaps = new Set(); let total = rational(0n);
    for (const entry of player.records) {
      if (!object(entry) || typeof entry.matchId !== 'string' || !positiveId(entry.matchId) || seenMaps.has(entry.matchId) ||
        !['ready', 'estimated'].includes(snapshot.maps[entry.matchId]?.status) || !player.teamIds.includes(entry.teamId) ||
        !Number.isSafeInteger(entry.heroId) || entry.heroId <= 0 || heroesByMap.get(entry.matchId)?.has(entry.heroId) ||
        !(entry.fixtureId === null || text(entry.fixtureId))) throw new Error('Invalid MVP player map record');
      const fixture = entry.fixtureId === null ? null : fixtures.get(entry.fixtureId);
      if (fixtures.size && (entry.fixtureId !== null || snapshot.retrospective !== true) &&
        (!fixture || ![fixture.team1Id, fixture.team2Id].includes(entry.teamId))) throw new Error('MVP record does not match tournament fixture');
      seenMaps.add(entry.matchId); accountsByMap.get(entry.matchId).add(player.accountId);
      heroesByMap.get(entry.matchId).add(entry.heroId);
      const mapTeams = teamsByMap.get(entry.matchId);
      mapTeams.set(entry.teamId, (mapTeams.get(entry.teamId) || 0) + 1);
      const estimated = snapshot.maps[entry.matchId].status === 'estimated';
      if (estimated && (own(entry, 'metrics') || !object(entry.estimation) || entry.fixtureId !== snapshot.maps[entry.matchId].fixtureId) ||
        !estimated && own(entry, 'estimation')) throw new Error('Invalid MVP score provenance');
      if (estimated && !confirmations.get(entry.matchId)?.players?.some((identity) => identity.accountId === player.accountId &&
        identity.heroId === entry.heroId && identity.teamId === entry.teamId)) throw new Error('MVP estimate lacks confirmed actual player identity');
      const score = estimated ? encode(decode(entry.scoreExact)) : scoreMvpMetrics(entry.metrics);
      if (compare(decode(score), decode(entry.scoreExact)) !== 0) throw new Error('MVP score does not match metrics');
      if (estimated) estimatedEntries.push(entry);
      else { realTotal = add(realTotal, decode(score)); realPlayerMapCount++; }
      total = add(total, decode(score));
    }
    if (compare(total, decode(player.ratingExact)) !== 0) throw new Error('MVP aggregate does not match player maps');
    slotsByPlayer.set(player.accountId, player.rank);
  }
  for (const [id, accounts] of accountsByMap) if (['ready', 'estimated'].includes(snapshot.maps[id].status) &&
    (accounts.size !== 10 || teamsByMap.get(id).size !== 2 || [...teamsByMap.get(id).values()].some((total) => total !== 5))) throw new Error('Ready MVP map lacks two complete five-player teams');
  if (own(snapshot, 'estimation') || estimatedEntries.length) {
    const metadata = snapshot.estimation;
    const mean = realPlayerMapCount ? rational(realTotal.n, realTotal.d * BigInt(realPlayerMapCount)) : null;
    if (!object(metadata) || metadata.ruleVersion !== DOTA_MVP_ESTIMATION_VERSION || metadata.realPlayerMapCount !== realPlayerMapCount ||
      (!mean ? metadata.meanExact !== null : compare(mean, decode(metadata.meanExact)) !== 0)) throw new Error('Invalid MVP real estimation baseline');
    for (const entry of estimatedEntries) {
      const map = snapshot.maps[entry.matchId];
      const factor = rational(entry.teamId === map.winnerTeamId ? 115n : 85n, 100n);
      if (!mean || !teamsByMap.get(entry.matchId).has(map.winnerTeamId) ||
        compare(factor, decode(entry.estimation.factorExact)) !== 0 ||
        compare(multiply(mean, factor), decode(entry.scoreExact)) !== 0) throw new Error('MVP estimate does not match current real baseline');
    }
  }
  for (const ranked of rankedPlayers(snapshot.players)) if (ranked.rank !== slotsByPlayer.get(ranked.accountId)) throw new Error('MVP rank does not match exact score');
  return snapshot;
}

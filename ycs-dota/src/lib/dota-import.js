import { validateDotaSnapshot } from "./dota-results.js";

const fixtures = (tournament) => (tournament.stages || []).flatMap((stage) =>
  (stage.rounds || [{ matches: stage.matches || [] }]).flatMap((round) => round.matches || []))
  .filter((match) => match.team1Id && match.team2Id);
const norm = (name) => typeof name === "string" ? name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "";
const nameFor = (map, side) => map[`${side}_name`] || map[`${side}_team`]?.name;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const matchesKnownMaps = (known, incoming) => known.every((map, index) => {
  const candidate = incoming[index];
  return candidate && ['matchId', 'winnerTeamId', 'kills1', 'kills2', 'durationSeconds', 'url'].every((key) =>
    String(candidate[key]) === String(map[key]));
});

export function isPollWindow(now = new Date(), tournament = null) {
  const publishedStart = tournament?.dates?.start || "2026-10-09";
  const publishedEnd = tournament?.dates?.end || "2026-10-25";
  const firstTimes = fixtures(tournament || {}).filter((match) => match.date === publishedStart && match.scheduledAt)
    .map((match) => Date.parse(match.scheduledAt)).filter(Number.isFinite);
  const start = firstTimes.length ? Math.min(...firstTimes) : Date.parse(`${publishedStart}T${tournament ? "00:00" : "20:30"}:00+03:00`);
  const end = Date.parse(`${publishedEnd}T00:00:00+03:00`) + 24 * 60 * 60_000;
  return Number.isFinite(start) && Number.isFinite(end) && now.getTime() >= start && now.getTime() < end;
}

export function inFixtureWindow(map, fixture) {
  if (!positive(map.start_time)) return false;
  const start = Number(map.start_time) * 1000;
  const beginning = fixture.scheduledAt ? Date.parse(fixture.scheduledAt) - 60 * 60_000 : Date.parse(`${fixture.date}T18:00:00+03:00`);
  const end = Date.parse(`${fixture.date}T00:00:00+03:00`) + 27 * 60 * 60_000;
  return start >= beginning && start < end;
}

export function sideMatches(map, sourceSide, fixture, targetSide) {
  const expectedId = fixture.opendotaTeamIds?.[`team${targetSide}`];
  const actualId = map[`${sourceSide}_team_id`];
  if (expectedId != null) return Number(actualId) === Number(expectedId);
  return Boolean(norm(nameFor(map, sourceSide))) && norm(nameFor(map, sourceSide)) === norm(fixture[`team${targetSide}`]);
}

export function fixtureFor(map, tournament) {
  const candidates = fixtures(tournament).filter((fixture) => inFixtureWindow(map, fixture) && (
    (sideMatches(map, "radiant", fixture, 1) && sideMatches(map, "dire", fixture, 2)) ||
    (sideMatches(map, "radiant", fixture, 2) && sideMatches(map, "dire", fixture, 1))));
  return candidates.length === 1 ? candidates[0] : null;
}

function mapResult(map, fixture, number) {
  const radiantIsFirst = sideMatches(map, "radiant", fixture, 1);
  const winnerTeamId = map.radiant_win === radiantIsFirst ? fixture.team1Id : fixture.team2Id;
  const kills1 = radiantIsFirst ? map.radiant_score : map.dire_score;
  const kills2 = radiantIsFirst ? map.dire_score : map.radiant_score;
  return { number, matchId: String(map.match_id), winnerTeamId, kills1, kills2,
    durationSeconds: map.duration, url: `https://www.opendota.com/matches/${map.match_id}` };
}

export function collectDotaResults(tournament, maps, previous = null, now = new Date()) {
  if (previous) validateDotaSnapshot(previous, tournament);
  const groups = new Map();
  const warnings = [];
  for (const map of maps) {
    if (!positive(map.match_id) || Number(map.leagueid) !== tournament.leagueId || !positive(map.start_time) ||
        typeof map.radiant_win !== "boolean" || !positive(map.duration) ||
        !Number.isSafeInteger(map.radiant_score) || !Number.isSafeInteger(map.dire_score) ||
        map.radiant_score < 0 || map.dire_score < 0) { warnings.push(`Incomplete or foreign map ${map.match_id ?? "unknown"}`); continue; }
    if (!fixtures(tournament).some((fixture) => inFixtureWindow(map, fixture))) continue;
    const fixture = fixtureFor(map, tournament);
    if (!fixture) { warnings.push(`Unmatched map ${map.match_id}`); continue; }
    const bo = Number(String(fixture.bestOf).slice(2));
    if (![1, 3, 5].includes(bo) || (bo > 1 && !positive(map.series_id))) { warnings.push(`Unknown series ${map.match_id}`); continue; }
    const key = `${fixture.id}/${bo === 1 ? "bo1" : map.series_id}`;
    if (!groups.has(key)) groups.set(key, { fixture, maps: new Map() });
    groups.get(key).maps.set(String(map.match_id), map);
  }
  const candidates = new Map();
  for (const { fixture, maps: unique } of groups.values()) {
    const sorted = [...unique.values()].sort((a, b) => Number(a.start_time) - Number(b.start_time) || Number(a.match_id) - Number(b.match_id));
    const resultMaps = sorted.map((map, index) => mapResult(map, fixture, index + 1));
    const need = Math.ceil(Number(fixture.bestOf.slice(2)) / 2);
    const wins1 = resultMaps.filter((map) => map.winnerTeamId === fixture.team1Id).length;
    const wins2 = resultMaps.length - wins1;
    if (Math.max(wins1, wins2) < need) continue;
    if (Math.max(wins1, wins2) > need || resultMaps.length > need * 2 - 1 || candidates.has(fixture.id)) {
      warnings.push(`Ambiguous series ${fixture.id}`);
      candidates.set(fixture.id, null);
      continue;
    }
    candidates.set(fixture.id, { status: "completed", scoreKind: "series", resultConfirmed: true,
      team1Id: fixture.team1Id, team2Id: fixture.team2Id, score1: wins1, score2: wins2,
      winnerTeamId: wins1 > wins2 ? fixture.team1Id : fixture.team2Id,
      seriesId: need === 1 ? null : Number(sorted[0].series_id), maps: resultMaps });
  }
  const matches = { ...(previous?.matches || {}) };
  let changed = false;
  // Sports outcomes confirmed by the organizer do not depend on API/replay
  // availability. A played series may have no recovered map details yet.
  for (const fixture of fixtures(tournament)) {
    if (fixture.resultSource !== "organizer" || fixture.resultConfirmed !== true) continue;
    const result = { status: fixture.status, scoreKind: fixture.scoreKind, resultConfirmed: true,
      team1Id: fixture.team1Id, team2Id: fixture.team2Id, score1: fixture.score1, score2: fixture.score2,
      winnerTeamId: fixture.score1 > fixture.score2 ? fixture.team1Id : fixture.team2Id,
      source: "organizer", confirmationSource: fixture.confirmationSource, confirmedAt: fixture.confirmedAt,
      seriesId: null, maps: (fixture.maps || []).map((map, index) => ({ number: index + 1,
        matchId: String(map.matchId || map.id), winnerTeamId: map.winnerTeamId, kills1: map.kills1,
        kills2: map.kills2, durationSeconds: map.durationSeconds, url: map.url })) };
    const old = matches[fixture.id];
    const sameOutcome = old && old.status === result.status && old.score1 === result.score1 && old.score2 === result.score2;
    if (sameOutcome && old.maps.length >= result.maps.length && matchesKnownMaps(result.maps, old.maps)) result.maps = old.maps;
    else if (sameOutcome && result.maps.length && !matchesKnownMaps(result.maps, old.maps)) warnings.push(`Organizer map evidence replaces conflicting published details for ${fixture.id}`);
    if (JSON.stringify(old) !== JSON.stringify(result)) {
      if (old && !sameOutcome) warnings.push(`Organizer correction for ${fixture.id}`);
      matches[fixture.id] = result;
      changed = true;
    }
  }
  for (const [id, result] of candidates) {
    if (!result) continue;
    if (matches[id]) {
      const old = matches[id];
      if (old.source === "organizer" && old.status === result.status && old.score1 === result.score1 && old.score2 === result.score2 &&
          old.maps.length < result.maps.length) {
        matches[id] = { ...old, seriesId: result.seriesId, maps: result.maps };
        changed = true;
        continue;
      }
      if (old.source === "organizer" && old.status === result.status && old.score1 === result.score1 && old.score2 === result.score2 &&
          JSON.stringify(old.maps) === JSON.stringify(result.maps)) continue;
      if (JSON.stringify(matches[id]) !== JSON.stringify(result)) warnings.push(`Conflict with published result ${id}`);
      continue;
    }
    matches[id] = result;
    changed = true;
  }
  if (!changed) return { snapshot: previous, changed: false, warnings };
  const snapshot = { schemaVersion: 1, tournamentId: tournament.id, leagueId: tournament.leagueId,
    revision: (previous?.revision || 0) + 1, updatedAt: now.toISOString(), matches };
  validateDotaSnapshot(snapshot, tournament);
  return { snapshot, changed: true, warnings };
}

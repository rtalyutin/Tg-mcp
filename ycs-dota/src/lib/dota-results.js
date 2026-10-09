export const DOTA_RESULTS_URL = "https://e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04.s3.twcstorage.ru/results/dota2-autumn-2026.json";

const fixtures = (tournament) => (tournament.stages || []).flatMap((stage) =>
  (stage.rounds || [{ matches: stage.matches || [] }]).flatMap((round) => round.matches || []));
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const matchId = (value) => (typeof value === "string" && /^[1-9]\d*$/.test(value)) || (Number.isSafeInteger(value) && value > 0);
const mapUrl = (id) => `https://www.opendota.com/matches/${id}`;

export function validateDotaSnapshot(snapshot, tournament) {
  if (!record(snapshot) || snapshot.schemaVersion !== 1 || snapshot.tournamentId !== tournament.id ||
      snapshot.leagueId !== tournament.leagueId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
      !Number.isFinite(Date.parse(snapshot.updatedAt)) || !record(snapshot.matches)) throw new Error("Invalid Dota snapshot header");
  const byId = new Map(fixtures(tournament).filter((match) => match.team1Id && match.team2Id).map((match) => [match.id, match]));
  const usedMaps = new Set();
  for (const [id, result] of Object.entries(snapshot.matches)) {
    const fixture = byId.get(id);
    if (!fixture || !record(result) || result.status !== "completed" || result.resultConfirmed !== true || result.scoreKind !== "series" ||
        result.team1Id !== fixture.team1Id || result.team2Id !== fixture.team2Id ||
        !integer(result.score1) || !integer(result.score2) || !Array.isArray(result.maps)) throw new Error(`Invalid Dota result: ${id}`);
    const need = Math.ceil(Number(String(fixture.bestOf).slice(2)) / 2);
    if (![1, 2, 3].includes(need) || Math.max(result.score1, result.score2) !== need || Math.min(result.score1, result.score2) >= need ||
        result.maps.length !== result.score1 + result.score2 || result.maps.length > need * 2 - 1 ||
        result.winnerTeamId !== (result.score1 > result.score2 ? fixture.team1Id : fixture.team2Id) ||
        (need > 1 && !matchId(result.seriesId))) throw new Error(`Invalid Dota series: ${id}`);
    let wins1 = 0, wins2 = 0;
    for (const [index, map] of result.maps.entries()) {
      if (!record(map) || !matchId(map.matchId) || usedMaps.has(String(map.matchId)) ||
          map.url !== mapUrl(map.matchId) || map.number !== index + 1 ||
          !integer(map.kills1) || !integer(map.kills2) || !integer(map.durationSeconds) || map.durationSeconds === 0 ||
          ![fixture.team1Id, fixture.team2Id].includes(map.winnerTeamId)) throw new Error(`Invalid Dota map: ${id}`);
      usedMaps.add(String(map.matchId));
      if (map.winnerTeamId === fixture.team1Id) wins1++; else wins2++;
    }
    if (wins1 !== result.score1 || wins2 !== result.score2) throw new Error(`Dota map winners conflict with series: ${id}`);
  }
  return snapshot;
}

export function applyDotaSnapshot(tournament, snapshot) {
  validateDotaSnapshot(snapshot, tournament);
  const updated = structuredClone(tournament);
  for (const fixture of fixtures(updated)) {
    const result = snapshot.matches[fixture.id];
    if (!result) continue;
    Object.assign(fixture, {
      status: "completed", resultConfirmed: true, scoreKind: "series", score1: result.score1, score2: result.score2,
      winner: result.score1 > result.score2 ? fixture.team1 : fixture.team2,
      maps: result.maps.map((map) => ({ id: String(map.matchId), matchId: String(map.matchId),
        name: `Карта ${map.number}`, winnerTeamId: map.winnerTeamId,
        kills1: map.kills1, kills2: map.kills2, durationSeconds: map.durationSeconds, url: map.url })),
      mapLinks: result.maps.map((map) => ({ matchId: String(map.matchId), url: map.url })),
    });
  }
  const swiss = updated.stages.find((stage) => stage.type === "swiss");
  if (swiss && Object.keys(snapshot.matches).length) {
    const rows = updated.participants.map((participant) => ({ team: participant.displayName, teamId: participant.teamId, played: 0, won: 0, lost: 0 }));
    const byTeam = new Map(rows.map((row) => [row.teamId, row]));
    for (const result of Object.values(snapshot.matches)) {
      const first = byTeam.get(result.team1Id), second = byTeam.get(result.team2Id);
      if (!first || !second) continue;
      first.played++; second.played++;
      byTeam.get(result.winnerTeamId).won++;
      byTeam.get(result.winnerTeamId === result.team1Id ? result.team2Id : result.team1Id).lost++;
    }
    swiss.groups = [{ id: "published-results", title: "Подтверждённые результаты Swiss", rows }];
  }
  return updated;
}

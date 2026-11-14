export const LCE_ID = 'cs2-lce-november-2026';
export const lceFixtures = t => t.stages.flatMap(s => [...(s.matches || []), ...(s.rounds || []).flatMap(r => r.matches || [])]);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: message }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function validateLceResult(match, input) {
  if (!match.team1Id || !match.team2Id) fail('Участники матча ещё не определены');
  if (!object(input) || Object.keys(input).some(k => !['maps', 'outcome', 'winnerSide'].includes(k))) fail('Неверные поля результата');
  const outcome = input.outcome || 'played';
  if (!['played', 'double_no_show', 'series_forfeit'].includes(outcome)) fail('Неизвестный исход');
  if (outcome === 'double_no_show') {
    if (match.bestOf !== 'BO1' || input.maps?.length || input.winnerSide != null) fail('Обоюдная неявка допустима только в BO1');
    return { outcome, maps: [], winnerSide: null, wins: [0, 0] };
  }
  if (outcome === 'series_forfeit') {
    if (!['BO3', 'BO5'].includes(match.bestOf) || ![1, 2].includes(input.winnerSide) || input.maps?.length) fail('Укажите победителя технического поражения в серии');
    return { outcome, maps: [], winnerSide: input.winnerSide, wins: [0, 0] };
  }
  if (input.winnerSide != null || !Array.isArray(input.maps) || !input.maps.length) fail('Введите счёт сыгранных карт');
  const need = (Number(match.bestOf.slice(2)) + 1) / 2;
  const wins = [0, 0];
  const maps = input.maps.map((m, i) => {
    if (Math.max(...wins) >= need) fail('Лишняя карта после завершения серии');
    if (!object(m) || Object.keys(m).some(k => !['score1', 'score2', 'technical'].includes(k)) ||
        ![m.score1, m.score2].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
        m.technical !== undefined && typeof m.technical !== 'boolean') fail(`Карта ${i + 1}: нужны два целых неотрицательных числа`);
    const hi = Math.max(m.score1, m.score2), lo = Math.min(m.score1, m.score2);
    // Standard CS2 MR3 overtime. The event PDF does not specify an alternative.
    const half = match.overtimeRoundsPerHalf || 3;
    const firstOvertimeWin = 13 + half;
    const overtime = hi >= firstOvertimeWin && (hi - firstOvertimeWin) % half === 0 && lo >= hi - half - 1 && lo <= hi - 2;
    if (!(m.technical ? hi === 13 && lo === 0 : hi === 13 && lo <= 11 || overtime)) fail(`Карта ${i + 1}: нужен финальный счёт (12:12 не допускается)`);
    wins[m.score1 > m.score2 ? 0 : 1]++;
    return { score1: m.score1, score2: m.score2, technical: Boolean(m.technical) };
  });
  if (Math.max(...wins) !== need) fail(`Серия не завершена: нужно ${need} побед`);
  return { outcome, maps, wins, winnerSide: wins[0] > wins[1] ? 1 : 2 };
}
function stats(teams, matches, results) {
  const rows = new Map(teams.map(p => [p.teamId, { teamId: p.teamId, team: p.displayName, played: 0, won: 0, lost: 0, points: 0, roundsFor: 0, roundsAgainst: 0, roundDifference: 0 }]));
  for (const m of matches) {
    const result = results[m.id]; if (!result || !rows.has(m.team1Id) || !rows.has(m.team2Id)) continue;
    const a = rows.get(m.team1Id), b = rows.get(m.team2Id); a.played++; b.played++;
    if (result.outcome === 'double_no_show') continue;
    const winner = result.winnerSide === 1 ? a : b, loser = winner === a ? b : a;
    winner.won++; winner.points++; loser.lost++;
    for (const map of result.maps) { a.roundsFor += map.score1; a.roundsAgainst += map.score2; b.roundsFor += map.score2; b.roundsAgainst += map.score1; }
  }
  for (const r of rows.values()) r.roundDifference = r.roundsFor - r.roundsAgainst;
  return rows;
}
const partition = (items, value) => {
  const groups = new Map(); for (const item of items) { const key = value(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return [...groups].sort(([a], [b]) => b - a).map(([, group]) => group);
};
function headToHead(group, matches, results) {
  const ids = new Set(group.map(r => r.teamId));
  const match = matches.find(m => ids.has(m.team1Id) && ids.has(m.team2Id));
  const result = match && results[match.id];
  if (!result?.winnerSide) return [group];
  const winner = match[`team${result.winnerSide}Id`];
  return [[group.find(r => r.teamId === winner)], [group.find(r => r.teamId !== winner)]];
}
export function deriveLce(baseline, document, registry = null) {
  const tournament = structuredClone(baseline), results = document.matches || {};
  if (registry) {
    for (const p of tournament.participants) p.displayName = registry.teams.find(t => t.id === p.teamId)?.name || p.displayName;
    for (const m of lceFixtures(tournament)) for (const side of [1, 2]) {
      const p = tournament.participants.find(p => p.teamId === m[`team${side}Id`]); if (p) m[`team${side}`] = p.displayName;
    }
  }
  const main = lceFixtures(tournament), groupMatches = main.filter(m => m.id.startsWith('lce-group-'));
  const complete = groupMatches.every(m => results[m.id]);
  const table = stats(tournament.participants, groupMatches, results);
  let groups = partition([...table.values()], r => r.points).flatMap(group => {
    if (group.length === 1) return [group];
    if (group.length === 2) return headToHead(group, groupMatches, results);
    const ids = new Set(group.map(r => r.teamId));
    const mini = stats(tournament.participants.filter(p => ids.has(p.teamId)), groupMatches, results);
    let subgroups = [group];
    for (const value of [r => mini.get(r.teamId).won, r => mini.get(r.teamId).roundDifference, r => r.roundDifference]) subgroups = subgroups.flatMap(g => partition(g, value));
    return subgroups.flatMap(g => g.length === 2 ? headToHead(g, groupMatches, results) : [g]);
  });
  const tiebreaks = [], unresolved = [];
  let offset = 0;
  groups = groups.flatMap(group => {
    const start = offset; offset += group.length;
    if (!complete || group.length < 2 || start >= 4) return [group];
    const ids = group.map(r => r.teamId).sort();
    const key = ids.map(id => id.split('-').at(-1)).join('-');
    const fixtures = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const id = `lce-tb-${key}-${i}-${j}`;
      const scheduledAt = document.slots?.[id] || null;
      fixtures.push({ id, team1Id: ids[i], team2Id: ids[j], team1: group.find(r => r.teamId === ids[i]).team, team2: group.find(r => r.teamId === ids[j]).team, bestOf: 'BO1', status: 'scheduled', date: '2026-11-14', scheduledAt, stage: 'Тай-брейк' });
    }
    tiebreaks.push(...fixtures);
    if (!fixtures.every(m => results[m.id])) { unresolved.push(key); return [group]; }
    const tbStats = stats(tournament.participants.filter(p => ids.includes(p.teamId)), fixtures, results);
    let resolved = partition(group, r => tbStats.get(r.teamId).won).flatMap(g => partition(g, r => tbStats.get(r.teamId).roundDifference));
    return resolved.flatMap(g => {
      if (g.length === 1) return [g];
      const drawKey = g.map(r => r.teamId).sort().join('|');
      const draw = document.draws?.[drawKey];
      if (!draw || draw.length !== g.length || new Set(draw).size !== g.length || !draw.every(id => g.some(r => r.teamId === id))) { unresolved.push(drawKey); return [g]; }
      return draw.map(id => [g.find(r => r.teamId === id)]);
    });
  });
  const ready = complete && !unresolved.length;
  let position = 1;
  const rows = groups.flatMap(g => { const pos = position; position += g.length; return g.map(r => ({ ...r, position: pos, provisional: !ready })); });
  tournament.stages[0].groups[0].rows = rows;
  tournament.stages[0].notice = ready ? 'Итоговые места' : 'Предварительные места · посев ещё не определён';
  if (tiebreaks.length) tournament.stages.splice(2, 0, { id: 'tiebreaks', type: 'match_schedule', title: 'Тай-брейки', notice: 'Резерв — 22:30 МСК. До назначения слота время уточняется.', matches: tiebreaks });
  const all = lceFixtures(tournament), byId = new Map(all.map(m => [m.id, m]));
  if (ready) for (const [id, a, b] of [['lce-sf-1', 0, 3], ['lce-sf-2', 1, 2]]) {
    const m = byId.get(id); for (const [side, row] of [[1, rows[a]], [2, rows[b]]]) { m[`team${side}Id`] = row.teamId; m[`team${side}`] = row.team; }
  }
  for (const m of all) {
    const raw = results[m.id]; if (!raw) continue;
    if (raw.team1Id !== m.team1Id || raw.team2Id !== m.team2Id) fail(`Изменение затрагивает сохранённый матч ${m.id}`, 409);
    const result = validateLceResult(m, { maps: raw.maps, outcome: raw.outcome, ...(raw.outcome === 'series_forfeit' ? { winnerSide: raw.winnerSide } : {}) });
    if (raw.winnerSide !== result.winnerSide || JSON.stringify(raw.wins) !== JSON.stringify(result.wins)) fail('Результат в хранилище не соответствует картам', 503);
    Object.assign(m, { displayRoundScore: true, resultConfirmed: true, status: result.outcome === 'played' ? 'completed' : 'walkover', scoreKind: m.bestOf === 'BO1' && result.outcome === 'played' ? 'rounds' : result.outcome === 'played' ? 'series' : 'technical', outcome: result.outcome,
      maps: result.maps.map((map, i) => ({ ...map, id: `${m.id}-map-${i + 1}`, name: `Карта ${i + 1}` })),
      note: result.outcome === 'double_no_show' ? 'Обоюдная неявка' : result.outcome === 'series_forfeit' ? 'Техническое поражение в серии · по решению судьи' : null });
    if (result.outcome === 'played') { m.score1 = m.bestOf === 'BO1' ? result.maps[0].score1 : result.wins[0]; m.score2 = m.bestOf === 'BO1' ? result.maps[0].score2 : result.wins[1]; }
    if (result.winnerSide) {
      m.winnerTeamId = m[`team${result.winnerSide}Id`]; m.winner = m[`team${result.winnerSide}`];
      if (m.winnerTo) { const target = byId.get(m.winnerTo.matchId); target[`team${m.winnerTo.slot}Id`] = m.winnerTeamId; target[`team${m.winnerTo.slot}`] = m.winner; }
    }
  }
  for (const id of Object.keys(results)) if (!byId.has(id)) fail(`Изменение затрагивает сохранённый матч ${id}`, 409);
  const final = byId.get('lce-final');
  if (final.winnerTeamId) {
    tournament.status = 'completed'; tournament.statusLabel = 'Турнир завершён';
    tournament.results = { finalMatchId: final.id, placements: [{ position: 1, team: final.winner }, { position: 2, team: final.winnerTeamId === final.team1Id ? final.team2 : final.team1 }] };
  }
  return { schemaVersion: 1, revision: document.revision, updatedAt: document.updatedAt, tournament, groupReady: ready, unresolved };
}
export { fail as lceFail };

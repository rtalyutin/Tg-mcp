const bracketTypes = new Set(["double_elimination", "single_elimination"]);
const finishedStatuses = new Set(["completed", "walkover", "bye"]);
export const participantCount = (tournament) => new Set((tournament.participants || []).map((p) => p.teamId)).size;
export const registrationCountLabel = (tournament) => `${participantCount(tournament)} из ${tournament.registration.capacity} команд`;
const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export const isArchive = (tournament) => ["archive", "completed"].includes(tournament.status);
export const hasScore = (match) => Number.isFinite(match.score1) && Number.isFinite(match.score2);
export const isFinished = (match) => match.resultConfirmed === false ? false : finishedStatuses.has(match.status) || (!match.status && hasScore(match));
export const isPlayoffStage = (stage) => bracketTypes.has(stage.type) || stage.phase === "playoffs" || (!/before|group|до\s+плей/i.test(`${stage.id} ${stage.title}`) && /playoff|плей.?офф/i.test(`${stage.id} ${stage.title}`));
export const resultGroups = (results) => Array.isArray(results?.divisions) ? results.divisions : results ? [results] : [];
export function getTournamentOutcome(tournament) {
  if (!isArchive(tournament) || !tournament.results) return null;
  const matches = (tournament.stages || []).flatMap((stage) => stage.rounds ? stage.rounds.flatMap((round) => round.matches || []) : stage.matches || []);
  const groups = resultGroups(tournament.results).map((group) => ({
    ...group,
    final: matches.find((match) => match.id === group.finalMatchId && isFinished(match) && hasScore(match)) || null,
    placements: [...(group.placements || [])].sort((a, b) => a.position - b.position),
  }));
  if (!groups.some((group) => group.final || group.placements.length)) return null;
  const divisions = tournament.results.divisions ? groups : [];
  const overall = divisions.length ? null : groups[0];
  return { divisions, final: overall?.final || null, placements: overall?.placements || [], champion: overall?.placements.find((entry) => entry.position === 1)?.team || null };
}
export function getChampionLabels(tournament) {
  const outcome = getTournamentOutcome(tournament);
  return outcome?.divisions.length
    ? outcome.divisions.flatMap((division) => division.placements.filter((entry) => entry.position === 1).map((entry) => `${division.title} · ${entry.team}`))
    : outcome?.champion ? [`Чемпион · ${outcome.champion}`] : [];
}
export const plural = (count, forms) => forms[count % 100 >= 11 && count % 100 <= 14 ? 2 : count % 10 === 1 ? 0 : count % 10 >= 2 && count % 10 <= 4 ? 1 : 2];
export const resultLabel = (count) => `${count} ${plural(count, ["результат", "результата", "результатов"])}`;
export const matchLabel = (count) => `${count} ${plural(count, ["матч", "матча", "матчей"])}`;

// Legacy cards have display dates only. Parse their calendar order without
// supplying a year where the source (e.g. Dota Qual) deliberately omits it.
export function matchDateParts(match) {
  const text = match.date || match.dateDisplay || "";
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { year: +iso[1], month: +iso[2], day: +iso[3] };
  const numeric = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  if (numeric) return { year: numeric[3] ? +numeric[3] : null, month: +numeric[2], day: +numeric[1] };
  const named = text.toLowerCase().match(/^(\d{1,2})\s+([а-я]+)/);
  if (!named) return null;
  const month = months.findIndex((prefix) => named[2].startsWith(prefix)) + 1;
  return month ? { year: null, month, day: +named[1] } : null;
}

function orderKey(match, tournament) {
  const parts = matchDateParts(match);
  if (!parts) return null;
  const baseYear = Number(tournament.dates?.start?.slice(0, 4)) || 0;
  const time = (match.time || match.dateDisplay || "").match(/(\d{1,2}):(\d{2})/);
  return ((parts.year ?? baseYear) * 10000 + parts.month * 100 + parts.day) * 1440 + (time ? +time[1] * 60 + +time[2] : 0);
}

export function displayMatchDate(match) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(match.date || "")) {
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${match.date}T12:00:00Z`));
  }
  return match.dateDisplay || match.date || "Дата уточняется";
}

export function getTournamentModel(tournament) {
  const stages = tournament.stages || [];
  const matches = stages.flatMap((stage) => {
    const rounds = stage.rounds || [{ matches: stage.matches || [] }];
    return rounds.flatMap((round, roundIndex) => (round.matches || []).map((match, matchIndex) => ({
      ...match,
      key: `${stage.id}:${round.id || roundIndex}:${match.id || matchIndex}`,
      stageId: stage.id,
      stageTitle: stage.title,
      roundTitle: round.label || match.stage || stage.title,
      phase: isPlayoffStage(stage) ? "playoffs" : "before-playoffs",
    }))).filter((match) => match.team1 || match.team2 || hasScore(match));
  });
  matches.sort((a, b) => {
    if (isFinished(a) !== isFinished(b)) return isFinished(a) ? 1 : -1;
    const first = orderKey(a, tournament), second = orderKey(b, tournament);
    if (first === null || second === null) return first === second ? 0 : first === null ? 1 : -1;
    return isFinished(a) ? second - first : first - second;
  });
  const tableStages = stages.filter((stage) => ["round_robin", "swiss"].includes(stage.type));
  const playoffStages = stages.filter(isPlayoffStage);
  const otherStages = stages.filter((stage) => !tableStages.includes(stage) && !playoffStages.includes(stage) && !["match_schedule", "historical_matches"].includes(stage.type));
  const sections = [
    ...(getTournamentOutcome(tournament) ? [{ id: "results", title: "Итоги" }] : []),
    ...(tournament.participants ? [{ id: "participants", title: "Заявленные команды", count: participantCount(tournament) }] : []),
    ...tableStages.map((stage) => ({ id: stage.id, title: stage.title, stage })),
    ...(matches.length ? [{ id: "matches", title: "Матчи", count: matches.length }] : []),
    ...playoffStages.map((stage) => ({ id: stage.id, title: stage.title, stage })),
    ...otherStages.map((stage) => ({ id: stage.id, title: stage.title, stage })),
    ...(tournament.discipline === "Dota 2" ? [{ id: "mvp", title: "MVP турнира" }] : []),
    ...((tournament.summary || tournament.sourceNote || tournament.timeline?.length || tournament.prizeDistribution || tournament.additionalAwards?.length || tournament.referralContest) ? [{ id: "info", title: "О турнире" }] : []),
  ];
  const filters = [{ id: "all", title: "Все", count: matches.length }];
  for (const [id, title] of [["before-playoffs", "До плей-офф"], ["playoffs", "Плей-офф"]]) {
    const count = matches.filter((match) => match.phase === id).length;
    if (count) filters.push({ id, title, count });
  }
  return { stages, sections, matches, filters, finishedCount: matches.filter(isFinished).length,
    defaultSection: getTournamentOutcome(tournament) ? "results" : matches.length ? "matches" : sections.find((section) => section.id === "info")?.id || sections[0]?.id,
    defaultPhase: filters.some((filter) => filter.id === "playoffs") ? "playoffs" : "all" };
}

export function resolveTournamentView(model, search = "", hash = "") {
  const params = new URLSearchParams(search);
  let section = params.get("section") || model.defaultSection;
  let phase = params.get("phase") || model.defaultPhase;
  let anchor = "";
  try { anchor = decodeURIComponent(hash.replace(/^#/, "")); } catch { /* Ignore a malformed link. */ }
  if (model.sections.some((item) => item.id === anchor)) section = anchor;
  else if (model.stages.some((stage) => stage.id === anchor) && model.matches.some((match) => match.stageId === anchor)) { section = "matches"; phase = anchor; }
  else if (["format", "rewards", "schedule"].includes(anchor)) section = "info";
  if (!model.sections.some((item) => item.id === section)) section = model.defaultSection;
  if (!model.filters.some((item) => item.id === phase) && !model.stages.some((stage) => stage.id === phase)) phase = model.defaultPhase;
  return { section, phase, query: params.get("q") || "" };
}

export function filterTournamentMatches(matches, phase, query = "") {
  const normalized = query.trim().normalize("NFKC").toLocaleLowerCase("ru-RU");
  return matches.filter((match) => (phase === "all" || phase === match.phase || phase === match.stageId) &&
    (!normalized || [match.team1, match.team2].some((name) => (name || "").normalize("NFKC").toLocaleLowerCase("ru-RU").includes(normalized))));
}

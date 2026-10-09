import { exactStart, normalizeResult, safeHttps } from './community.js';

export const ORGANIZER_TIME_ZONE = 'Europe/Moscow';

function people(items = []) {
  return items.filter((item) => item && (typeof item === 'string' || item.name))
    .map((item) => typeof item === 'string' ? { name: item } : {
      name: item.name, role: item.role || null, url: safeHttps(item.url),
    });
}

export function buildOrganizerTable(tournaments, assignments = { matches: {}, tournaments: {} }) {
  const rows = [];
  const seen = new Set();
  for (const tournament of tournaments) {
    const common = assignments.tournaments?.[tournament.id] || {};
    for (const stage of tournament.stages || []) {
      const rounds = [...(stage.rounds || []),
        ...(stage.matches ? [{ id: stage.id, label: stage.title, matches: stage.matches, flatStage: true }] : []),
        ...(stage.groups || []).filter((group) => group.matches)];
      for (const round of rounds) for (const match of round.matches || []) {
        const key = `${tournament.id}/${match.id}`;
        if (!match.id || match.published === false || seen.has(key)) continue;
        seen.add(key);
        const assigned = assignments.matches?.[key] || {};
        const start = exactStart(match.scheduledAt);
        const result = normalizeResult(match, tournament.discipline);
        const broadcastUrl = safeHttps(assigned.broadcast?.url || match.broadcastUrl || match.streamUrl);
        rows.push({
          key, id: match.id, tournamentId: tournament.id, tournamentSlug: tournament.slug,
          tournamentTitle: tournament.title, season: tournament.season || '', discipline: tournament.discipline,
          stageId: stage.id, stageTitle: stage.title,
          roundId: round.flatStage ? match.roundId || match.stage || stage.id : round.id || stage.id,
          roundTitle: round.flatStage ? match.stage || stage.title : round.label || round.title || match.stage || stage.title,
          team1: match.team1 || null, team2: match.team2 || null, bestOf: match.bestOf || null,
          status: match.status || 'unknown', resultConfirmed: result.confirmed,
          score: result.score, technical: result.technical,
          scheduledAt: start, date: match.date || null,
          dateDisplay: match.dateDisplay || match.dateLabel || null, time: match.time || null,
          timeZone: start ? ORGANIZER_TIME_ZONE : match.timeZone || tournament.timeZone || null,
          broadcast: { url: broadcastUrl,
            planned: Boolean(broadcastUrl || assigned.broadcast?.planned || match.broadcastPlanned ||
              tournament.homeBroadcastMatchIds?.includes(match.id)) },
          replayUrl: safeHttps(match.replayUrl),
          casters: people(assigned.casters || match.casters),
          partners: people(assigned.partners || match.partners),
          tournamentPartners: people(common.partners || tournament.partners || tournament.matchday?.partners),
          note: assigned.note || match.note || null,
        });
      }
    }
  }
  rows.sort((a, b) => {
    const dateA = a.scheduledAt || (/^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? `${a.date}T${a.time || '23:59'}` : '9999');
    const dateB = b.scheduledAt || (/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? `${b.date}T${b.time || '23:59'}` : '9999');
    return dateA.localeCompare(dateB) || a.key.localeCompare(b.key);
  });
  return { schemaVersion: 1, timeZone: ORGANIZER_TIME_ZONE,
    tournaments: tournaments.map((t) => ({ id: t.id, title: t.title, season: t.season || '', discipline: t.discipline })), rows };
}

export function filterOrganizerRows(rows, { tournament = '', round = '', broadcast = '', query = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase('ru');
  return rows.filter((row) => (!tournament || row.tournamentId === tournament) &&
    (!round || `${row.tournamentId}/${row.stageId}/${row.roundId}` === round) &&
    (!broadcast || (broadcast === 'planned' ? row.broadcast.planned : !row.broadcast.planned)) &&
    (!needle || [row.id, row.team1, row.team2, row.tournamentTitle, row.season, row.roundTitle,
      ...row.casters.map((p) => p.name), ...row.partners.map((p) => p.name),
      ...row.tournamentPartners.map((p) => p.name)].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(needle)));
}

export function organizerDate(row) {
  if (row.scheduledAt) return new Intl.DateTimeFormat('ru-RU', {
    timeZone: ORGANIZER_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(row.scheduledAt));
  const date = row.dateDisplay || row.date || 'Дата уточняется';
  return row.time ? `${date} · ${row.time}${row.timeZone === ORGANIZER_TIME_ZONE ? ' МСК' : row.timeZone ? ` (${row.timeZone})` : ' · часовой пояс не указан'}` : date;
}

export function organizerTimeNote(row) {
  if (row.scheduledAt || row.time) return null;
  if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(row.dateDisplay || '')) {
    return row.timeZone === ORGANIZER_TIME_ZONE ? 'МСК' : row.timeZone || 'Часовой пояс не указан';
  }
  return 'Время уточняется';
}

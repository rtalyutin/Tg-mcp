import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CaptainError, createRateLimit, createTelegramVerifier, fail } from './captain-auth.mjs';
import { CAPTAIN_MAX_BYTES, CAPTAIN_TOURNAMENT_ID, createCaptainS3Store, validateCaptainState } from './captain-store.mjs';
import { createCaptainResultsReader } from './captain-results-reader.mjs';
import { applyDotaSnapshot, validateDotaSnapshot } from '../src/lib/dota-results.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function bindingVersion(state, teamId) {
  // Revocation also has a version: absent -> assigned -> revoked must not
  // look like the original never-assigned row to an older browser.
  const event = state.history.findLast((entry) => entry.teamId === teamId && ['captain_assigned', 'captain_revoked'].includes(entry.kind));
  return event ? digest(event.id) : state.bindings[teamId] ? digest(state.bindings[teamId].generation) : null;
}
const randomId = () => randomBytes(32).toString('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = (value) => {
  if (typeof value !== 'string' || !isoOffset.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second = '0'] = value.match(/^([\d]{4})-([\d]{2})-([\d]{2})T([\d]{2}):([\d]{2})(?::([\d]{2}))?/).slice(1);
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return calendar.toISOString().slice(0, 10) === `${year}-${month}-${day}` && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
};
const emptyMatch = () => ({ scheduleVersion: 0, proposal: null, agreed: null, resultClaims: [], chat: null, chatClosed: false });
const chatEvents = new Set(['chat_opened', 'chat_reset', 'message']);
const generations = (participants, state) => participants.map((id) => state.bindings[id]?.generation ?? null);
const loadTournament = () => readFile(new URL(`../src/data/tournaments/${CAPTAIN_TOURNAMENT_ID}.json`, import.meta.url), 'utf8').then(JSON.parse);
const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };

export function createCaptainTournamentSource({ env = process.env, readSnapshot = createCaptainResultsReader({ env }), now = Date.now, load = loadTournament } = {}) {
  let baselinePromise, latest, pending, refreshedAt = -Infinity, available = false;
  return async () => {
    const baseline = await (baselinePromise ||= load());
    if (!pending && now() - refreshedAt >= 60_000) {
      pending = (async () => {
        try {
          const result = await readSnapshot();
          if (result === null && !latest) available = true;
          else {
            const snapshot = validateDotaSnapshot(result, baseline);
            if (!latest || snapshot.revision > latest.revision) latest = snapshot;
            else if (snapshot.revision === latest.revision && JSON.stringify(snapshot) !== JSON.stringify(latest)) throw new Error();
            available = true;
          }
        } catch { available = false; }
        finally { refreshedAt = now(); pending = null; }
      })();
    }
    if (pending) await pending;
    return { ...(latest ? applyDotaSnapshot(baseline, latest) : baseline), captainResultsAvailable: available };
  };
}

function parseWindows(source) {
  if (!source) return {};
  try {
    const value = typeof source === 'string' ? JSON.parse(source) : source;
    if (!object(value)) throw new Error();
    for (const [key, window] of Object.entries(value)) if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(key) || !object(window) ||
      !timestamp(window.start) || !timestamp(window.end) || Date.parse(window.start) >= Date.parse(window.end)) throw new Error();
    return structuredClone(value);
  } catch { fail('captain_not_configured', 503); }
}

function catalog(tournament, windows) {
  if (!object(tournament) || tournament.id !== CAPTAIN_TOURNAMENT_ID || !Array.isArray(tournament.participants)) fail('storage_unavailable', 503);
  const teams = tournament.participants.map((p) => ({ id: p.teamId, name: p.displayName }));
  const teamMap = new Map(teams.map((team) => [team.id, team]));
  if (teamMap.size !== teams.length || teams.some((t) => typeof t.id !== 'string' || typeof t.name !== 'string')) fail('storage_unavailable', 503);
  const matches = [];
  for (const stage of tournament.stages || []) for (const round of stage.rounds || [{ label: stage.title, matches: stage.matches }]) {
    for (const m of round.matches || []) {
      if (m.published === false || !teamMap.has(m.team1Id) || !teamMap.has(m.team2Id) || m.team1Id === m.team2Id) continue;
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(m.id) || matches.some((match) => match.id === m.id)) fail('storage_unavailable', 503);
      matches.push({ id: m.id, team1: teamMap.get(m.team1Id), team2: teamMap.get(m.team2Id), round: round.label || stage.title || '',
        bestOf: m.bestOf || null, status: m.resultConfirmed === true ? 'completed' : m.status || 'unknown',
        scheduledAt: timestamp(m.scheduledAt) ? new Date(m.scheduledAt).toISOString() : null,
        window: own(windows, m.id) ? windows[m.id] : null, broadcastUrl: safeUrl(m.broadcastUrl || m.streamUrl), note: m.note || '' });
    }
  }
  return { teams, teamMap, matches, matchMap: new Map(matches.map((match) => [match.id, match])),
    resultsAvailable: tournament.captainResultsAvailable !== false };
}

function detail(state, match, viewerTeamId = null) {
  const current = state.matches[match.id] || emptyMatch();
  return { match: { ...match, status: current.chatClosed ? 'completed' : match.status, scheduledAt: current.agreed?.startsAt || match.scheduledAt }, viewerTeamId,
    messages: viewerTeamId && !current.chatClosed ? current.chat?.messages || [] : [],
    chatEpoch: viewerTeamId && !current.chatClosed ? current.chat?.epoch || null : null, chatClosed: current.chatClosed,
    scheduleVersion: current.scheduleVersion, proposal: current.proposal,
    agreed: current.agreed, resultClaims: current.resultClaims };
}
function validateParticipants(state, current) {
  for (const match of current.matches) {
    const record = state.matches[match.id];
    if (!record) continue;
    const teams = [match.team1.id, match.team2.id];
    if (record.resultClaims.some((item) => !teams.includes(item.teamId)) ||
      record.proposal?.confirmedTeamIds.some((teamId) => !teams.includes(teamId)) ||
      (record.chat && JSON.stringify(record.chat.participants) !== JSON.stringify(teams))) fail('storage_unavailable', 503);
  }
}
function organizerDTO(state, current) {
  return { revision: state.revision, assignmentVersion: 1, teams: current.teams,
    bindingVersions: Object.fromEntries(current.teams.map((team) => [team.id, bindingVersion(state, team.id)])),
    bindings: Object.entries(state.bindings).filter(([teamId]) => current.teamMap.has(teamId))
      .map(([teamId, binding]) => ({ teamId, username: binding.username, linked: Boolean(binding.userId), version: bindingVersion(state, teamId) })),
    matches: current.matches.map((match) => detail(state, match)) };
}
function currentBinding(state, user) {
  return Object.entries(state.bindings).find(([, b]) => b.userId === user.id) ||
    Object.entries(state.bindings).find(([, b]) => b.userId === null && user.username && b.username === user.username) || null;
}
function requestToken(actor, body) {
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) fail('invalid_request');
  const fingerprint = digest(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'initData').sort(([a], [b]) => a.localeCompare(b)))));
  return { key: digest(`${actor}\n${body.requestId}`), fingerprint };
}
function alreadyApplied(state, token) {
  if (!own(state.requests, token.key)) return false;
  if (state.requests[token.key].fingerprint !== token.fingerprint) fail('idempotency_conflict', 409);
  return true;
}
function checkKeys(body, keys) {
  if (!object(body) || Object.keys(body).some((key) => !keys.includes(key))) fail('invalid_request');
}
function validateInput(body) {
  const base = ['action', 'initData'];
  const keys = { access: base, match: [...base, 'matchId'],
    message: [...base, 'matchId', 'requestId', 'text', 'expectedChatEpoch'], agree: [...base, 'matchId', 'requestId', 'expectedScheduleVersion', 'startsAt'],
    result: [...base, 'matchId', 'requestId', 'score', 'comment'] };
  if (!object(body) || !own(keys, body.action)) fail('invalid_request');
  checkKeys(body, keys[body.action]);
  if (body.action !== 'access' && (typeof body.matchId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(body.matchId))) fail('invalid_request');
  if (body.action === 'message' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000 || body.text.includes('\0') ||
    typeof body.expectedChatEpoch !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedChatEpoch))) fail('invalid_request');
  if (body.action === 'agree' && (!Number.isSafeInteger(body.expectedScheduleVersion) || body.expectedScheduleVersion < 0 || !timestamp(body.startsAt))) fail('invalid_request');
  if (body.action === 'result' && (!Array.isArray(body.score) || body.score.length !== 2 ||
    body.score.some((score) => !Number.isSafeInteger(score) || score < 0) ||
    typeof body.comment !== 'string' || body.comment.length > 1000 || body.comment.includes('\0'))) fail('invalid_request');
}

export function createCaptainService({ env = process.env, store = createCaptainS3Store({ env }), rosterImport = null,
  now = Date.now, getTournament = createCaptainTournamentSource({ env, now }), verify = createTelegramVerifier({ botId: env.YCS_CAPTAIN_BOT_ID, now }) } = {}) {
  const readLimit = createRateLimit({ now });
  const writeLimit = createRateLimit({ now, limit: 30 });
  let readiness = { resultsAvailable: null, matchCount: null, windowCount: null };
  const observeCatalog = (current, windowCount = current.matches.filter((match) => match.window !== null).length) => {
    readiness = { resultsAvailable: current.resultsAvailable, matchCount: current.matches.length, windowCount };
  };
  const getCatalog = async () => {
    const current = catalog(await getTournament(), parseWindows(env.YCS_CAPTAIN_WINDOWS_JSON));
    observeCatalog(current);
    await ensureRoster(current);
    return current;
  };
  let rosterPending;
  const rosterStatus = { id: rosterImport?.id ?? null, status: rosterImport ? 'pending' : 'not-configured', count: 0, revision: null };
  let highestRevision = 0;
  function observe(state) {
    validateCaptainState(state);
    if (state.revision < highestRevision) fail('storage_conflict', 409);
    highestRevision = state.revision;
    return state;
  }
  async function freshState() {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return observe((await store.read()).value); }
      catch (error) { if (error.code !== 'storage_conflict') throw error; }
    }
    fail('conflict', 409);
  }

  async function transact(apply) {
    const mutationId = randomId();
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await store.read();
      try { observe(previous.value); }
      catch (error) { if (error.code === 'storage_conflict') continue; throw error; }
      const next = structuredClone(previous.value);
      const event = apply(next);
      if (!event) return previous.value;
      next.revision++;
      next.history.push({ ...event, id: mutationId, at: new Date(now()).toISOString() });
      validateCaptainState(next);
      if (Buffer.byteLength(JSON.stringify(next)) > CAPTAIN_MAX_BYTES) fail('capacity_reached', 503);
      try { return observe((await store.compareAndSet(previous, next, mutationId)).value); }
      catch (error) { if (error.code !== 'storage_conflict') throw error; }
    }
    fail('conflict', 409);
  }

  async function cleanupFromCatalog(current) {
    const completed = current.matches.filter((match) => match.status === 'completed').map((match) => match.id);
    if (!completed.length) return null;
    return transact((next) => {
      const changed = completed.filter((id) => next.matches[id]?.chatClosed !== true);
      if (!changed.length) return null;
      const closed = new Set(changed);
      for (const id of changed) {
        const record = next.matches[id] ||= emptyMatch();
        record.chat = null;
        record.chatClosed = true;
      }
      for (const [key, receipt] of Object.entries(next.requests)) if (receipt.action === 'message' && closed.has(receipt.matchId)) delete next.requests[key];
      next.history = next.history.filter((event) => !(chatEvents.has(event.kind) && closed.has(event.matchId)));
      return { kind: 'matches_closed', matchIds: changed };
    });
  }

  function applyAssignment(next, teamId, username) {
    const previous = next.bindings[teamId];
    if ((previous?.username ?? null) !== username) {
      if (username) next.bindings[teamId] = { username, userId: null, generation: randomId() };
      else delete next.bindings[teamId];
      for (const record of Object.values(next.matches)) {
        if (record.chat?.participants.includes(teamId)) {
          record.chat.epoch = randomId();
          record.chat.generations = generations(record.chat.participants, next);
        }
        if (record.proposal?.confirmedTeamIds.length < 2 && record.proposal.confirmedTeamIds.includes(teamId)) {
          record.proposal.confirmedTeamIds = record.proposal.confirmedTeamIds.filter((id) => id !== teamId);
          if (!record.proposal.confirmedTeamIds.length) record.proposal = null;
          record.scheduleVersion++;
        }
      }
    }
    return { kind: username ? 'captain_assigned' : 'captain_revoked', teamId,
      previousGeneration: previous?.generation ?? null, nextGeneration: next.bindings[teamId]?.generation ?? null };
  }

  async function ensureRoster(current) {
    if (!rosterImport || rosterStatus.status === 'applied') return;
    if (rosterPending) return rosterPending;
    rosterPending = (async () => {
      if (!object(rosterImport) || typeof rosterImport.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(rosterImport.id) ||
        !Array.isArray(rosterImport.assignments) || !rosterImport.assignments.length) fail('invalid_request');
      const entries = rosterImport.assignments;
      const usernames = entries.map((entry) => entry.username);
      if (entries.some((entry) => !object(entry) || !onlyAssignment(entry) || !current.teamMap.has(entry.teamId) ||
        typeof entry.username !== 'string' || !/^[a-z0-9_]{1,32}$/.test(entry.username)) ||
        new Set(entries.map((entry) => entry.teamId)).size !== entries.length || new Set(usernames).size !== entries.length) fail('invalid_request');
      const token = { key: digest(`organizer-roster\n${rosterImport.id}`), fingerprint: digest(JSON.stringify(entries)) };
      const state = await transact((next) => {
        validateParticipants(next, current);
        if (alreadyApplied(next, token)) return null;
        const selected = new Set(entries.map((entry) => entry.teamId));
        if (Object.entries(next.bindings).some(([teamId, binding]) => !selected.has(teamId) && usernames.includes(binding.username))) fail('conflict', 409);
        const events = entries.map((entry) => applyAssignment(next, entry.teamId, entry.username));
        next.requests[token.key] = { fingerprint: token.fingerprint, action: 'assignment' };
        for (const event of events.slice(0, -1)) next.history.push({ ...event, id: randomId(), at: new Date(now()).toISOString() });
        return events.at(-1);
      });
      rosterStatus.status = 'applied'; rosterStatus.count = entries.length; rosterStatus.revision = state.revision;
    })().catch((error) => { rosterStatus.status = 'failed'; throw error; }).finally(() => { rosterPending = null; });
    return rosterPending;
  }
  const onlyAssignment = (entry) => Object.keys(entry).every((key) => ['teamId', 'username'].includes(key));

  function ensureChat(record, match, state) {
    if (record.chatClosed) return null;
    const participants = [match.team1.id, match.team2.id];
    const currentGenerations = generations(participants, state);
    if (!record.chat) {
      record.chat = { epoch: randomId(), participants, generations: currentGenerations, messages: [] };
      return 'chat_opened';
    }
    if (JSON.stringify(record.chat.generations) !== JSON.stringify(currentGenerations)) {
      record.chat.epoch = randomId();
      record.chat.generations = currentGenerations;
      return 'chat_reset';
    }
    return null;
  }

  return {
    rosterStatus: () => ({ ...rosterStatus }),
    readinessStatus: () => ({ ...readiness }),
    async captain(body) {
      validateInput(body);
      const user = verify(body.initData);
      readLimit(`user:${user.id}`);
      const writes = ['message', 'agree', 'result'].includes(body.action);
      if (writes) writeLimit(`user:${user.id}`);
      const token = writes ? requestToken(`user:${user.id}`, body) : null;
      const current = await getCatalog();
      await cleanupFromCatalog(current);
      let state = await transact((next) => {
        validateParticipants(next, current);
        const binding = currentBinding(next, user);
        if (!binding || !current.teamMap.has(binding[0])) {
          if (body.action === 'access') return null;
          fail('forbidden', 403);
        }
        const [teamId, assigned] = binding;
        // The first identity lock and operation commit together. Every retry
        // re-evaluates the current binding after any concurrent organizer edit.
        const linked = assigned.userId === null;
        const match = body.action === 'access' ? null : current.matchMap.get(body.matchId);
        if (body.action !== 'access') {
          if (!match) fail('not_found', 404);
          if (![match.team1.id, match.team2.id].includes(teamId)) fail('forbidden', 403);
          if (['message', 'agree'].includes(body.action) && (next.matches[match.id]?.chatClosed || match.status === 'completed')) fail('match_closed', 409);
        }
        if (linked) assigned.userId = user.id;
        if (body.action === 'access') return linked ? { kind: 'identity_linked', teamId,
          actorUserId: user.id, bindingGeneration: assigned.generation } : null;
        const record = next.matches[match.id] ||= emptyMatch();
        const chatChange = ensureChat(record, match, next);
        if (body.action === 'message' && body.expectedChatEpoch !== record.chat?.epoch) fail('chat_reset', 409);
        if (writes && alreadyApplied(next, token)) return chatChange ? { kind: chatChange, matchId: match.id } : null;
        const createdAt = new Date(now()).toISOString();
        let event = { kind: body.action, teamId, matchId: match.id,
          actorUserId: user.id, bindingGeneration: assigned.generation };
        if (body.action === 'match') return linked ? { kind: 'identity_linked', teamId,
          actorUserId: user.id, bindingGeneration: assigned.generation } : chatChange ? { kind: chatChange, matchId: match.id } : null;
        if (body.action === 'message') record.chat.messages.push({ id: token.key, teamId, text: body.text, createdAt });
        if (body.action === 'result') {
          const bestOf = /^BO(1|3|5)$/.exec(match.bestOf || '');
          if (!bestOf) fail('invalid_request');
          const target = (Number(bestOf[1]) + 1) / 2;
          if (Math.max(...body.score) !== target || Math.min(...body.score) >= target) fail('invalid_request');
          record.resultClaims.push({ id: token.key, teamId, score: body.score, comment: body.comment, createdAt });
        }
        if (body.action === 'agree') {
          if (body.expectedScheduleVersion !== record.scheduleVersion) fail('conflict', 409);
          if (!['scheduled', 'upcoming'].includes(match.status)) fail('match_closed', 409);
          if (!current.resultsAvailable) fail('storage_unavailable', 503);
          if (!match.window) fail('window_unavailable', 409);
          const startsAt = new Date(body.startsAt).toISOString();
          const start = Date.parse(startsAt);
          if (start < Date.parse(match.window.start) || start > Date.parse(match.window.end)) fail('outside_window', 409);
          if (start - now() < 2 * 60 * 60 * 1000) fail('too_late', 409);
          if (!record.proposal || record.proposal.startsAt !== startsAt) {
            record.proposal = { startsAt, confirmedTeamIds: [teamId] };
            record.scheduleVersion++;
          } else if (!record.proposal.confirmedTeamIds.includes(teamId)) {
            record.proposal.confirmedTeamIds.push(teamId);
            record.scheduleVersion++;
            if (record.proposal.confirmedTeamIds.length === 2) record.agreed = { startsAt, agreedAt: createdAt };
          }
          event = { ...event, startsAt, scheduleVersion: record.scheduleVersion, confirmedTeamIds: [...record.proposal.confirmedTeamIds] };
        }
        next.requests[token.key] = { fingerprint: token.fingerprint, action: body.action, matchId: match.id };
        return event;
      });
      // Recheck current rights/closure for the response after concurrent writes.
      if (body.action !== 'access') {
        state = await freshState();
        validateParticipants(state, current);
      }
      const binding = currentBinding(state, user);
      if (!binding || !current.teamMap.has(binding[0]) || binding[1].userId !== user.id) {
        if (body.action === 'access') return { authorized: false, team: null, matches: [] };
        fail('forbidden', 403);
      }
      const teamId = binding[0];
      if (body.action === 'access') return { authorized: true, team: current.teamMap.get(teamId),
        matches: current.matches.filter((match) => [match.team1.id, match.team2.id].includes(teamId))
          .map((match) => ({ ...match, scheduledAt: state.matches[match.id]?.agreed?.startsAt || match.scheduledAt })) };
      const match = current.matchMap.get(body.matchId);
      if (![match.team1.id, match.team2.id].includes(teamId)) fail('forbidden', 403);
      if (['message', 'agree'].includes(body.action) && state.matches[match.id]?.chatClosed) fail('match_closed', 409);
      return structuredClone(detail(state, match, teamId));
    },

    async organizer(body = null) {
      const current = await getCatalog();
      await cleanupFromCatalog(current);
      if (body === null) {
        const state = await freshState();
        validateParticipants(state, current);
        return organizerDTO(state, current);
      }
      writeLimit('organizer');
      checkKeys(body, ['requestId', 'expectedRevision', 'expectedBindingVersion', 'teamId', 'username']);
      if (!current.teamMap.has(body.teamId) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
        !(body.username === null || (typeof body.username === 'string' && /^@?[A-Za-z0-9_]{1,32}$/.test(body.username))) ||
        (own(body, 'expectedBindingVersion') && body.expectedBindingVersion !== null &&
          (typeof body.expectedBindingVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedBindingVersion)))) fail('invalid_request');
      const token = requestToken('organizer', body);
      const username = body.username?.replace(/^@/, '').toLowerCase() ?? null;
      const state = await transact((next) => {
        validateParticipants(next, current);
        if (alreadyApplied(next, token)) return null;
        if (own(body, 'expectedBindingVersion') ? body.expectedBindingVersion !== bindingVersion(next, body.teamId) : body.expectedRevision !== next.revision) fail('conflict', 409);
        if (username && Object.entries(next.bindings).some(([teamId, b]) => teamId !== body.teamId && b.username === username)) fail('conflict', 409);
        const event = applyAssignment(next, body.teamId, username);
        next.requests[token.key] = { fingerprint: token.fingerprint, action: 'assignment' };
        return event;
      });
      return structuredClone(organizerDTO(state, current));
    },
    async cleanup() {
      // Retention is independent of optional scheduling-window configuration.
      const current = catalog(await getTournament(), {});
      // Optional metadata cannot make retention depend on valid window config.
      let windowCount = null;
      try {
        const windows = parseWindows(env.YCS_CAPTAIN_WINDOWS_JSON);
        windowCount = current.matches.filter((match) => own(windows, match.id)).length;
      } catch { /* Invalid windows remain unknown; cleanup still runs. */ }
      observeCatalog(current, windowCount);
      await ensureRoster(current);
      const state = await cleanupFromCatalog(current);
      return { revision: state?.revision ?? null, closedMatchIds: state ? Object.entries(state.matches)
        .filter(([, record]) => record.chatClosed).map(([id]) => id) : [] };
    },
  };
}

export function captainErrorResponse(error) {
  return error instanceof CaptainError ? { status: error.status, body: { error: error.code } } :
    { status: 503, body: { error: 'storage_unavailable' } };
}

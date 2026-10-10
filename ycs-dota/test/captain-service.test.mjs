import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CaptainError, createTelegramVerifier } from '../backend/captain-auth.mjs';
import { createCaptainService, createCaptainTournamentSource } from '../backend/captain-service.mjs';
import { emptyCaptainState } from '../backend/captain-store.mjs';
import { createCaptainTestServer } from './helpers/captain-server.mjs';

const clock = Date.parse('2026-10-08T10:00:00Z');
const startsAt = '2026-10-10T17:00:00.000Z';
const window = { start: '2026-10-09T00:00:00Z', end: '2026-10-11T00:00:00Z' };
const tournament = { id: 'dota2-autumn-2026', participants: ['a', 'b', 'c', 'd'].map((id) => ({ teamId: id, displayName: id.toUpperCase() })),
  stages: [{ id: 'swiss', rounds: [{ label: 'Тур 1', matches: [
    { id: 'ab', team1Id: 'a', team2Id: 'b', status: 'scheduled', bestOf: 'BO1' },
    { id: 'cd', team1Id: 'c', team2Id: 'd', status: 'scheduled', bestOf: 'BO3' },
  ] }] }] };
function memoryStore() {
  let value = emptyCaptainState(), etag = null;
  return {
    async read() { return { value: structuredClone(value), etag }; },
    async compareAndSet(previous, next) {
      if (previous.etag !== etag) throw new CaptainError('storage_conflict', 409);
      value = structuredClone(next); etag = `"${value.revision}"`;
      return this.read();
    },
    corrupt(edit) { edit(value); },
  };
}
function setup(options = {}) {
  const store = options.store || memoryStore();
  let time = clock;
  const service = createCaptainService({ store, env: { YCS_CAPTAIN_WINDOWS_JSON: JSON.stringify({ ab: window, cd: window }), ...options.env },
    getTournament: async () => structuredClone(options.tournament || tournament), verify: JSON.parse, now: () => time, ...options });
  let seq = 0;
  return { service, store, advance: (ms) => { time += ms; },
    captain: async (id, username, input) => {
      const initData = JSON.stringify({ id: String(id), username });
      if (input.action === 'message' && input.expectedChatEpoch === undefined) input = { ...input,
        expectedChatEpoch: (await service.captain({ initData, action: 'match', matchId: input.matchId })).chatEpoch };
      return service.captain({ initData, ...input });
    },
    assign: async (teamId, username) => service.organizer({ requestId: `admin-${++seq}-request`, teamId, username,
      expectedRevision: (await service.organizer()).revision }),
  };
}
const rejectCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('first trusted login binds stable id; username transfer cannot inherit, revoke rechecks every request', async () => {
  const s = setup();
  assert.deepEqual(await s.captain(11, 'alpha', { action: 'access' }), { authorized: false, team: null, matches: [] });
  await s.assign('a', '@Alpha'); await s.assign('b', 'beta');
  assert.equal((await s.captain(11, 'alpha', { action: 'access' })).authorized, true);
  assert.equal((await s.captain(11, 'renamed', { action: 'access' })).team.id, 'a');
  assert.equal((await s.captain(12, 'alpha', { action: 'access' })).authorized, false);
  await rejectCode(s.captain(11, 'alpha', { action: 'match', matchId: 'cd' }), 'forbidden');
  await s.assign('a', 'replacement');
  await rejectCode(s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'old-cap-1', text: 'hello' }), 'forbidden');
  assert.equal((await s.captain(13, 'replacement', { action: 'access' })).team.id, 'a');
  const dto = await s.captain(13, 'replacement', { action: 'match', matchId: 'ab' });
  assert.ok(!JSON.stringify(dto).includes('userId'));
  assert.ok(!JSON.stringify(dto).includes('replacement'));
});

test('private history retains exact authors and binding generations after captain replacement without DTO leakage', async () => {
  const s = setup(); await s.assign('a', 'alpha');
  await s.captain(11, 'alpha', { action: 'access' });
  await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'audit-message', text: 'Встречаемся в субботу' });
  await s.captain(11, 'alpha', { action: 'agree', matchId: 'ab', requestId: 'audit-agree', expectedScheduleVersion: 0, startsAt });
  await s.captain(11, 'alpha', { action: 'result', matchId: 'ab', requestId: 'audit-result', score: [1, 0], comment: 'Заявка' });
  const oldGeneration = (await s.store.read()).value.bindings.a.generation;
  await s.assign('a', 'replacement');
  const access = await s.captain(13, 'replacement', { action: 'access' });
  const dto = await s.captain(13, 'replacement', { action: 'match', matchId: 'ab' });
  const adminDTO = await s.service.organizer();
  const privateState = (await s.store.read()).value;
  const authored = privateState.history.filter((event) => event.actorUserId === '11');
  assert.deepEqual(authored.map((event) => event.kind), ['identity_linked', 'message', 'agree', 'result']);
  assert.ok(authored.every((event) => event.bindingGeneration === oldGeneration));
  assert.notEqual(privateState.bindings.a.generation, oldGeneration);
  const replaced = privateState.history.find((event) => event.kind === 'captain_assigned' && event.previousGeneration === oldGeneration);
  assert.equal(replaced.nextGeneration, privateState.bindings.a.generation);
  assert.equal(privateState.history.at(-1).actorUserId, '13');
  assert.equal(dto.messages.length, 1); assert.equal(dto.resultClaims.length, 1);
  for (const visible of [access, dto, adminDTO]) {
    const serialized = JSON.stringify(visible);
    assert.ok(!serialized.includes('actorUserId'));
    assert.ok(!serialized.includes('bindingGeneration'));
    assert.ok(!serialized.includes(oldGeneration));
    assert.ok(!serialized.includes(privateState.bindings.a.generation));
  }
});

test('two teams confirm same version; stale request conflicts, changed time resets consent, previous agreement stays', async () => {
  const s = setup(); await s.assign('a', 'alpha'); await s.assign('b', 'beta');
  const agree = (id, username, version, requestId, start = startsAt) => s.captain(id, username,
    { action: 'agree', matchId: 'ab', requestId, expectedScheduleVersion: version, startsAt: start });
  const first = await agree(11, 'alpha', 0, 'alpha-first');
  assert.deepEqual(first.proposal.confirmedTeamIds, ['a']); assert.equal(first.agreed, null);
  await rejectCode(agree(22, 'beta', 0, 'beta-stale'), 'conflict');
  const second = await agree(22, 'beta', 1, 'beta-final');
  assert.equal(second.agreed.startsAt, startsAt); assert.equal(second.scheduleVersion, 2);
  const later = '2026-10-10T18:00:00Z';
  const changed = await agree(11, 'alpha', 2, 'alpha-reschedule', later);
  assert.deepEqual(changed.proposal.confirmedTeamIds, ['a']); assert.equal(changed.agreed.startsAt, startsAt);
  await s.assign('a', null);
  const after = await s.captain(22, 'beta', { action: 'match', matchId: 'ab' });
  assert.equal(after.proposal, null); assert.equal(after.scheduleVersion, 4); assert.equal(after.agreed.startsAt, startsAt);
});

test('idempotent messages and claims retain ids; mismatching reused id rejects and official source is untouched', async () => {
  const source = structuredClone(tournament), before = JSON.stringify(source);
  const s = setup({ tournament: source }); await s.assign('a', 'alpha');
  const message = { action: 'message', matchId: 'ab', requestId: 'same-msg-id', text: '<b>Текст</b>' };
  await s.captain(11, 'alpha', message); await s.captain(11, 'alpha', message);
  await rejectCode(s.captain(11, 'alpha', { ...message, text: 'other' }), 'idempotency_conflict');
  await rejectCode(s.captain(11, 'alpha', { action: 'result', matchId: 'ab', requestId: 'bad-result', score: [0, 0], comment: '' }), 'invalid_request');
  const result = { action: 'result', matchId: 'ab', requestId: 'result-id', score: [1, 0], comment: 'Заявка' };
  await s.captain(11, 'alpha', result);
  const detail = await s.captain(11, 'alpha', result);
  assert.equal(detail.messages.length, 1); assert.equal(detail.resultClaims.length, 1);
  assert.equal(detail.match.status, 'scheduled'); assert.equal(JSON.stringify(source), before);
});

test('read preserves full chat; messages and receipts are durable until official finish, organizer has no chat', async () => {
  const s = setup(); await s.assign('a', 'alpha'); await s.captain(11, 'alpha', { action: 'access' });
  const expectedChatEpoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  const message = { action: 'message', matchId: 'ab', requestId: 'stored-until-end', expectedChatEpoch, text: 'Сохраняем переписку до конца матча' };
  const sent = await s.captain(11, 'alpha', message); await s.captain(11, 'alpha', message);
  assert.equal(sent.messages.length, 1);
  const beforeRead = await s.store.read();
  await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.deepEqual(await s.store.read(), beforeRead, 'reading messages is not an acknowledgement or deletion');
  const stored = JSON.stringify((await s.store.read()).value);
  assert.ok(stored.includes(message.text)); assert.ok(stored.includes(sent.messages[0].id));
  const receipt = beforeRead.value.requests[sent.messages[0].id];
  assert.equal(receipt.action, 'message'); assert.equal(receipt.matchId, 'ab');
  const organizer = await s.service.organizer();
  assert.ok(organizer.matches.every((match) => match.messages.length === 0 && match.chatEpoch === null));
  await rejectCode(s.service.captain({ initData: JSON.stringify({ id: '11', username: 'alpha' }),
    action: 'message', matchId: 'ab', requestId: 'epoch-required', text: 'Must not send without epoch' }), 'invalid_request');
});

test('week, restart and captain replacement retain conversation; replaced epoch rejects old sends', async () => {
  const s = setup(); await s.assign('a', 'alpha'); await s.assign('b', 'beta');
  await s.captain(11, 'alpha', { action: 'agree', matchId: 'ab', requestId: 'retained-agree-a', expectedScheduleVersion: 0, startsAt });
  await s.captain(22, 'beta', { action: 'agree', matchId: 'ab', requestId: 'retained-agree-b', expectedScheduleVersion: 1, startsAt });
  const expectedChatEpoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  const message = { action: 'message', matchId: 'ab', requestId: 'retained-restart', expectedChatEpoch, text: 'До официального окончания' };
  await s.captain(11, 'alpha', message);
  const restarted = setup({ store: s.store });
  await restarted.captain(11, 'alpha', message);
  const afterRestart = await restarted.captain(22, 'beta', { action: 'match', matchId: 'ab' });
  assert.equal(afterRestart.messages.length, 1); assert.equal(afterRestart.agreed.startsAt, startsAt);
  s.advance(7 * 24 * 60 * 60 * 1000);
  await s.captain(11, 'alpha', message);
  const current = await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.equal(current.messages.length, 1); assert.equal(current.chatEpoch, expectedChatEpoch);
  await s.assign('a', 'replacement');
  const replaced = await s.captain(22, 'beta', { action: 'match', matchId: 'ab' });
  assert.equal(replaced.messages.length, 1); assert.equal(replaced.agreed.startsAt, startsAt);
  assert.notEqual(replaced.chatEpoch, current.chatEpoch);
  await rejectCode(s.captain(11, 'alpha', message), 'forbidden');
  await rejectCode(s.captain(22, 'beta', { ...message, requestId: 'opponent-stale' }), 'chat_reset');
  assert.equal((await s.captain(13, 'replacement', { action: 'match', matchId: 'ab' })).messages[0].text, message.text);
});

test('concurrent posts survive CAS retries, concurrent different proposals cannot erase confirmation', async () => {
  const s = setup(); await s.assign('a', 'alpha'); await s.assign('b', 'beta');
  await Promise.all([s.captain(11, 'alpha', { action: 'access' }), s.captain(22, 'beta', { action: 'access' })]);
  const message = (id, username, text) => s.captain(id, username, { action: 'message', matchId: 'ab', requestId: `request-${text}`, text });
  await Promise.all([message(11, 'alpha', 'first'), message(22, 'beta', 'second')]);
  const outcomes = await Promise.allSettled([
    s.captain(11, 'alpha', { action: 'agree', matchId: 'ab', requestId: 'concur-one', expectedScheduleVersion: 0, startsAt }),
    s.captain(22, 'beta', { action: 'agree', matchId: 'ab', requestId: 'concur-two', expectedScheduleVersion: 0, startsAt: '2026-10-10T19:00:00Z' }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code, 'conflict');
  const detail = await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.deepEqual(detail.messages.map((m) => m.text).sort(), ['first', 'second']);
  assert.equal(detail.proposal.confirmedTeamIds.length, 1); assert.equal(detail.agreed, null);
});

test('official finish purges only that match chat, receipts and message audit while retaining agreement/claims/registry', async () => {
  const source = structuredClone(tournament), s = setup({ tournament: source });
  await s.assign('a', 'alpha'); await s.assign('b', 'beta'); await s.assign('c', 'gamma');
  const agree = { action: 'agree', matchId: 'ab', requestId: 'close-agree-a', expectedScheduleVersion: 0, startsAt };
  await s.captain(11, 'alpha', agree);
  await s.captain(22, 'beta', { ...agree, requestId: 'close-agree-b', expectedScheduleVersion: 1 });
  const epoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  const post = { action: 'message', matchId: 'ab', requestId: 'delete-this-message', expectedChatEpoch: epoch, text: 'PRIVATE-AB-CHAT-TO-DELETE' };
  const sent = await s.captain(11, 'alpha', post), messageId = sent.messages[0].id;
  const before = await s.store.read(), fingerprint = before.value.requests[messageId].fingerprint;
  await s.captain(33, 'gamma', { action: 'message', matchId: 'cd', requestId: 'retain-other-chat', text: 'OTHER-MATCH-CHAT' });
  await s.captain(11, 'alpha', { action: 'result', matchId: 'ab', requestId: 'retained-claim', score: [1, 0], comment: 'Заявка не завершает матч' });
  await s.service.cleanup();
  assert.equal((await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).messages.length, 1, 'captain claim is not official completion');
  source.stages[0].rounds[0].matches[0].resultConfirmed = true;
  const completed = await s.service.cleanup(); assert.ok(completed.closedMatchIds.includes('ab'));
  const saved = await s.store.read(), serialized = JSON.stringify(saved.value);
  assert.equal(saved.value.matches.ab.chatClosed, true); assert.equal(saved.value.matches.ab.chat, null);
  assert.ok(!serialized.includes(post.text)); assert.ok(!serialized.includes(messageId)); assert.ok(!serialized.includes(fingerprint));
  assert.ok(!saved.value.history.some((event) => event.matchId === 'ab' && ['message', 'chat_opened', 'chat_reset'].includes(event.kind)));
  assert.equal(saved.value.matches.ab.agreed.startsAt, startsAt); assert.equal(saved.value.matches.ab.resultClaims.length, 1);
  assert.equal(saved.value.bindings.a.username, 'alpha'); assert.equal(saved.value.matches.cd.chat.messages[0].text, 'OTHER-MATCH-CHAT');
  await s.service.cleanup(); assert.deepEqual(await s.store.read(), saved, 'cleanup is idempotent');
  await rejectCode(s.captain(11, 'alpha', post), 'match_closed');
  await rejectCode(s.captain(11, 'alpha', agree), 'match_closed');
  source.stages[0].rounds[0].matches[0].resultConfirmed = false;
  const stale = await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.deepEqual(stale.messages, []); assert.equal(stale.chatEpoch, null); assert.equal(stale.chatClosed, true);
  await rejectCode(s.captain(11, 'alpha', { ...post, requestId: 'new-after-finish' }), 'match_closed');
});

test('finish discovered by a request purges before response; no clock, failed source or reading causes deletion', async () => {
  const source = structuredClone(tournament); let unavailable = false;
  const s = setup({ getTournament: async () => { if (unavailable) throw new Error('source unavailable'); return structuredClone(source); } });
  await s.assign('a', 'alpha');
  await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'read-retains-post', text: 'Read does not acknowledge' });
  const before = await s.store.read(); s.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal((await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).messages.length, 1);
  unavailable = true; await assert.rejects(s.service.cleanup()); assert.deepEqual(await s.store.read(), before);
  unavailable = false; source.stages[0].rounds[0].matches[0].status = 'completed';
  const closed = await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.equal(closed.chatClosed, true); assert.deepEqual(closed.messages, []);
  assert.equal((await s.store.read()).value.matches.ab.chat, null);
});

test('cleanup still removes completed chat when scheduling windows are misconfigured', async () => {
  const source = structuredClone(tournament), s = setup({ tournament: source }); await s.assign('a', 'alpha');
  await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'cleanup-bad-window', text: 'Delete after official finish' });
  source.stages[0].rounds[0].matches[0].status = 'completed';
  const brokenWindows = setup({ store: s.store, tournament: source, env: { YCS_CAPTAIN_WINDOWS_JSON: '{invalid' } });
  await brokenWindows.service.cleanup();
  assert.equal((await s.store.read()).value.matches.ab.chatClosed, true);
  assert.equal((await s.store.read()).value.matches.ab.chat, null);
});

test('concurrent official cleanup wins against a pending message CAS and prevents resurrection', async () => {
  const source = structuredClone(tournament), base = memoryStore(); let release, reached, hold = false;
  const barrier = new Promise((resolve) => { reached = resolve; });
  const store = { read: () => base.read(), compareAndSet: async (previous, next, id) => {
    if (hold && next.history.at(-1).kind === 'message') { hold = false; reached(); await new Promise((resolve) => { release = resolve; }); }
    return base.compareAndSet(previous, next, id);
  } };
  const s = setup({ store, tournament: source }); await s.assign('a', 'alpha');
  const expectedChatEpoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  hold = true;
  const pending = s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'racing-finish', expectedChatEpoch, text: 'Must not resurrect' });
  await barrier; source.stages[0].rounds[0].matches[0].status = 'completed'; await s.service.cleanup(); release();
  await rejectCode(pending, 'match_closed');
  const final = (await base.read()).value;
  assert.equal(final.matches.ab.chatClosed, true); assert.equal(final.matches.ab.chat, null);
  assert.ok(!JSON.stringify(final).includes('Must not resurrect'));
});

test('more than100 messages are retained without silent eviction', async () => {
  const s = setup(); await s.assign('a', 'alpha');
  const expectedChatEpoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  for (let i = 0; i < 105; i++) {
    if (i % 25 === 0) s.advance(61_000);
    await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: `keep-message-${i}`, expectedChatEpoch, text: `Message ${i}` });
  }
  const all = await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' });
  assert.equal(all.messages.length, 105); assert.equal(all.messages[0].text, 'Message 0'); assert.equal(all.messages[104].text, 'Message 104');
});

test('revocation wins delayed registry read for message; stale snapshot cannot restore old access', async () => {
  const base = memoryStore(); let release, reached;
  const barrier = new Promise((resolve) => { reached = resolve; });
  let hold = false;
  const store = { read: async () => {
    const snapshot = await base.read();
    if (hold) {
      hold = false; reached(); await new Promise((resolve) => { release = resolve; });
    }
    return snapshot;
  }, compareAndSet: (previous, next, id) => base.compareAndSet(previous, next, id) };
  const s = setup({ store }); await s.assign('a', 'alpha'); await s.captain(11, 'alpha', { action: 'access' });
  const expectedChatEpoch = (await s.captain(11, 'alpha', { action: 'match', matchId: 'ab' })).chatEpoch;
  hold = true;
  const post = s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'racing-message', text: 'must not commit', expectedChatEpoch });
  await barrier; await s.assign('a', null); release();
  await rejectCode(post, 'forbidden');
  assert.equal((await s.service.organizer()).matches[0].messages.length, 0);
});

test('unknown windows block only agree; exact 2h deadline passes, missing freshness and late/outside/invalid dates fail', async () => {
  const s = setup({ env: {} }); await s.assign('a', 'alpha');
  const agree = { action: 'agree', matchId: 'ab', requestId: 'window-req', expectedScheduleVersion: 0, startsAt };
  await rejectCode(s.captain(11, 'alpha', agree), 'window_unavailable');
  assert.equal((await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'message-windows', text: 'When?' })).messages.length, 1);
  const exact = setup({ env: { YCS_CAPTAIN_WINDOWS_JSON: JSON.stringify({ ab: { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z' } }) } });
  await exact.assign('a', 'alpha'); await exact.assign('b', 'beta');
  const proposal = { ...agree, startsAt: '2026-10-08T12:00:00Z' };
  await exact.captain(11, 'alpha', proposal);
  exact.advance(1);
  await rejectCode(exact.captain(22, 'beta', { ...proposal, expectedScheduleVersion: 1, requestId: 'late-confirm' }), 'too_late');
  await rejectCode(exact.captain(11, 'alpha', { ...agree, expectedScheduleVersion: 1, requestId: 'outside-req' }), 'outside_window');
  await rejectCode(exact.captain(11, 'alpha', { ...agree, startsAt: '2026-02-31T12:00:00Z' }), 'invalid_request');
  const unknown = setup({ tournament: { ...tournament, captainResultsAvailable: false } }); await unknown.assign('a', 'alpha');
  await rejectCode(unknown.captain(11, 'alpha', agree), 'storage_unavailable');
});

test('username uniqueness, corrupt state and per-user write limits fail without losing history', async () => {
  const s = setup(); await s.assign('a', 'alpha');
  await rejectCode(s.assign('b', '@ALPHA'), 'conflict');
  for (let i = 0; i < 30; i++) await s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: `message-${i}`, text: 'x' });
  await rejectCode(s.captain(11, 'alpha', { action: 'message', matchId: 'ab', requestId: 'message-final', text: 'x' }), 'too_many_requests');
  s.store.corrupt((state) => { state.matches.ab.proposal = { startsAt, confirmedTeamIds: ['a', 'c'] }; });
  await rejectCode(s.captain(11, 'alpha', { action: 'match', matchId: 'ab' }), 'storage_unavailable');
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
function signedInit({ bot = '12345', user = { id: 123, username: 'alpha' }, authDate = clock / 1000 } = {}) {
  const params = new URLSearchParams({ user: JSON.stringify(user), auth_date: String(authDate), query_id: 'signed-test' });
  const data = `${bot}:WebAppData\n${[...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')}`;
  params.set('signature', sign(null, Buffer.from(data), privateKey).toString('base64url')); params.set('hash', 'ignored-third-party-hash');
  return params.toString();
}
test('Telegram Ed25519 verification binds bot, timestamp and user; tampering/duplicates/expired data fail', () => {
  const verify = createTelegramVerifier({ botId: '12345', now: () => clock, publicKey });
  assert.deepEqual(verify(signedInit()), { id: '123', username: 'alpha' });
  const rejects = (input) => assert.throws(() => verify(input), (e) => e.code === 'unauthorized');
  rejects(signedInit({ bot: '54321' }));
  rejects(signedInit({ authDate: clock / 1000 - 3601 }));
  rejects(signedInit({ authDate: clock / 1000 + 31 }));
  rejects(signedInit().replace('alpha', 'other'));
  rejects(`${signedInit()}&auth_date=${clock / 1000}`);
  rejects(signedInit({ user: { id: 0, username: 'alpha' } }));
  rejects(signedInit({ user: { id: 2 ** 54, username: 'alpha' } }));
  assert.throws(() => createTelegramVerifier({})('anything'), (e) => e.code === 'captain_not_configured');
});

test('HTTP shares captain registry with authenticated organizer; private answers and failed auth never expose it', async () => {
  const s = setup({ verify: createTelegramVerifier({ botId: '12345', now: () => clock, publicKey }) });
  const server = createCaptainTestServer({ env: { YCS_ORGS_LOGIN: 'organizer', YCS_ORGS_PASSWORD: 'test-password' }, captainService: s.service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/orgs/captains')).status, 401);
    const { token } = await (await post('/api/orgs/login', { login: 'organizer', password: 'test-password' })).json();
    const admin = { Authorization: `Bearer ${token}` };
    const saved = await post('/api/orgs/captains', { requestId: 'http-admin-request', expectedRevision: 0, teamId: 'a', username: 'alpha' }, admin);
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    const denied = await post('/api/captain', { action: 'access', initData: signedInit().replace('alpha', 'other') });
    assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'unauthorized' });
    const access = await post('/api/captain', { action: 'access', initData: signedInit() });
    assert.equal(access.status, 200); assert.equal((await access.json()).team.id, 'a');
    assert.equal((await post('/api/captain', { action: 'access', initData: signedInit() }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post('/api/orgs/captains', null, admin)).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('actual tournament identifiers load; known result absence is valid baseline, failure suppresses new agreement', async () => {
  const baseline = JSON.parse(await readFile(new URL('../src/data/tournaments/dota2-autumn-2026.json', import.meta.url), 'utf8'));
  const source = createCaptainTournamentSource({ load: async () => baseline, readSnapshot: async () => null });
  const loaded = await source(); assert.equal(loaded.captainResultsAvailable, true);
  const failed = await createCaptainTournamentSource({ load: async () => baseline, readSnapshot: async () => { throw new Error('offline'); } })();
  assert.equal(failed.captainResultsAvailable, false);
  const s = setup({ tournament: loaded });
  const data = await s.service.organizer();
  assert.equal(data.teams.length, 16); assert.equal(data.matches.length, 8);
  assert.equal(data.matches.find((m) => m.match.id === 'dota-autumn-swiss-r1-04').match.team2.id, 'dota2-qual-2026-arb-esports');
});

test('organizer target versions allow unrelated writes but reject replaced and revoked assignments', async () => {
  const s = setup();
  const empty = await s.service.organizer();
  await s.assign('b', 'beta');
  const saved = await s.service.organizer({ requestId: 'target-version-write', expectedRevision: empty.revision,
    expectedBindingVersion: empty.bindingVersions.a, teamId: 'a', username: 'alpha' });
  await s.assign('a', null);
  await rejectCode(s.service.organizer({ requestId: 'target-stale-write', expectedRevision: saved.revision,
    expectedBindingVersion: saved.bindingVersions.a, teamId: 'a', username: 'replacement' }), 'conflict');
  await rejectCode(s.service.organizer({ requestId: 'target-absent-aba', expectedRevision: empty.revision,
    expectedBindingVersion: null, teamId: 'a', username: 'stale' }), 'conflict');
  const revoked = await s.service.organizer();
  assert.match(revoked.bindingVersions.a, /^[a-f0-9]{64}$/);
  await s.service.organizer({ requestId: 'target-current-write', expectedRevision: revoked.revision,
    expectedBindingVersion: revoked.bindingVersions.a, teamId: 'a', username: 'current' });
});

test('approved roster import is atomic, once-only, and preserves later revocations after restart', async () => {
  const { captainRosterImport } = await import('../backend/captain-roster-import.mjs');
  const actual = JSON.parse(await readFile(new URL('../src/data/tournaments/dota2-autumn-2026.json', import.meta.url), 'utf8'));
  // Roster-import idempotency is tested before sports-result reconciliation.
  for (const stage of actual.stages) for (const round of stage.rounds || []) for (const fixture of round.matches || []) {
    fixture.status = 'scheduled'; fixture.resultConfirmed = false;
  }
  const store = memoryStore();
  const start = () => createCaptainService({ store, env: {}, now: () => clock, verify: JSON.parse,
    getTournament: async () => actual, rosterImport: captainRosterImport });
  const service = start();
  const dto = await service.organizer();
  assert.equal(dto.bindings.length, 16);
  for (const entry of captainRosterImport.assignments) assert.equal(dto.bindings.find(b => b.teamId === entry.teamId)?.username, entry.username);
  assert.deepEqual(service.rosterStatus(), { id: captainRosterImport.id, status: 'applied', count: 16, revision: 1 });
  const teamId = captainRosterImport.assignments[0].teamId;
  await service.organizer({ requestId: 'after-import-revoke', expectedRevision: dto.revision,
    expectedBindingVersion: dto.bindingVersions[teamId], teamId, username: null });
  const next = await start().organizer();
  assert.equal(next.revision, 2);
  assert.equal(next.bindings.some(b => b.teamId === teamId), false);
  assert.equal((await store.read()).value.history.filter(e => e.kind === 'captain_assigned').length, 16);
});

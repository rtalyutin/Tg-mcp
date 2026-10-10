import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDotaMap, scoreMvpMetrics, mvpContributions, buildMvpSnapshot, validateMvpSnapshot, validateMvpEstimates,
  topMvpPlayers, formatMvpScore, steamIdFromAccount } from '../src/lib/dota-mvp.js';

const heroes = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, `npc_dota_hero_test_${index + 1}`]));
const teams = { radiant: { id: 'alpha', name: 'Alpha' }, dire: { id: 'beta', name: 'Beta' } };
const snapshotOptions = { tournamentId: 'test-dota', leagueId: 19021, revision: 1, updatedAt: '2026-10-03T06:00:00Z' };
const tournament = { id: 'test-dota', leagueId: 19021 };
const zero = { K: 0, A: 0, L: 0, D: 0, T: 0, H: 0, C: '0', V: 0, S: 0 };
function map(id = 1) {
  return { match_id: id, version: 22, duration: 600, pre_game_duration: 90, leagueid: 19021,
    players: Array.from({ length: 10 }, (_, index) => ({ account_id: index + 1, hero_id: index + 1,
      player_slot: index < 5 ? index : index + 123, personaname: `API ${index + 1}`, kills: 0, assists: 0, deaths: 0,
      damage_targets: {}, damage: {}, healing: {}, stuns: 0, obs_left_log: [], camps_stacked: 0 })) };
}
const score = (value, options = {}) => scoreDotaMap(value, { heroNames: heroes, sideTeamIds: teams, fixtureId: 'fixture-1', ...options });

test('hand worked §9.4 example: 4+1.5+2+0.1+0.5+1/3 = 253/30', () => {
  const metrics = { K: 6, A: 9, L: 3, D: 1500, T: 750, H: 1000, C: '1.5', V: 1, S: 2 };
  assert.deepEqual(scoreMvpMetrics(metrics), { numerator: '253', denominator: '30' });
  assert.deepEqual(mvpContributions(metrics).control, { numerator: '1', denominator: '10' });
  assert.equal(formatMvpScore(scoreMvpMetrics(metrics)), '8.43');
  assert.deepEqual(scoreMvpMetrics({ ...zero, L: 1 }), { numerator: '-1', denominator: '3' });
  assert.equal(formatMvpScore({ numerator: '-1', denominator: '3' }), '-0.33');
});

test('exact arithmetic distinguishes decimal values below floating epsilon and rounds only display', () => {
  const first = scoreMvpMetrics({ ...zero, C: '1.0000000000000000001' });
  const second = scoreMvpMetrics({ ...zero, C: '1' });
  assert.notDeepEqual(first, second);
  assert.equal(formatMvpScore(first), formatMvpScore(second));
  const players = [first, second].map((ratingExact, index) => ({ accountId: String(index + 1), countedMaps: 1, ratingExact }));
  assert.deepEqual(topMvpPlayers(players, 1).map((player) => player.accountId), ['1']);
  assert.deepEqual(scoreMvpMetrics({ ...zero, C: '1e-3' }), { numerator: '1', denominator: '15000' });
});

test('damage includes null attacks to exact enemies; buildings exclude own side; healing excludes self and enemies', () => {
  const raw = map();
  Object.assign(raw.players[0], { kills: 6, assists: 9, deaths: 3,
    damage_targets: { null: { [heroes[6]]: 1000, [`${heroes[6]}_illusion`]: 5000, npc_dota_creep: 9000 },
      spell: { [heroes[7]]: 500, [heroes[1]]: 2000 } },
    hero_damage: 100000, tower_damage: 100000,
    damage: { npc_dota_badguys_tower2_top: 450, npc_dota_badguys_tower4: 50, npc_dota_badguys_melee_rax_top: 100,
      npc_dota_badguys_range_rax_mid: 100, npc_dota_badguys_fort: 50, npc_dota_goodguys_fort: 9999 },
    healing: { [heroes[2]]: 500, [heroes[3]]: 500, [heroes[1]]: 10000, [heroes[6]]: 5000,
      [`${heroes[2]}_illusion`]: 9999 }, stuns: 1.5, camps_stacked: 2 });
  raw.players[5].obs_left_log = [{ time: 40, slot: 5, player_slot: 128, attackername: heroes[1], ehandle: 88 }];
  const result = score(raw);
  assert.equal(result.status, 'ready', result.reason);
  assert.deepEqual(result.players[0].metrics, { K: 6, A: 9, L: 3, D: 1500, T: 750, H: 1000, C: '1.5', V: 1, S: 2 });
  assert.deepEqual(result.players[0].scoreExact, { numerator: '253', denominator: '30' });
});

test('observer counts use owner, enemy attacker, time and entity identity; expiration/denies/duplicates excluded', () => {
  const raw = map();
  raw.players[5].obs_left_log = [
    { time: 40, slot: 5, player_slot: 128, attackername: heroes[1], ehandle: 88 },
    { time: 40, slot: 5, player_slot: 128, attackername: heroes[1], ehandle: 88 },
    { time: 50, slot: 5, player_slot: 128, attackername: heroes[6], ehandle: 89 },
    { time: 60, slot: 5, player_slot: 128, ehandle: 90 },
    { time: -91, attackername: heroes[1], ehandle: 91 },
    { time: 601, attackername: heroes[1], ehandle: 92 },
    { time: 600, slot: 5, player_slot: 128, attackername: heroes[1], key: '[100,120]' },
    { time: 600, slot: 5, player_slot: 128, attackername: heroes[1], key: '[100,120]' },
  ];
  const result = score(raw);
  assert.equal(result.status, 'ready', result.reason);
  assert.equal(result.players[0].metrics.V, 2);
  assert.equal(result.players[5].metrics.V, 0);
});

test('confirmed prehorn ward kills inside the actual pregame window count; unknown bounds remain pending', () => {
  const raw = map();
  raw.players[5].obs_left_log = [{ time: -40, slot: 5, player_slot: 128, attackername: heroes[1], ehandle: 99 }];
  assert.equal(score(raw).players[0].metrics.V, 1);
  delete raw.pre_game_duration;
  assert.equal(score(raw).status, 'pending');
  assert.match(score(raw).reason, /pregame time bound/);
});

test('missing data, duplicate slots/accounts and unknown heroes leave the whole map pending', () => {
  for (const mutate of [
    (raw) => delete raw.players[1].healing,
    (raw) => delete raw.players[9].obs_left_log,
    (raw) => { raw.players[1].player_slot = 0; },
    (raw) => { raw.players[1].account_id = 1; },
    (raw) => { raw.players[1].account_id = null; },
    (raw) => { raw.players[1].hero_id = 0; },
    (raw) => { raw.players[1].hero_id = 1; },
    (raw) => { raw.players[1].stuns = null; },
    (raw) => { raw.version = null; },
    (raw) => { raw.players[5].obs_left_log = [{ time: 40, attackername: heroes[1] }]; },
  ]) {
    const raw = map(); mutate(raw);
    const result = score(raw);
    assert.equal(result.status, 'pending');
    assert.ok(result.reason);
    assert.ok(result.players.every((player) => !('scoreExact' in player) && !('metrics' in player)));
    assert.equal(buildMvpSnapshot([result], snapshotOptions).players.every((player) => player.countedMaps === 0), true);
  }
  assert.equal(score(map()).status, 'ready', 'present empty parsed collections are valid zeros');
});

test('conflicting observer owner or entity destruction is pending rather than silently dropped', () => {
  const raw = map();
  raw.players[5].obs_left_log = [{ time: 40, slot: 6, player_slot: 128, attackername: heroes[1], ehandle: 88 }];
  assert.match(score(raw).reason, /owner/);
  raw.players[5].obs_left_log[0].slot = 5;
  raw.players[5].obs_left_log.push({ ...raw.players[5].obs_left_log[0], attackername: heroes[2] });
  assert.match(score(raw).reason, /Conflicting/);
});

test('team roster Steam identity wins, unmatched account uses fetched nickname, substitutes aggregate across teams', () => {
  const rosterIdentities = [{ teamId: 'alpha', steamId: steamIdFromAccount(1), nickname: 'Roster nick' },
    { teamId: 'beta', accountId: '2', nickname: 'Wrong team nick' }];
  const first = score(map(1), { rosterIdentities, playerNicknames: { 2: { personaname: 'Fetched nick' } } });
  assert.equal(first.players[0].nickname, 'Roster nick');
  assert.equal(first.players[1].nickname, 'Fetched nick');
  const swapped = { radiant: teams.dire, dire: teams.radiant };
  const second = score(map(2), { sideTeamIds: swapped });
  const snapshot = buildMvpSnapshot([first, second, second], snapshotOptions);
  const player = snapshot.players.find((entry) => entry.accountId === '1');
  assert.equal(player.countedMaps, 2);
  assert.equal(player.playedMaps, 2);
  assert.deepEqual(player.teamIds, ['alpha', 'beta']);
  assert.equal(player.records.length, 2, 'repeated import is idempotent');
  validateMvpSnapshot(snapshot, tournament);
});

test('negative map scores remain in tournament totals; explicit exclusion affects all ten', () => {
  const firstRaw = map(1); firstRaw.players[0].kills = 3;
  const secondRaw = map(2); secondRaw.players[0].deaths = 6;
  const excluded = score(map(3), { excludedReason: 'Replay loss confirmed by organiser' });
  const pendingRaw = map(4); delete pendingRaw.players[1].healing;
  const snapshot = buildMvpSnapshot([score(firstRaw), score(secondRaw), excluded, score(pendingRaw)], snapshotOptions);
  const player = snapshot.players.find((entry) => entry.accountId === '1');
  assert.deepEqual(player.ratingExact, { numerator: '-1', denominator: '1' });
  assert.equal(player.countedMaps, 2); assert.equal(player.playedMaps, 4);
  assert.equal(snapshot.maps['3'].status, 'excluded'); assert.equal(snapshot.maps['4'].status, 'pending');
  assert.equal(player.rank, 10);
  validateMvpSnapshot(snapshot, tournament);
});

test('confirmed unrecoverable maps are excluded even when identities cannot be recovered; invalid IDs cannot be excluded', () => {
  const excludedReason = 'Organiser confirmed unrecoverable player identities';
  const anonymous = map(1); anonymous.players[0].account_id = null;
  assert.equal(score(anonymous).status, 'pending', 'missing identity alone is not an exclusion decision');
  const excludedAnonymous = score(anonymous, { excludedReason });
  assert.equal(excludedAnonymous.status, 'excluded');
  assert.equal(excludedAnonymous.reason, excludedReason);
  assert.ok(excludedAnonymous.players.every((player) => player.accountId && !player.metrics && !player.scoreExact));
  const absentPlayers = score({ match_id: 2 }, { excludedReason });
  assert.equal(absentPlayers.status, 'excluded');
  assert.deepEqual(absentPlayers.players, [], 'unrecoverable identities must never be invented');
  const snapshot = buildMvpSnapshot([excludedAnonymous, absentPlayers], snapshotOptions);
  assert.equal(snapshot.maps['1'].status, 'excluded');
  assert.equal(snapshot.maps['2'].status, 'excluded');
  assert.equal(snapshot.players.length, 0);
  validateMvpSnapshot(snapshot, tournament);
  for (const match_id of [undefined, null, 0, 'bad-id']) {
    assert.equal(score({ match_id }, { excludedReason }).status, 'pending', 'an invalid match cannot become a confirmed exclusion');
  }
});

test('top20 includes every exact cutoff tie, ignores uncounted players, competition ranks preserve ties', () => {
  const players = Array.from({ length: 25 }, (_, index) => ({ accountId: String(index + 1), countedMaps: 1,
    ratingExact: { numerator: String(index < 19 ? 100 - index : 1), denominator: '1' } }));
  players.push({ accountId: '999', countedMaps: 0, ratingExact: { numerator: '0', denominator: '1' } });
  const top = topMvpPlayers(players);
  assert.equal(top.length, 25); assert.equal(top[19].rank, 20); assert.equal(top[24].rank, 20);
});

test('snapshot validation independently recomputes metrics, aggregate, membership and rank', () => {
  const original = buildMvpSnapshot([score(map())], snapshotOptions);
  validateMvpSnapshot(original, tournament);
  for (const mutate of [
    (snapshot) => { snapshot.players[0].ratingExact = { numerator: '1', denominator: '1' }; },
    (snapshot) => { snapshot.players[0].records[0].scoreExact = { numerator: '1', denominator: '1' }; },
    (snapshot) => { snapshot.players[0].rank = 2; },
    (snapshot) => { snapshot.players.pop(); },
    (snapshot) => { snapshot.maps['1'].status = 'excluded'; snapshot.maps['1'].reason = 'Lost'; },
    (snapshot) => { snapshot.players[0].records.push(snapshot.players[0].records[0]); snapshot.players[0].countedMaps++; },
    (snapshot) => { snapshot.players[0].steamId = steamIdFromAccount(2); },
    (snapshot) => { snapshot.players[0].accountId = Number(snapshot.players[0].accountId); },
    (snapshot) => { snapshot.players[0].records[0].heroId = snapshot.players[1].records[0].heroId; },
  ]) { const snapshot = structuredClone(original); mutate(snapshot); assert.throws(() => validateMvpSnapshot(snapshot, tournament)); }
});

test('ingestion metadata preserves undiscovered source completeness independently of MVP pending maps', () => {
  const legacy = buildMvpSnapshot([score(map())], snapshotOptions);
  assert.equal('ingestionComplete' in legacy, false);
  validateMvpSnapshot(legacy, tournament);
  const incomplete = buildMvpSnapshot([score(map())], { ...snapshotOptions,
    ingestionComplete: false, ingestionPendingMatchIds: ['2', '3'] });
  assert.equal(incomplete.ingestionComplete, false);
  assert.deepEqual(incomplete.ingestionPendingMatchIds, ['2', '3']);
  validateMvpSnapshot(incomplete, tournament);
  const complete = buildMvpSnapshot([score(map())], { ...snapshotOptions,
    ingestionComplete: true, ingestionPendingMatchIds: [] });
  validateMvpSnapshot(complete, tournament);
  for (const fields of [
    { ingestionComplete: true, ingestionPendingMatchIds: ['2'] },
    { ingestionComplete: false, ingestionPendingMatchIds: [] },
    { ingestionComplete: false, ingestionPendingMatchIds: ['2', '2'] },
    { ingestionComplete: false, ingestionPendingMatchIds: ['0'] },
    { ingestionComplete: false, ingestionPendingMatchIds: [2] },
    { ingestionComplete: false, ingestionPendingMatchIds: ['2x'] },
    { ingestionComplete: false },
    { ingestionPendingMatchIds: [] },
  ]) {
    assert.throws(() => buildMvpSnapshot([score(map())], { ...snapshotOptions, ...fields }), /ingestion/);
    assert.throws(() => validateMvpSnapshot({ ...legacy, ...fields }, tournament), /ingestion/);
  }
});

test('pending correction metadata retains confirmed scores and must refer to unique ready map IDs', () => {
  const waiting = map(2); waiting.version = null;
  const records = [score(map(1)), score(waiting)];
  const original = buildMvpSnapshot(records, snapshotOptions);
  const correction = buildMvpSnapshot(records, { ...snapshotOptions, correctionPendingMatchIds: ['1'] });
  assert.deepEqual(correction.correctionPendingMatchIds, ['1']);
  assert.deepEqual(correction.players, original.players, 'the incomplete correction cannot erase confirmed metrics');
  assert.equal('ingestionComplete' in correction, false, 'correction metadata is independent of ingestion metadata');
  validateMvpSnapshot(correction, tournament);
  validateMvpSnapshot(buildMvpSnapshot(records, { ...snapshotOptions, correctionPendingMatchIds: [] }), tournament);
  for (const correctionPendingMatchIds of [['2'], ['3'], ['1', '1'], [1], ['0'], null]) {
    assert.throws(() => buildMvpSnapshot(records, { ...snapshotOptions, correctionPendingMatchIds }), /correction/);
    assert.throws(() => validateMvpSnapshot({ ...original, correctionPendingMatchIds }, tournament), /correction/);
  }
});

function estimate(id = '99', overrides = {}) {
  return { matchId: id, fixtureId: 'fixture-1', confirmed: true, played: true, winnerTeamId: 'alpha',
    reason: 'Organizer confirmed played map; statistics unavailable',
    players: score(map(Number(id))).players.map(({ metrics, scoreExact, ...identity }) => identity), ...overrides };
}
function scoredUniform(id, kills = 30, deaths = 0) {
  const raw = map(id); raw.players.forEach((player) => { player.kills = kills; player.deaths = deaths; });
  return score(raw);
}
const estimateRecord = (snapshot, accountId = '1', id = '99') => snapshot.players.find((player) => player.accountId === accountId)
  ?.records.find((record) => record.matchId === id);

test('missing-map scores use real per-player mean, exact ±15%, and never fabricate metrics', () => {
  const estimates = [estimate()];
  const snapshot = buildMvpSnapshot([scoredUniform(1)], { ...snapshotOptions, estimates });
  assert.deepEqual(snapshot.estimation.meanExact, { numerator: '10', denominator: '1' });
  assert.equal(snapshot.estimation.realPlayerMapCount, 10);
  assert.equal(snapshot.maps['99'].status, 'estimated');
  assert.deepEqual(estimateRecord(snapshot).scoreExact, { numerator: '23', denominator: '2' });
  assert.deepEqual(estimateRecord(snapshot, '6').scoreExact, { numerator: '17', denominator: '2' });
  assert.equal('metrics' in estimateRecord(snapshot), false);
  assert.deepEqual(snapshot.players.find((player) => player.accountId === '1').ratingExact, { numerator: '43', denominator: '2' });
  assert.equal(snapshot.players.find((player) => player.accountId === '1').rank, 1);
  assert.equal(snapshot.players.find((player) => player.accountId === '5').rank, 1, 'five equal winner estimates preserve ties');
  validateMvpSnapshot(snapshot, { ...tournament, mvpEstimates: estimates });
});

test('every estimate recalculates after new/corrected real data; estimates, exclusions and incomplete maps never enter the mean', () => {
  const estimates = [estimate(), estimate('100')];
  const initial = buildMvpSnapshot([scoredUniform(1)], { ...snapshotOptions, estimates });
  const pending = scoredUniform(3, 300); pending.status = 'pending'; pending.reason = 'Missing source';
  pending.players = pending.players.map(({ metrics, scoreExact, ...identity }) => identity);
  const excluded = scoredUniform(4, 600); excluded.status = 'excluded'; excluded.reason = 'Organizer exclusion';
  const real = [scoredUniform(1), scoredUniform(2, 60), pending, excluded];
  const changed = buildMvpSnapshot(real, { ...snapshotOptions, estimates });
  assert.deepEqual(initial.estimation.meanExact, { numerator: '10', denominator: '1' });
  assert.deepEqual(changed.estimation.meanExact, { numerator: '15', denominator: '1' });
  assert.equal(changed.estimation.realPlayerMapCount, 20);
  for (const id of ['99', '100']) assert.deepEqual(estimateRecord(changed, '1', id).scoreExact, { numerator: '69', denominator: '4' });
  const corrected = buildMvpSnapshot([...real, scoredUniform(1, 90)], { ...snapshotOptions, estimates, correctionPendingMatchIds: ['2'] });
  assert.deepEqual(corrected.estimation.meanExact, { numerator: '25', denominator: '1' });
  assert.equal(corrected.estimation.realPlayerMapCount, 20, 'duplicate real map replaces rather than adding baseline rows');
  validateMvpSnapshot(corrected, { ...tournament, mvpEstimates: estimates });
});

test('real recovery replaces the same estimated map and its score exactly once; explicit exclusion remains excluded', () => {
  const estimates = [estimate()];
  const recovered = buildMvpSnapshot([scoredUniform(1), scoredUniform(99, 60)], { ...snapshotOptions, estimates });
  assert.equal(recovered.maps['99'].status, 'ready');
  assert.equal(estimateRecord(recovered).estimation, undefined);
  assert.deepEqual(estimateRecord(recovered).scoreExact, { numerator: '20', denominator: '1' });
  assert.deepEqual(recovered.players.find((player) => player.accountId === '1').ratingExact, { numerator: '30', denominator: '1' });
  assert.equal(recovered.players.every((player) => player.countedMaps === 2), true);
  const excluded = score(map(99), { excludedReason: 'Explicit organizer exclusion' });
  const exclusion = buildMvpSnapshot([scoredUniform(1), excluded], { ...snapshotOptions, estimates });
  assert.equal(exclusion.maps['99'].status, 'excluded');
  assert.equal(estimateRecord(exclusion), undefined);
  validateMvpSnapshot(recovered, { ...tournament, mvpEstimates: estimates });
  validateMvpSnapshot(exclusion, { ...tournament, mvpEstimates: estimates });
});

test('zero and negative real baselines remain exact; absent baseline or actual identities keeps the map pending', () => {
  const estimates = [estimate()];
  const noBaseline = buildMvpSnapshot([], { ...snapshotOptions, estimates });
  assert.equal(noBaseline.maps['99'].status, 'pending');
  assert.equal(noBaseline.estimation.meanExact, null);
  assert.equal(noBaseline.players.every((player) => player.countedMaps === 0), true);
  const absent = [estimate('99', { players: [] })];
  const noIdentities = buildMvpSnapshot([scoredUniform(1)], { ...snapshotOptions, estimates: absent });
  assert.equal(noIdentities.maps['99'].estimatePending, true);
  assert.equal(noIdentities.players.every((player) => player.countedMaps === 1), true);
  const zeroBaseline = buildMvpSnapshot([scoredUniform(1, 0)], { ...snapshotOptions, estimates });
  assert.equal(zeroBaseline.maps['99'].status, 'estimated');
  assert.deepEqual(estimateRecord(zeroBaseline).scoreExact, { numerator: '0', denominator: '1' });
  const negative = buildMvpSnapshot([scoredUniform(1, 0, 3)], { ...snapshotOptions, estimates });
  assert.deepEqual(estimateRecord(negative).scoreExact, { numerator: '-23', denominator: '20' });
  assert.deepEqual(estimateRecord(negative, '6').scoreExact, { numerator: '-17', denominator: '20' });
  for (const snapshot of [noBaseline, zeroBaseline, negative]) validateMvpSnapshot(snapshot, { ...tournament, mvpEstimates: estimates });
  validateMvpSnapshot(noIdentities, { ...tournament, mvpEstimates: absent });
});

test('technical/no-play inputs, duplicate maps/accounts and forged estimation snapshots are rejected', () => {
  const config = estimate();
  for (const estimates of [[config, config], [estimate('99', { played: false })], [estimate('99', { confirmed: false })],
    [estimate('99', { players: config.players.slice(0, 5) })],
    [estimate('99', { players: config.players.map((player, index) => index === 1 ? config.players[0] : player) })]]) {
    assert.throws(() => buildMvpSnapshot([scoredUniform(1)], { ...snapshotOptions, estimates }));
  }
  const estimates = [config];
  const original = buildMvpSnapshot([scoredUniform(1)], { ...snapshotOptions, estimates });
  assert.throws(() => validateMvpSnapshot(original, tournament), /confirmation/);
  for (const mutate of [
    (snapshot) => { snapshot.estimation.meanExact = { numerator: '12', denominator: '1' }; },
    (snapshot) => { snapshot.estimation.realPlayerMapCount++; },
    (snapshot) => { estimateRecord(snapshot).estimation.factorExact = { numerator: '1', denominator: '1' }; },
    (snapshot) => { estimateRecord(snapshot).metrics = zero; },
    (snapshot) => { snapshot.maps['99'].winnerTeamId = 'third'; },
    (snapshot) => { estimateRecord(snapshot).heroId = 11; },
    (snapshot) => { const record = estimateRecord(snapshot); record.scoreExact = { numerator: '12', denominator: '1' };
      snapshot.players.find((player) => player.accountId === '1').ratingExact = { numerator: '22', denominator: '1' }; },
  ]) { const snapshot = structuredClone(original); mutate(snapshot); assert.throws(() => validateMvpSnapshot(snapshot, { ...tournament, mvpEstimates: estimates })); }
});

test('estimates reject technical fixtures and a winner conflicting with the confirmed sports result', () => {
  const estimates = [estimate()];
  const fixture = { id: 'fixture-1', team1Id: 'alpha', team2Id: 'beta' };
  const withFixture = (overrides) => ({ ...tournament, stages: [{ matches: [{ ...fixture, ...overrides }] }] });
  assert.throws(() => validateMvpEstimates(estimates, withFixture({ status: 'walkover', scoreKind: 'technical' })), /Technical victory/);
  assert.throws(() => validateMvpEstimates(estimates, withFixture({ status: 'completed', resultConfirmed: true, winnerTeamId: 'beta' })), /winner conflicts/);
  validateMvpEstimates(estimates, withFixture({ status: 'completed', resultConfirmed: true, winnerTeamId: 'alpha' }));
  assert.throws(() => validateMvpEstimates([estimate('99'), estimate('100')], withFixture({ bestOf: 'BO1' })), /played map count/);
  assert.throws(() => validateMvpEstimates([estimate('99'), estimate('100')], withFixture({ bestOf: 'BO3',
    resultConfirmed: true, score1: 1, score2: 0, winnerTeamId: 'alpha' })), /played map count/);
  assert.throws(() => validateMvpEstimates(estimates, withFixture({ bestOf: 'BO1', resultConfirmed: true,
    score1: 1, score2: 0, winnerTeamId: 'alpha', maps: [{ matchId: '98' }] })), /fixture map IDs/);
  validateMvpEstimates(estimates, withFixture({ bestOf: 'BO1', resultConfirmed: true,
    score1: 1, score2: 0, winnerTeamId: 'alpha', maps: [{ matchId: '99' }] }));
});

test('discovery failure is distinct from known-map gaps and legacy ingestion semantics remain intact', () => {
  const snapshot = buildMvpSnapshot([score(map())], { ...snapshotOptions, discoveryPending: true,
    ingestionComplete: false, ingestionPendingMatchIds: [] });
  assert.equal(snapshot.coverageComplete, false);
  validateMvpSnapshot(snapshot, tournament);
  const corrected = structuredClone(snapshot); corrected.ingestionComplete = true;
  assert.throws(() => validateMvpSnapshot(corrected, tournament), /ingestion/);
  assert.throws(() => buildMvpSnapshot([], { ...snapshotOptions, discoveryPending: true }), /ingestion/);
  assert.throws(() => buildMvpSnapshot([], { ...snapshotOptions, discoveryPending: 'true',
    ingestionComplete: false, ingestionPendingMatchIds: [] }), /ingestion/);
});

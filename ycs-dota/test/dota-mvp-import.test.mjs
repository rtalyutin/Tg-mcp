import test from 'node:test';
import assert from 'node:assert/strict';
import tournament from '../src/data/tournaments/dota2-autumn-2026.json' with { type: 'json' };
import { collectMvpImport, publishMvpImport, readJsonObject, writeJsonObject, mvpSource } from '../backend/dota-mvp-import.mjs';
import { collectDotaResults } from '../src/lib/dota-import.js';
import { startResultsWorker } from '../backend/dota-results-worker.mjs';
import { run } from '../backend/dota-results-import.mjs';

const at = new Date('2026-10-09T22:00:00+03:00');
const heroes = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `npc_dota_hero_test${index + 1}` }));
function map(overrides = {}) {
  return { match_id: 900000001, leagueid: 20164, start_time: Date.parse('2026-10-09T20:35:00+03:00') / 1000,
    radiant_name: 'ARB Esports', dire_name: 'Team Borisogleb', radiant_win: true, radiant_score: 18, dire_score: 32,
    duration: 2400, pre_game_duration: 90, series_id: 12, version: 21,
    players: heroes.map((hero, index) => ({ account_id: 1000 + index, hero_id: hero.id,
      player_slot: index < 5 ? index : 128 + index - 5, personaname: `API ${index}`,
      kills: 1, assists: 2, deaths: 3, camps_stacked: 1, stuns: 0,
      damage_targets: {}, damage: {}, healing: {}, obs_log: [], obs_left_log: [] })), ...overrides };
}
function fetcher(getMap, log = []) {
  return async (url) => {
    log.push(url);
    if (url.endsWith('/matchIds')) return [900000001, 900000001];
    if (url.endsWith('/heroes')) return heroes;
    if (url.endsWith('/matches/900000001')) return typeof getMap === 'function' ? getMap() : getMap;
    if (url.includes('/players/')) { const account = Number(url.split('/').at(-1)); return { profile: { account_id: account, personaname: `Fetched ${account}` } }; }
    throw new Error(`Unexpected URL ${url}`);
  };
}
function store() {
  const objects = new Map(); let generation = 0;
  return { objects, async send(command) {
    const input = command.input;
    if (command.constructor.name === 'GetObjectCommand') {
      const current = objects.get(input.Key);
      if (!current) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { ETag: current.etag, Body: { transformToString: async () => JSON.stringify(current.value) } };
    }
    if (input.IfMatch && objects.get(input.Key)?.etag !== input.IfMatch || input.IfNoneMatch === '*' && objects.has(input.Key)) {
      throw Object.assign(new Error('Precondition failed'), { name: 'PreconditionFailed' });
    }
    objects.set(input.Key, { value: JSON.parse(input.Body), etag: `"${++generation}"` });
    return {};
  } };
}

test('ready cache deduplicates league IDs, stores required raw collections and avoids redownloading ready maps', async () => {
  const calls = [];
  const first = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(map(), calls) });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].status, 'ready');
  assert.equal(first.records[0].players.length, 10);
  assert.equal(first.pendingMaps, 0);
  assert.equal(first.cache.maps['900000001'].source.pre_game_duration, 90);
  assert.deepEqual(first.cache.maps['900000001'].source.players[0].obs_log, []);
  const second = await collectMvpImport({ tournament, now: at, cache: first.cache, fetchJson: fetcher(map(), calls) });
  assert.equal(second.cacheChanged, false);
  assert.equal(calls.filter((url) => url.includes('/matches/')).length, 1);
  assert.equal(calls.filter((url) => url.endsWith('/heroes')).length, 1);
  assert.equal(second.records[0].players[0].nickname, 'API 0');
});

test('MVP maps publish before the best-of series has finished and a late parse updates them independently', async () => {
  const bestOfThree = structuredClone(tournament);
  bestOfThree.stages[0].rounds[0].matches[3].bestOf = 'BO3';
  const first = await collectMvpImport({ tournament: bestOfThree, now: at, fetchJson: fetcher(map({ version: null })) });
  assert.equal(collectDotaResults(bestOfThree, first.maps).changed, false);
  assert.equal(first.records[0].status, 'pending');
  assert.equal(first.pendingMaps, 1);
  const calls = [];
  const late = await collectMvpImport({ tournament: bestOfThree, now: new Date('2026-12-01T12:00:00Z'),
    cache: first.cache, pendingOnly: true, fetchJson: fetcher(map(), calls) });
  assert.equal(late.records[0].status, 'ready');
  assert.equal(late.pendingMaps, 0);
  assert.equal(calls.some((url) => url.endsWith('/matchIds')), false, 'no new league discovery after tournament dates');
  assert.equal(collectDotaResults(bestOfThree, late.maps).changed, false);
  const s3 = store();
  const saved = await publishMvpImport({ s3, tournament: bestOfThree, now: at, collection: late,
    previousCache: { value: null }, previousSnapshot: { value: null } });
  assert.equal(saved.changed, true);
  assert.equal(saved.snapshot.players.length, 10);
  const repeated = await publishMvpImport({ s3, tournament: bestOfThree, now: at, collection: { ...late, cacheChanged: false },
    previousCache: { value: late.cache }, previousSnapshot: { value: saved.snapshot } });
  assert.equal(repeated.changed, false);
});

test('unregistered player nickname is fetched by account ID; a nickname in another team cannot substitute it', async () => {
  const source = map(); delete source.players[0].personaname;
  const calls = [];
  const result = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(source, calls),
    rosterIdentities: [{ tournamentId: tournament.id, teamId: 'dota2-main-2026-team-borisogleb', accountId: '1000', nickname: 'Wrong team' }] });
  assert.equal(result.records[0].players[0].nickname, 'Fetched 1000');
  assert.equal(calls.filter((url) => url.endsWith('/players/1000')).length, 1);
  const roster = await collectMvpImport({ tournament, now: at, cache: result.cache, fetchJson: fetcher(source),
    rosterIdentities: [{ tournamentId: tournament.id, teamId: 'dota2-qual-2026-arb-esports', accountId: '1000', nickname: 'Registered' }] });
  assert.equal(roster.records[0].players[0].nickname, 'Registered');
});

test('API failure and incomplete correction retain confirmed scores and the exact confirmed source', async () => {
  const first = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(map()) });
  const failed = await collectMvpImport({ tournament, now: at, cache: first.cache, rescanMatchIds: ['900000001'],
    fetchJson: fetcher(() => { throw new Error('HTTP 503'); }) });
  assert.deepEqual(failed.records, first.records);
  assert.equal(failed.pendingMaps, 1);
  const incomplete = map({ version: 22 }); delete incomplete.players[0].healing;
  const correction = await collectMvpImport({ tournament, now: at, cache: first.cache, rescanMatchIds: ['900000001'], fetchJson: fetcher(incomplete) });
  assert.deepEqual(correction.records, first.records);
  assert.equal(correction.pendingMaps, 1);
  assert.deepEqual(correction.cache.maps['900000001'].confirmedSource, first.cache.maps['900000001'].source);
  const corrected = map({ version: 23 }); corrected.players[0].kills = 10;
  const final = await collectMvpImport({ tournament, now: at, cache: correction.cache, pendingOnly: true, fetchJson: fetcher(corrected) });
  assert.equal(final.pendingMaps, 0);
  assert.notDeepEqual(final.records[0].players[0].scoreExact, first.records[0].players[0].scoreExact);
  assert.equal(final.cache.maps['900000001'].confirmedSource, undefined);
});

test('only a unique published fixture can contribute and an explicit exclusion remains excluded on retry', async () => {
  const unknown = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(map({ radiant_name: 'Unknown' })) });
  assert.equal(unknown.records.length, 0);
  assert.equal(unknown.cache.maps['900000001'].status, 'unmatched');
  const first = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(map()), excludedReasons: { '900000001': 'Organizer confirmed missing replay data' } });
  assert.equal(first.records[0].status, 'excluded');
  const retry = await collectMvpImport({ tournament, now: at, cache: first.cache, fetchJson: fetcher(map()) });
  assert.equal(retry.records[0].status, 'excluded');
});

test('a map within the tournament period waits for an unpublished later-round fixture instead of claiming completeness', async () => {
  const future = map({ start_time: Date.parse('2026-10-17T20:00:00+03:00') / 1000 });
  const first = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(future) });
  assert.deepEqual(first.ingestionPendingMatchIds, ['900000001']);
  assert.equal(first.pendingMaps, 1);
  assert.equal(first.records.length, 0);
  assert.equal(first.cache.maps['900000001'].ingestionPending, true);
  const calls = [];
  const retry = await collectMvpImport({ tournament, now: new Date('2026-11-01T12:00:00Z'), pendingOnly: true,
    cache: first.cache, fetchJson: fetcher(future, calls) });
  assert.equal(retry.pendingMaps, 1);
  assert.equal(calls.some((url) => url.endsWith('/matchIds')), false);
  const published = structuredClone(tournament);
  published.stages[0].rounds[0].matches[3].date = '2026-10-17';
  published.stages[0].rounds[0].matches[3].scheduledAt = '2026-10-17T20:00:00+03:00';
  const bound = await collectMvpImport({ tournament: published, now: at, cache: retry.cache, pendingOnly: true, fetchJson: fetcher(future) });
  assert.equal(bound.pendingMaps, 0);
  assert.equal(bound.records[0].status, 'ready');
  const outside = await collectMvpImport({ tournament, now: at,
    fetchJson: fetcher(map({ start_time: Date.parse('2026-11-17T20:00:00+03:00') / 1000 })) });
  assert.deepEqual(outside.ingestionPendingMatchIds, []);
  assert.equal(outside.records.length, 0);
});

test('failed rescan publishes correction status while preserving confirmed scores; recovery clears it', async () => {
  const s3 = store();
  const first = await collectMvpImport({ tournament, now: at, fetchJson: fetcher(map()) });
  const initial = await publishMvpImport({ s3, tournament, now: at, collection: first,
    previousCache: { value: null }, previousSnapshot: { value: null } });
  const failed = await collectMvpImport({ tournament, now: at, cache: first.cache, rescanMatchIds: ['900000001'],
    fetchJson: fetcher(() => { throw new Error('HTTP 503'); }) });
  assert.deepEqual(failed.ingestionPendingMatchIds, []);
  assert.deepEqual(failed.correctionPendingMatchIds, ['900000001']);
  const stale = await publishMvpImport({ s3, tournament, now: at, collection: failed,
    previousCache: { value: first.cache }, previousSnapshot: { value: initial.snapshot } });
  assert.equal(stale.changed, true);
  assert.equal(stale.snapshot.revision, 2);
  assert.equal(stale.snapshot.maps['900000001'].status, 'ready');
  assert.deepEqual(stale.snapshot.correctionPendingMatchIds, ['900000001']);
  assert.deepEqual(stale.snapshot.players, initial.snapshot.players);
  const source = map(); source.players[0].kills += 10;
  const fixed = await collectMvpImport({ tournament, now: at, cache: failed.cache, pendingOnly: true, fetchJson: fetcher(source) });
  const corrected = await publishMvpImport({ s3, tournament, now: at, collection: fixed,
    previousCache: { value: failed.cache }, previousSnapshot: { value: stale.snapshot } });
  assert.equal(corrected.snapshot.revision, 3);
  assert.deepEqual(corrected.snapshot.correctionPendingMatchIds, []);
  assert.notDeepEqual(corrected.snapshot.players, initial.snapshot.players);
});

test('S3 revision guard rejects an intervening writer and uncertain writes require exact readback', async () => {
  const s3 = store();
  await writeJsonObject(s3, 'test.json', { revision: 1 }, { value: null });
  const old = await readJsonObject(s3, 'test.json');
  s3.objects.set('test.json', { value: { revision: 2 }, etag: '"2"' });
  await assert.rejects(writeJsonObject(s3, 'test.json', { revision: 3 }, old), /Concurrent S3 revision/);
  const normalSend = s3.send.bind(s3);
  s3.send = async (command) => { const result = await normalSend(command); if (command.constructor.name === 'PutObjectCommand') throw new Error('Write response lost'); return result; };
  const saved = await writeJsonObject(s3, 'other.json', { revision: 1 }, { value: null });
  assert.equal(saved.revision, 1);
});

test('worker restores pending state after restart, retries until ready and stops after resolution', async () => {
  let callback; let calls = 0;
  const atEnd = new Date('2026-11-15T12:00:00Z');
  const worker = startResultsWorker({ now: () => atEnd,
    env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
    setTimer(fn) { callback = fn; return 1; }, clearTimer() {}, logger: { error() {} },
    async runOnce(options) { assert.equal(options.pendingOnly, true); calls++; return { pendingMaps: calls < 2 ? 1 : 0 }; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.state.pendingMaps, 1);
  const check = callback; callback = null; check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(worker.state.status, 'complete');
  assert.equal(callback, null);
  await worker.stop();
});

test('after the tournament a failed known publication is retried even when all player statistics are ready', async () => {
  let callback; let calls = 0;
  const worker = startResultsWorker({ now: () => new Date('2026-11-15T12:00:00Z'),
    env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
    setTimer(fn) { callback = fn; return 1; }, clearTimer() {}, logger: { error() {} },
    async runOnce(options) {
      assert.equal(options.pendingOnly, true); calls++;
      if (calls === 1) throw Object.assign(new Error('S3 publication unavailable'), { pendingMaps: 0 });
      return { pendingMaps: 0 };
    } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.state.status, 'error');
  assert.equal(typeof callback, 'function');
  const check = callback; callback = null; check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(worker.state.status, 'complete');
  assert.equal(callback, null);
  await worker.stop();
});

test('the last active cycle retains discovered IDs across a first-cache-write failure and retries only those IDs after end', async () => {
  const target = structuredClone(tournament);
  target.stages[0].rounds[0].matches[3].date = '2026-10-25';
  target.stages[0].rounds[0].matches[3].scheduledAt = '2026-10-25T20:30:00+03:00';
  const source = map({ start_time: Date.parse('2026-10-25T20:35:00+03:00') / 1000 });
  const s3 = store(); s3.destroy = () => {};
  const send = s3.send.bind(s3); let failed = false;
  s3.send = async (command) => {
    if (!failed && command.constructor.name === 'PutObjectCommand' && command.input.Key.endsWith('-mvp-cache.json')) {
      failed = true; throw new Error('First cache publication unavailable');
    }
    return send(command);
  };
  let clock = new Date('2026-10-25T23:59:00+03:00');
  let callback; const calls = []; const optionsSeen = [];
  const worker = startResultsWorker({ now: () => clock,
    env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
    setTimer(fn) { callback = fn; return 1; }, clearTimer() {}, logger: { error() {} },
    runOnce(options) {
      optionsSeen.push({ pendingOnly: options.pendingOnly, knownMatchIds: [...options.knownMatchIds] });
      return run({ ...options, tournament: target, createS3: () => s3, fetchJson: fetcher(source, calls),
        logger: { log() {}, warn() {} }, rosterIdentities: [] });
    } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.state.status, 'error');
  assert.equal(s3.objects.size, 0, 'the failed initial cache write left no persisted source');
  clock = new Date('2026-10-26T00:04:00+03:00');
  const check = callback; callback = null; check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(optionsSeen[1], { pendingOnly: true, knownMatchIds: ['900000001'] });
  assert.equal(worker.state.status, 'complete');
  assert.equal(callback, null);
  assert.equal(calls.filter((url) => url.endsWith('/matchIds')).length, 1, 'no new league discovery after the published end');
  assert.equal(calls.filter((url) => url.endsWith('/matches/900000001')).length, 2);
  assert.equal(s3.objects.size, 3);
  assert.equal(s3.objects.get('results/dota2-autumn-2026-mvp.json').value.players.every((player) => player.countedMaps === 1), true);
  assert.equal(s3.objects.get('results/dota2-autumn-2026.json').value.matches['dota-autumn-swiss-r1-04'].score2, 1);
  await worker.stop();
});

test('source projection preserves empty collections without replacing absent metrics with zeros', () => {
  const source = map(); delete source.players[0].stuns;
  const projected = mvpSource(source);
  assert.equal('stuns' in projected.players[0], false);
  assert.deepEqual(projected.players[0].healing, {});
});

test('real importer publishes late player statistics even when no new completed series exists', async () => {
  const s3 = store(); s3.destroy = () => {};
  let parsed = false;
  const options = { now: at, env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
    createS3: () => s3, fetchJson: fetcher(() => map({ version: parsed ? 21 : null })),
    logger: { log() {}, warn() {} }, rosterIdentities: [] };
  const initial = await run(options);
  assert.equal(initial.pendingMaps, 1);
  const results = s3.objects.get('results/dota2-autumn-2026.json').value;
  assert.equal(results.revision, 1);
  const waiting = s3.objects.get('results/dota2-autumn-2026-mvp.json').value;
  assert.equal(waiting.maps['900000001'].status, 'pending');
  assert.equal(waiting.players.length, 10);
  parsed = true;
  const late = await run({ ...options, now: new Date('2026-10-09T22:05:00+03:00') });
  assert.equal(late.pendingMaps, 0);
  assert.equal(late.mvpChanged, true);
  assert.deepEqual(s3.objects.get('results/dota2-autumn-2026.json').value, results);
  const rated = s3.objects.get('results/dota2-autumn-2026-mvp.json').value;
  assert.equal(rated.revision, 2);
  assert.equal(rated.maps['900000001'].status, 'ready');
  assert.equal(rated.players.every((player) => player.countedMaps === 1), true);
  // A restarted backend can repair a failed known result publication after
  // the tournament using its ready cache, with no new API discovery.
  s3.objects.delete('results/dota2-autumn-2026.json');
  const repaired = await run({ ...options, now: new Date('2026-11-01T12:00:00Z'), pendingOnly: true,
    fetchJson() { assert.fail('ready cache must not redownload API data'); } });
  assert.equal(repaired.pendingMaps, 0);
  assert.deepEqual(s3.objects.get('results/dota2-autumn-2026.json').value.matches, results.matches);
});

test('a failed middle map fetch cannot publish a false BO3 sweep; recovery publishes the actual 2:1', async () => {
  const bestOfThree = structuredClone(tournament);
  bestOfThree.stages[0].rounds[0].matches[3].bestOf = 'BO3';
  const allMaps = [map(), map({ match_id: 900000002, start_time: map().start_time + 60, radiant_win: false }),
    map({ match_id: 900000003, start_time: map().start_time + 120 })];
  let unavailable = true;
  const fetchJson = async (url) => {
    if (url.endsWith('/matchIds')) return allMaps.map((item) => item.match_id);
    if (url.endsWith('/heroes')) return heroes;
    const matchId = url.split('/').at(-1);
    if (matchId === '900000002' && unavailable) throw new Error('HTTP 503');
    return allMaps.find((item) => String(item.match_id) === matchId);
  };
  const s3 = store(); s3.destroy = () => {};
  const options = { tournament: bestOfThree, now: at, fetchJson, env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
    createS3: () => s3, logger: { log() {}, warn() {} }, rosterIdentities: [] };
  const initial = await run(options);
  assert.equal(initial.resultsDeferred, true);
  const snapshot = s3.objects.get('results/dota2-autumn-2026-mvp.json').value;
  assert.equal(snapshot.ingestionComplete, false);
  assert.deepEqual(snapshot.ingestionPendingMatchIds, ['900000002']);
  assert.equal(snapshot.maps['900000002'], undefined, 'unassociated source is never presented as a confirmed/scored MVP map');
  assert.equal(s3.objects.has('results/dota2-autumn-2026.json'), false);
  unavailable = false;
  const recovered = await run(options);
  assert.equal(recovered.pendingMaps, 0);
  const result = s3.objects.get('results/dota2-autumn-2026.json').value;
  assert.deepEqual([result.matches['dota-autumn-swiss-r1-04'].score1,
    result.matches['dota-autumn-swiss-r1-04'].score2], [1, 2]);
  assert.equal(s3.objects.get('results/dota2-autumn-2026-mvp.json').value.ingestionComplete, true);
});

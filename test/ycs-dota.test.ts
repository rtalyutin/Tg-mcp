import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readYcsDotaConfig, startYcsDotaRuntime } from '../src/ycs-dota/runtime.ts';
import { createYcsDotaStatusRoute } from '../src/ycs-dota/status.ts';
import { startStartupHttpListener } from '../src/startup-http.ts';

const credentials = { AWS_ACCESS_KEY_ID: 'synthetic-access-never-log', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-never-log' };
const log: string[] = [];
const logger = { log: (...values: unknown[]) => { log.push(values.join(' ')); }, warn: (...values: unknown[]) => { log.push(values.join(' ')); }, error: (...values: unknown[]) => { log.push(values.join(' ')); } };

test('Dota runtime is opt-in and missing credentials never start network work', async () => {
  for (const env of [{}, credentials, { YCS_DOTA_RESULTS_IMPORT_ENABLED: 'false', ...credentials },
    { YCS_DOTA_RESULTS_IMPORT_ENABLED: 'true' }, { YCS_DOTA_RESULTS_IMPORT_ENABLED: 'unexpected', ...credentials }]) {
    assert.equal(readYcsDotaConfig(env).enabled, false);
    const runtime = await startYcsDotaRuntime({ env, startWorker() { assert.fail('disabled collector must not instantiate a worker'); } });
    assert.equal(runtime.enabled, false); assert.equal(runtime.state.status, 'disabled'); await runtime.stop();
  }
});

test('adapter keeps independent worker state, filters dependency logs, narrows credentials and drains stop', async () => {
  let stopped = 0;
  const state = { status: 'running', pendingMaps: 3, lastAttemptAt: '2026-10-09T18:00:00Z', lastSuccessAt: null };
  const runtime = await startYcsDotaRuntime({ env: { ...credentials, YCS_DOTA_RESULTS_IMPORT_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'private-unrelated' }, logger,
    startWorker(options) {
      assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
      options.logger.error(new Error(credentials.AWS_SECRET_ACCESS_KEY)); options.logger.warn(credentials.AWS_ACCESS_KEY_ID); options.logger.log('private-unrelated');
      return { state, async stop() { stopped++; } };
    } });
  assert.equal(runtime.enabled, true); assert.equal(runtime.state.pendingMaps, 3);
  assert.deepEqual(log, ['YCS_DOTA_RETRY', 'YCS_DOTA_WARNING', 'YCS_DOTA_ACTIVITY']);
  await runtime.stop(); assert.equal(stopped, 1);
  const failed = await startYcsDotaRuntime({ env: { ...credentials, YCS_DOTA_RESULTS_IMPORT_ENABLED: 'true' },
    startWorker() { throw new Error(credentials.AWS_SECRET_ACCESS_KEY); } });
  assert.equal(failed.code, 'YCS_START_FAILED'); assert.ok(!JSON.stringify(failed).includes(credentials.AWS_SECRET_ACCESS_KEY));
});

test('status is safe readonly and remains on same socket before and after gateway activation', async () => {
  const runtime = await startYcsDotaRuntime({ env: {} });
  const listener = await startStartupHttpListener(0, createYcsDotaStatusRoute(() => runtime));
  const address = listener.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/healthz/ycs-dota`); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const status = await response.json(); assert.equal(status.enabled, false); assert.equal(status.configured, false);
    assert.equal(status.sourceRevision, JSON.parse(await readFile(new URL('../ycs-dota/manifest.json', import.meta.url), 'utf8')).sourceRevision); assert.match(status.packageFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(await (await fetch(`${base}/healthz/ycs-dota`, { method: 'HEAD' })).text(), '');
    assert.equal((await fetch(`${base}/healthz/ycs-dota`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/healthz/ycs-dota?secret=never-reflect`)).status, 503);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
    listener.activate((_request, response) => { response.writeHead(404); response.end(); });
    assert.equal((await fetch(`${base}/healthz/ycs-dota`)).status, 200);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally { await listener.close(); }
});

test('vendored closure exactly matches manifest and keeps published tournament/identity/S3 contracts', async () => {
  const root = new URL('../ycs-dota/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 8);
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), hash);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'), manifest.packageFingerprint);
  const tournament = JSON.parse(await readFile(new URL('src/data/tournaments/dota2-autumn-2026.json', root), 'utf8'));
  assert.equal(tournament.leagueId, 20164); assert.equal(tournament.id, 'dota2-autumn-2026');
  const { DOTA_RESULTS_BUCKET } = await import(new URL('backend/dota-mvp-import.mjs', root).href);
  assert.equal(DOTA_RESULTS_BUCKET, 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04');
  const { run } = await import(new URL('backend/dota-results-import.mjs', root).href);
  await run({ now: new Date('2026-10-08T00:00:00Z'), env: {}, logger, fetchJson() { assert.fail('no API before kickoff'); }, createS3() { assert.fail('no S3 before kickoff'); } });
});

test('approved organizer results survive missing league data without inventing player awards', async () => {
  const root = new URL('../ycs-dota/', import.meta.url);
  const tournament = JSON.parse(await readFile(new URL('src/data/tournaments/dota2-autumn-2026.json', root), 'utf8'));
  const fixtures = tournament.stages[0].rounds[0].matches;
  const byId = new Map(fixtures.map((fixture: { id: string }) => [fixture.id, fixture]));
  const results = await import(new URL('src/lib/dota-import.js', root).href);
  const { snapshot } = results.collectDotaResults(tournament, []);
  assert.equal(Object.keys(snapshot.matches).length, 3);
  assert.deepEqual([snapshot.matches['dota-autumn-swiss-r1-04'].score1,snapshot.matches['dota-autumn-swiss-r1-04'].score2], [1,0]);
  assert.deepEqual([snapshot.matches['dota-autumn-swiss-r1-05'].status,snapshot.matches['dota-autumn-swiss-r1-05'].score1,snapshot.matches['dota-autumn-swiss-r1-05'].score2], ['walkover',0,1]);
  assert.deepEqual(snapshot.matches['dota-autumn-swiss-r1-05'].maps, []);
  assert.equal(snapshot.matches['dota-autumn-swiss-r1-03'].maps[0].matchId, '9037645797');
  assert.equal(byId.size, 8);
  assert.equal(fixtures.filter((fixture: { status: string }) => fixture.status === 'scheduled').length, 5);
  const mvp = await import(new URL('src/lib/dota-mvp.js', root).href);
  const waiting = mvp.buildMvpSnapshot([], { tournamentId:tournament.id,leagueId:tournament.leagueId,revision:1,updatedAt:'2026-10-10T11:00:00Z',estimates:tournament.mvpEstimates });
  mvp.validateMvpSnapshot(waiting,tournament);
  assert.equal(waiting.maps['9037645797'].status,'pending');
  assert.deepEqual(waiting.players,[]);
});

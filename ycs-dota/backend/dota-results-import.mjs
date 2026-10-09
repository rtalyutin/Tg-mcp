#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import defaultTournament from "../src/data/tournaments/dota2-autumn-2026.json" with { type: "json" };
import { collectDotaResults, isPollWindow } from "../src/lib/dota-import.js";
import { validateDotaSnapshot } from "../src/lib/dota-results.js";
import { collectMvpImport, publishMvpImport, validateMvpCache, validateImportedMvpSnapshot, readJsonObject, writeJsonObject } from "./dota-mvp-import.mjs";

const key = "results/dota2-autumn-2026.json";
const requestSignal = (signal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  : AbortSignal.timeout(20_000);
async function getJson(url, signal) {
  const response = await fetch(url, { signal: requestSignal(signal), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenDota HTTP ${response.status} at ${new URL(url).pathname}`);
  return JSON.parse(await response.text(), (key, value, context) =>
    key === 'stuns' && typeof value === 'number' && context?.source ? context.source : value);
}

async function getLeagueMaps(leagueId, fetchJson, signal, limit = Infinity) {
  const ids = await fetchJson(`https://api.opendota.com/api/leagues/${leagueId}/matchIds`, signal);
  if (!Array.isArray(ids) || ids.some((id) => !/^[1-9]\d*$/.test(String(id)))) throw new Error("Invalid OpenDota league match IDs");
  const maps = [];
  for (const id of [...new Set(ids.map(String))].slice(0, limit)) maps.push(await fetchJson(`https://api.opendota.com/api/matches/${id}`, signal));
  return maps;
}

async function loadIdentities() {
  const module = await import('../src/data/player-identities.json', { with: { type: 'json' } });
  const data = module.default;
  return Array.isArray(data) ? data : data.entries || data.records || [];
}
function pacedFetcher(fetchJson) {
  let previousAt = 0;
  return async (url, signal) => {
    signal?.throwIfAborted();
    const wait = previousAt + 1100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    signal?.throwIfAborted();
    previousAt = Date.now();
    return fetchJson(url, signal);
  };
}

export async function run({ now = new Date(), env = process.env, signal,
  tournament = defaultTournament,
  probeOldLeague = false, pendingOnly = false, knownMatchIds = [], rescanMatchIds = [], excludedReasons = {}, rosterIdentities,
  fetchJson = getJson, createS3 = (config) => new S3Client(config), logger = console } = {}) {
  const apiFetcher = fetchJson === getJson ? pacedFetcher(fetchJson) : fetchJson;
  if (probeOldLeague) {
    const maps = await getLeagueMaps(19021, apiFetcher, signal, 1);
    logger.log(`Old league 19021: ${maps.length} map fetched, ${maps[0]?.match_id ?? "none"}; no S3 write`);
    return;
  }
  if (!pendingOnly && !isPollWindow(now, tournament)) { logger.log("Outside published tournament dates; no API or S3 request"); return { pendingMaps: 0 }; }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("S3 credentials are not configured");
  const s3 = createS3({ region: "ru-1", endpoint: "https://s3.twcstorage.ru", maxAttempts: 2,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  let pendingMaps;
  let retryMatchIds;
  try {
    const previousCache = await readJsonObject(s3, `results/${tournament.id}-mvp-cache.json`, signal, (value) => validateMvpCache(value, tournament));
    // After the tournament only known pending/reparse maps are retried. There
    // is no arbitrary deadline that turns missing replay data into a zero.
    if (pendingOnly && !Object.keys(previousCache.value?.maps || {}).length && !knownMatchIds.length) {
      return { pendingMaps: 0 };
    }
    const previousMvp = await readJsonObject(s3, `results/${tournament.id}-mvp.json`, signal, (value) => validateImportedMvpSnapshot(value, tournament));
    const previous = await readJsonObject(s3, key, signal, (value) => validateDotaSnapshot(value, tournament));
    const collection = await collectMvpImport({ tournament, now, fetchJson: apiFetcher, signal, cache: previousCache.value,
      rosterIdentities: rosterIdentities ?? await loadIdentities(), pendingOnly, knownMatchIds, rescanMatchIds, excludedReasons });
    pendingMaps = collection.pendingMaps;
    retryMatchIds = Object.keys(collection.cache.maps);
    const mvp = await publishMvpImport({ s3, tournament, now, signal, collection, previousCache, previousSnapshot: previousMvp });
    for (const warning of collection.warnings) logger.warn(warning);
    if (mvp.changed) logger.log(`Published MVP revision ${mvp.snapshot.revision}: ${mvp.snapshot.players.length} players`);
    if (collection.ingestionPendingMatchIds.length) {
      logger.warn(`Team results deferred: incomplete source for map(s) ${collection.ingestionPendingMatchIds.join(', ')}`);
      return { pendingMaps: collection.pendingMaps, mvpChanged: mvp.changed, resultsDeferred: true };
    }
    const result = collectDotaResults(tournament, collection.maps, previous.value, now);
    for (const warning of result.warnings) logger.warn(warning);
    const unresolved = result.warnings.filter((warning) => /^(Unmatched|Unknown series|Ambiguous|Conflict)/.test(warning));
    if (!result.changed) {
      if (unresolved.length) throw new Error(`${unresolved.length} unresolved Dota result(s); see map IDs above`);
      logger.log("No new confirmed series"); return { pendingMaps: collection.pendingMaps, mvpChanged: mvp.changed };
    }
    const saved = await writeJsonObject(s3, key, result.snapshot, previous, signal, (value) => validateDotaSnapshot(value, tournament));
    logger.log(`Published revision ${saved.revision}: ${Object.keys(saved.matches).length} completed series`);
    if (unresolved.length) throw new Error(`${unresolved.length} unresolved Dota result(s); see map IDs above`);
    return { pendingMaps: collection.pendingMaps, mvpChanged: mvp.changed };
  } catch (error) {
    if (Number.isSafeInteger(pendingMaps)) error.pendingMaps = pendingMaps;
    if (retryMatchIds) error.retryMatchIds = retryMatchIds;
    throw error;
  } finally { s3.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ probeOldLeague: process.argv.includes("--probe-old-league") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../ycs-dota/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
for (const [file, hash] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await readFile(new URL(file, root))).digest('hex');
  if (actual !== hash) throw new Error('YCS Dota source manifest mismatch');
}
if (createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.packageFingerprint) throw new Error('YCS Dota package fingerprint mismatch');
const { startResultsWorker } = await import(new URL('backend/dota-results-worker.mjs', root));
const { run } = await import(new URL('backend/dota-results-import.mjs', root));
const tournament = JSON.parse(await readFile(new URL('src/data/tournaments/dota2-autumn-2026.json', root), 'utf8'));
const identities = JSON.parse(await readFile(new URL('src/data/player-identities.json', root), 'utf8'));
if (typeof startResultsWorker !== 'function' || typeof run !== 'function' || tournament.id !== 'dota2-autumn-2026' || tournament.leagueId !== 20164 || !identities) {
  throw new Error('YCS Dota runtime assets are missing or incompatible');
}
console.log('YCS_DOTA_ASSETS_VALID');

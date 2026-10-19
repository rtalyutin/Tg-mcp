import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../player-intake/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const expected = ['backend/player-profile-api.mjs', 'backend/player-profile-auth.mjs', 'backend/player-profile-config.mjs', 'backend/player-profile-intake.mjs',
  'backend/player-profile-service.mjs', 'backend/player-profile-store.mjs', 'src/lib/player-profile-catalog.js', 'setup-cors.mjs'].sort();
if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) throw Error('YCS player intake closure inventory mismatch');
for (const file of expected) {
  const body = await readFile(new URL(file, root));
  if (createHash('sha256').update(body).digest('hex') !== manifest.files[file]) throw Error('YCS player intake source manifest mismatch');
  const relatives = [...body.toString('utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]).filter(name => name.startsWith('.'));
  for (const relative of relatives) {
    const dependency = new URL(relative, new URL(file, root));
    if (!dependency.href.startsWith(root.href) || !expected.includes(dependency.href.slice(root.href.length))) throw Error('YCS player intake import escapes verified closure');
  }
}
const backendFiles = (await readdir(new URL('backend/', root))).filter(name => name.endsWith('.mjs')).map(name => `backend/${name}`).sort();
if (JSON.stringify(backendFiles) !== JSON.stringify(expected.filter(name => name.startsWith('backend/')))) throw Error('YCS player intake extra backend file');
if (createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.packageFingerprint) throw Error('YCS player intake package fingerprint mismatch');
const { createPlayerProfileHandler } = await import(new URL('backend/player-profile-api.mjs', root).href);
const { createPlayerIntake } = await import(new URL('backend/player-profile-intake.mjs', root).href);
if (typeof createPlayerProfileHandler !== 'function' || typeof createPlayerIntake !== 'function') throw Error('YCS player intake source factories unavailable');
console.log('YCS_PLAYER_INTAKE_ASSETS_VALID');

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
const root = resolve('..');
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile()) files.push(child);
  }
}
await walk(resolve('src'));
await walk(resolve('migrations'));
files.push(resolve('package.json'), resolve(root, 'package.json'), resolve(root, 'package-lock.json'),
  resolve(root, 'src/production-main.ts'), resolve(root, 'src/outreach/server.ts'), resolve(root, 'src/outreach/database-tools.ts'));
const digest = createHash('sha256');
for (const path of files.sort()) {
  digest.update(relative(root, path)); digest.update('\0'); digest.update(await readFile(path)); digest.update('\0');
}
await writeFile('dist/build-info.json', JSON.stringify({ version: '1.0.2', source_digest: digest.digest('hex') }) + '\n');

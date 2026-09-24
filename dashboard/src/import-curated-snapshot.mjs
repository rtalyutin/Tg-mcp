import {readFile} from 'node:fs/promises';
import {connectPostgres} from './postgres.mjs';
import {importCuratedSnapshot} from './curated-snapshot.mjs';

const path = process.argv[2];
if (!path || !process.env.DASHBOARD_MIGRATION_DATABASE_URL) {
  console.error('Usage: DASHBOARD_MIGRATION_DATABASE_URL=... node dashboard/src/import-curated-snapshot.mjs <private-json-file>');
  process.exitCode = 1;
} else {
  const db = connectPostgres(process.env.DASHBOARD_MIGRATION_DATABASE_URL);
  try {
    const data = JSON.parse(await readFile(path,'utf8'));
    const result = await importCuratedSnapshot(db,data);
    console.log(`CURATED_SNAPSHOT_IMPORTED projects=${result.projects} tasks=${result.tasks} digest=${result.digest}`);
  } catch {
    console.error('CURATED_SNAPSHOT_IMPORT_FAILED'); process.exitCode = 1;
  } finally { await db.close(); }
}

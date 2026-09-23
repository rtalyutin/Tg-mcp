import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function migrate(db) {
  const directory=new URL('../migrations/',import.meta.url);
  const files=(await readdir(directory)).filter(name=>/^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('NO_MIGRATIONS');
  const migrations=await Promise.all(files.map(async name=>{
    const version=Number(name.slice(0,3));
    const sql=await readFile(new URL(name,directory),'utf8');
    return {version,sql,digest:createHash('sha256').update(sql).digest('hex')};
  }));
  if (new Set(migrations.map(x=>x.version)).size!==migrations.length)
    throw new Error('DUPLICATE_MIGRATION_VERSION');
  return db.transaction(async tx => {
    // Serialize migration runners before creating the version ledger.
    await tx.query('SELECT pg_advisory_xact_lock(410020260920)');
    await tx.exec(`CREATE TABLE IF NOT EXISTS public.dashboard_schema_migration (
      version integer PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    let applied=false;
    for (const migration of migrations) {
      const {rows}=await tx.query('SELECT digest FROM public.dashboard_schema_migration WHERE version=$1',[migration.version]);
      if (rows.length) {
        if (rows[0].digest!==migration.digest) throw new Error('MIGRATION_DRIFT');
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO public.dashboard_schema_migration(version,digest) VALUES ($1,$2)',
        [migration.version,migration.digest]);
      applied=true;
    }
    const latest=migrations.at(-1);
    return {applied,version:latest.version,digest:latest.digest};
  });
}

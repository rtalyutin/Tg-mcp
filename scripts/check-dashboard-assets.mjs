import {access} from 'node:fs/promises';
import {dashboardWebFiles} from '../dist/dashboard-web.js';

// Timeweb builds from the repository checkout. Keep migration SQL and the
// independent v2 package in the same deployment as the compiled gateway.
for (const path of [
  'dashboard/migrations/001_foundation.sql',
  'dashboard/migrations/002_run_lifecycle.sql',
  'dashboard/migrations/004_curated_snapshot.sql',
  'dashboard/src/http-gateway.mjs',
  'dashboard/src/migration-service.mjs',
  'dashboard/src/snapshot-update-service.mjs',
  'dashboard/src/health-readiness.mjs',
  'dashboard/src/mcp-server.mjs',
  'dist/production-main.js',
  ...new Set(Object.values(dashboardWebFiles).map(asset=>`dashboard/web/${asset.file}`))
]) await access(new URL(`../${path}`,import.meta.url));

// The compiled entry point resolves Dashboard from dist/, not from src/.
for (const file of ['http-gateway.mjs','curated-snapshot-gateway.mjs','migration-service.mjs','snapshot-update-service.mjs','health-readiness.mjs'])
  await access(new URL(`../dashboard/src/${file}`,new URL('../dist/production-main.js',import.meta.url)));

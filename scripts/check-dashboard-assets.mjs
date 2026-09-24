import {access} from 'node:fs/promises';
import {dashboardWebFiles} from '../dist/dashboard-web.js';

// Timeweb builds from the repository checkout. Keep migration SQL and the
// independent v2 package in the same deployment as the compiled gateway.
for (const path of [
  'dashboard/migrations/001_foundation.sql',
  'dashboard/migrations/002_run_lifecycle.sql',
  'dashboard/src/http-gateway.mjs',
  'dashboard/src/mcp-server.mjs',
  'dist/production-main.js',
  ...new Set(Object.values(dashboardWebFiles).map(asset=>`dashboard/web/${asset.file}`))
]) await access(new URL(`../${path}`,import.meta.url));

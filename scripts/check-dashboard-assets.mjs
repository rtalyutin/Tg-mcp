import {access} from 'node:fs/promises';

// Timeweb builds from the repository checkout. Keep migration SQL and the
// independent v2 package in the same deployment as the compiled gateway.
for (const path of [
  'dashboard/migrations/001_foundation.sql',
  'dashboard/migrations/002_run_lifecycle.sql',
  'dashboard/src/http-gateway.mjs',
  'dashboard/src/mcp-server.mjs',
  'dist/production-main.js'
]) await access(new URL(`../${path}`,import.meta.url));

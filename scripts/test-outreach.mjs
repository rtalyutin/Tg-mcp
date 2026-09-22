import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Dev-only WASM Postgres. Never used as the application's persistence layer.
const supplied = process.env.OUTREACH_TEST_DATABASE_URL;
const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith('--'));
const requestedFiles = args.filter(arg => !arg.startsWith('--'));
const files = requestedFiles.length ? requestedFiles : [
  'test/outreach-access.test.ts', 'test/outreach-registry.test.ts',
  'test/outreach-http.test.ts', 'test/outreach-heldout.test.ts',
];
async function runTests(testFiles, connectionString) {
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...flags, ...testFiles], {
    stdio: 'inherit', env: { ...process.env, OUTREACH_TEST_DATABASE_URL: connectionString },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}
if (supplied) {
  console.log('TEST_DATABASE=provided PostgreSQL');
  process.exitCode = await runTests(files, supplied);
} else {
  console.log('TEST_DATABASE=PGlite (native PostgreSQL concurrency and session semantics remain unverified)');
  // The socket adapter ignores startup search_path options. A fresh database per
  // test file is essential: schema names alone do not isolate these fixtures.
  process.exitCode = 0;
  for (const file of files) {
    let db, server;
    try {
      db = await PGlite.create();
      server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 55439, maxConnections: 16 });
      await server.start();
      const code = await runTests([file], 'postgresql://postgres:postgres@127.0.0.1:55439/postgres');
      if (code !== 0) process.exitCode = code;
    } finally { await server?.stop(); await db?.close(); }
  }
}

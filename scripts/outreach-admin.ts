import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readOutreachConfig } from '../src/outreach/config.ts';
import { createOutreachPool, migrateOutreach } from '../src/outreach/database.ts';
import { AccessStore, generateLogin, generateConnectionUrl } from '../src/outreach/access.ts';
import { z } from 'zod';
import { readInteractiveOwner } from './outreach-owner-input.ts';

async function readInput() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 4096) throw new Error(); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
let pool: ReturnType<typeof createOutreachPool> | undefined;
try {
  const config = readOutreachConfig(process.env);
  const command = process.argv[2];
  if (!['migrate', 'init-owner', 'add-login', 'revoke-login'].includes(command)) throw new Error();
  pool = createOutreachPool(config.databaseUrl);
  await migrateOutreach(pool);
  const access = new AccessStore(pool);
  if (command === 'migrate') console.log('OUTREACH_SCHEMA_READY');
  if (command === 'init-owner') {
    const input = z.strictObject({ login: z.string().min(1).max(128), password: z.string().min(1).max(256) }).parse(process.stdin.isTTY ? await readInteractiveOwner() : await readInput());
    await access.seedOwner(input.login, input.password);
    console.log('OUTREACH_OWNER_CREATED');
  }
  if (command === 'add-login') {
    const output = process.argv[3]; if (!output) throw new Error();
    const secret = generateLogin(); const target = resolve(output);
    // Never print the credential into terminal logs. Do not overwrite an existing file.
    await writeFile(target, generateConnectionUrl(config.publicOrigin, secret) + '\n', { flag: 'wx', mode: 0o600 });
    try { const result = await access.addLogin(secret, 'Owner-provisioned MCP'); console.log(`OUTREACH_MCP_LOGIN_CREATED id=${result.id}`); }
    catch (error) { await unlink(target); throw error; }
  }
  if (command === 'revoke-login') {
    const id = z.uuid().parse(process.argv[3]); await access.revokeLogin(id);
    console.log('OUTREACH_MCP_LOGIN_REVOKED');
  }
} catch {
  // No raw dependency error, input, URL, password or query in operator logs.
  console.error('OUTREACH_ADMIN_FAILED: check command, configuration and private input');
  process.exitCode = 1;
} finally { await pool?.end(); }

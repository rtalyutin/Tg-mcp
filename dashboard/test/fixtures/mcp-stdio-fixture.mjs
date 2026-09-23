import {PGlite} from '@electric-sql/pglite';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {migrate} from '../../src/migrate.mjs';
import {registerSource,beginRun} from '../../src/ingest.mjs';
import {createDashboardMcpServer} from '../../src/mcp-server.mjs';

const sourceId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const db=new PGlite();
await migrate(db);
await registerSource(db,{id:sourceId,kind:'chatgpt',externalScope:'stdio-fixture'});
await beginRun(db,[sourceId],runId);
void serveStdio(() => createDashboardMcpServer(db));

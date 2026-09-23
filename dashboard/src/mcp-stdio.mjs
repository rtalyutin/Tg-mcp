import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {connectPostgres} from './postgres.mjs';
import {createDashboardMcpServer} from './mcp-server.mjs';

const db = connectPostgres(process.env.DATABASE_URL);

for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
  await db.close();
  process.exit(0);
});

void serveStdio(() => createDashboardMcpServer(db));

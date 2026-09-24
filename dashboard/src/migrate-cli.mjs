import { connectPostgres } from './postgres.mjs';
import { migrate } from './migrate.mjs';
const db = connectPostgres(process.env.DASHBOARD_MIGRATION_DATABASE_URL);
try { console.log(JSON.stringify(await migrate(db))); }
finally { await db.close(); }

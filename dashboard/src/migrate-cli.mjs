import { connectPostgres } from './postgres.mjs';
import { migrate } from './migrate.mjs';
const db = connectPostgres(process.env.DATABASE_URL);
try { console.log(JSON.stringify(await migrate(db))); }
finally { await db.close(); }

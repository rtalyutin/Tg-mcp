import { Database } from "./db.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const db = new Database(url);
try {
  await db.migrate();
  console.log("Migrations applied");
} finally {
  await db.close();
}

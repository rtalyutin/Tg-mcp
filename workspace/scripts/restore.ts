import { readFile } from "node:fs/promises";
import { readConfig, components } from "../src/config.js";
import { restoreExport } from "../src/backup.js";
const path = process.argv[2];
if (!path) throw new Error("Usage: npm run restore -- export.json");
const config = readConfig(),
  { db, service } = components(config);
try {
  await restoreExport(
    db,
    service.blobs,
    config.OWNER_ID,
    JSON.parse(await readFile(path, "utf8")),
  );
  console.log("Export restored to empty database");
} finally {
  await db.close();
}

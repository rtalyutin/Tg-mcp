import { writeFile } from "node:fs/promises";
import { readConfig, components } from "../src/config.js";
const path = process.argv[2];
if (!path) throw new Error("Usage: npm run export -- export.json");
const config = readConfig(),
  { db, service } = components(config);
try {
  const result = await service.execute(
    "workspace_export",
    {},
    { owner_id: config.OWNER_ID, channel: "ui", executor_id: "native" },
  );
  await writeFile(path, JSON.stringify(result.data, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  console.log("Export written");
} finally {
  await db.close();
}

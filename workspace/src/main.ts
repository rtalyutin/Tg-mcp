import { readConfig, components } from "./config.js";
import { createServer } from "./server.js";
import { registerWebhook } from "./webhook.js";
const config = readConfig(),
  { db, auth, service } = components(config);
// Migration is an explicit release step. Startup never rewrites the schema.
await db.pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
await service.init(config.OWNER_ID);
const app = createServer(service, auth);
registerWebhook(app, service, config.OWNER_ID, config.OPENAI_WEBHOOK_SECRET);
await app.listen({ host: config.HOST, port: config.PORT });
console.log("Workspace backend listening");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await db.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

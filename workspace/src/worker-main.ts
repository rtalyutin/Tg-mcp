import { readConfig, components } from "./config.js";
import { Worker } from "./worker.js";
import { OpenAIAgentsAdapter } from "./agents-adapter.js";
import { setTimeout as pause } from "node:timers/promises";
const config = readConfig();
if (!config.workerReady)
  throw new Error(
    "Worker requires API key, model and HTTPS scoped workspace MCP URL",
  );
const { db, auth, service } = components(config);
await service.init(config.OWNER_ID);
const worker = new Worker(service, config.OWNER_ID, async (run) => {
  const token = await auth.executionToken(
    { owner_id: config.OWNER_ID, channel: "worker", executor_id: "worker" },
    run,
  );
  return new OpenAIAgentsAdapter({
    apiKey: config.OPENAI_API_KEY!,
    model: config.WORKER_MODEL!,
    maxTimeoutMs: config.WORKER_TIMEOUT_MS,
    serviceMcp: [
      {
        serverLabel: "workspace",
        serverUrl: config.WORKER_MCP_URL!,
        readOnly: true,
        allowedTools: [
          "context_get",
          "artifact_get",
          "skill_package_read",
          "capabilities_list",
          "external_mcp_read",
        ],
        headers: { "X-Execution-Token": token },
      },
    ],
  });
});
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
try {
  await worker.schedulerTick(new Date(), true);
  while (!stopping) {
    try {
      await worker.schedulerTick();
      await worker.poll();
    } catch {
      console.error(
        "Worker iteration failed; state retained for reconciliation",
      );
    }
    if (!stopping) await pause(config.WORKER_POLL_MS);
  }
} finally {
  await db.close();
}

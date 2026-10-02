import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { harness } from "./harness.js";
test("compiled server startup and synthetic 7/41/20 fixture", async (t) => {
  const h = await harness({ readyTasks: true });
  t.after(() => h.close());
  const net = createServer();
  net.listen(0, "127.0.0.1");
  await once(net, "listening");
  const port = (net.address() as any).port;
  await new Promise<void>((r) => net.close(() => r()));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: h.db.pool.options.connectionString,
    OWNER_ID: h.owner,
    OWNER_SUBJECT: "owner",
    UI_ORIGIN: "http://localhost:5173",
    AUTH_SIGNING_SECRET: "signing".repeat(8),
    DEV_HUMAN_SECRET: "human".repeat(8),
    DEV_MODEL_TOKEN: "model".repeat(8),
    PORT: String(port),
    LOCAL_BLOB_DIR: h.dir + "/cli-blobs",
  };
  const fixture = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture.ts"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  fixture.stdout.on("data", (b) => (log += b));
  fixture.stderr.on("data", (b) => (log += b));
  assert.equal((await once(fixture, "exit"))[0], 0, log);
  assert.equal(
    (
      await h.db.pool.query(
        "SELECT count(*)::int n FROM projects WHERE parent_id IS NULL",
      )
    ).rows[0].n,
    7,
  );
  assert.equal(
    (
      await h.db.pool.query(
        "SELECT count(*)::int n FROM projects WHERE parent_id IS NOT NULL",
      )
    ).rows[0].n,
    41,
  );
  assert.equal(
    (
      await h.db.pool.query(
        "SELECT count(*)::int n FROM recurring_jobs WHERE status='draft'",
      )
    ).rows[0].n,
    20,
  );
  assert.equal(
    (await h.db.pool.query("SELECT count(*)::int n FROM runs")).rows[0].n,
    0,
  );
  const child = spawn(process.execPath, ["dist/src/main.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, log);
  const response = await fetch(
    `http://127.0.0.1:${port}/api/operations/workspace_get`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + env.DEV_MODEL_TOKEN,
      },
      body: "{}",
    },
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).data.projects.length, 48);
});

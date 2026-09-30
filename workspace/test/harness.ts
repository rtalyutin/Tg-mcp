import { mkdtemp, cp, mkdir, chown, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { postgres } from "@embedded-postgres/linux-x64";
import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import { Database, id } from "../src/db.js";
import { WorkspaceService, type Actor } from "../src/service.js";
import { LocalBlobs } from "../src/storage.js";
export async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "workspace-backend-test-"));
  const root = process.getuid?.() === 0,
    ids = root ? { uid: 65534, gid: 65534 } : {};
  if (root) await chown(dir, 65534, 65534);
  await cp(resolve(dirname(postgres), ".."), join(dir, "native"), {
    recursive: true,
    dereference: true,
  });
  const bin = (name: string) => join(dir, "native", "bin", name);
  const env = { ...process.env, LD_LIBRARY_PATH: join(dir, "native", "lib") };
  const init = spawn(
    bin("initdb"),
    [
      "-D",
      join(dir, "data"),
      "-U",
      "test",
      "-A",
      "trust",
      "--locale=C",
      "--no-sync",
    ],
    { ...ids, env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  init.stdout.on("data", (b) => (log += b));
  init.stderr.on("data", (b) => (log += b));
  const [code] = await once(init, "exit");
  if (code !== 0) throw new Error("test initdb failed: " + log.slice(-2000));
  // Private random Unix socket: no shared service, no TCP port, no created OS account.
  const child = spawn(
    bin("postgres"),
    [
      "-D",
      join(dir, "data"),
      "-k",
      dir,
      "-c",
      "listen_addresses=",
      "-c",
      "fsync=off",
    ],
    { ...ids, env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  const url = `postgresql://test@localhost/postgres?host=${encodeURIComponent(dir)}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      ready = true;
      break;
    } catch {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error("test postgres failed: " + log.slice(-2000));
  }
  const db = new Database(url);
  await db.migrate();
  const owner = id();
  const service = new WorkspaceService(db, new LocalBlobs(join(dir, "blobs")), {
    worker_ready: true,
    worker_model: "test-model",
    capability_max_age_ms: 600000,
  });
  await service.init(owner);
  const ui: Actor = { owner_id: owner, channel: "ui", executor_id: "native" },
    model: Actor = { ...ui, channel: "model" };
  const call = async (name: any, body: any = {}, actor = ui) =>
    (await service.execute(name, body, actor)).data;
  return {
    db,
    service,
    owner,
    ui,
    model,
    call,
    dir,
    async close() {
      await db.close();
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(dir, { recursive: true, force: true });
    },
  };
}

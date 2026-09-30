import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { harness } from "./harness.js";
import { Database, id } from "../src/db.js";
import { PostgresBlobs } from "../src/postgres-blobs.js";
import { bytesHash } from "../src/storage.js";
import { restoreExport } from "../src/backup.js";

test("host workspace shares auth and Postgres while preserving root routes", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const { migrateOutreach } = await import(
    new URL("../../dist/outreach/database.js", import.meta.url).href
  );
  const { startLocalOutreach } = await import(
    new URL("../../dist/outreach/server.js", import.meta.url).href
  );
  const { DatabaseTools } = await import(
    new URL("../../dist/outreach/database-tools.js", import.meta.url).href
  );
  const { createWorkspaceGateway } = await import(
    new URL("../dist/src/host-gateway.js", import.meta.url).href
  );
  await migrateOutreach(h.db.pool);
  const app = await startLocalOutreach({ pool: h.db.pool });
  await app.access.seedOwner("test-owner", "Synthetic test owner password");
  const ownerId = (await h.db.pool.query("SELECT id FROM outreach_owners"))
    .rows[0].id;
  const credential = await app.access.addLogin("!!!!!!!!!!!!!!!!", "host test");
  const databaseUrl = h.db.pool.options.connectionString!;
  const config = {
    databaseUrl,
    ownerId,
    migrationsDirectory: fileURLToPath(
      new URL("../migrations/", import.meta.url),
    ),
  };
  let workspace = await createWorkspaceGateway(config);
  t.after(async () => {
    await hosted.close();
    await workspace.close();
    await app.close();
  });
  const hosted = await startLocalOutreach({
    pool: h.db.pool,
    workspace,
    databaseTools: new DatabaseTools(h.db.pool, credential.id),
  });
  const session = await app.access.createSession(ownerId);
  const headers = { cookie: `ycs_session=${session.token}` };
  const request = (path: string, init: RequestInit = {}) =>
    fetch(hosted.url + path, init);
  const post = (name: string, body: object, csrf = session.csrfToken) =>
    request("/workspace/api/operations/" + name, {
      method: "POST",
      headers: {
        ...headers,
        origin: hosted.url,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(body),
    });
  const mcp = async (
    name: string,
    args: object = {},
    login = "!!!!!!!!!!!!!!!!",
  ) => {
    const response = await request("/mcp?login=" + encodeURIComponent(login), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  let project: any, work: any, artifact: any;
  await t.test(
    "same owner cookie/CSRF, no anonymous model bypass or human approval over MCP",
    async () => {
      assert.equal((await request("/workspace/api/workspace")).status, 401);
      const sessionReply = await request("/workspace/api/session", { headers });
      assert.equal(sessionReply.status, 200);
      assert.equal((await sessionReply.json()).csrf_token, session.csrfToken);
      assert.equal(
        (
          await post(
            "project_create",
            { operation_id: id(), title: "ЯКС" },
            "wrong",
          )
        ).status,
        403,
      );
      const created = await post("project_create", {
        operation_id: id(),
        title: "ЯКС",
      });
      assert.equal(created.status, 200);
      project = (await created.json()).data;
      const denied = await mcp("workspace_project_archive", {
        operation_id: id(),
        id: project.id,
        expected_revision: 1,
      });
      assert.equal(denied.isError, true);
      assert.equal(denied.structuredContent.error.code, "human_ui_required");
      const invalid = await mcp("workspace_project_create", {
        operation_id: id(),
        title: "Spoof",
        channel: "ui",
      });
      assert.equal(invalid.structuredContent.error.code, "validation_error");
      const noAuth = await mcp(
        "workspace_workspace_get",
        {},
        "################",
      );
      assert.equal(noAuth.isError, true);
      assert.equal(
        (await mcp("workspace_workspace_get")).structuredContent.data
          .projects[0].title,
        "ЯКС",
      );
    },
  );
  await t.test(
    "existing tools, health and login stay available beside namespaced tools",
    async () => {
      assert.equal((await request("/healthz")).status, 200);
      assert.equal((await request("/login")).status, 200);
      const status = await mcp("get_dashboard_storage_access");
      assert.equal(status.structuredContent.workspace.enabled, true);
      assert.equal(status.structuredContent.workspace.version, "1.0.2");
      assert.match(
        status.structuredContent.workspace.source_digest,
        /^[a-f0-9]{64}$/,
      );
      assert.equal((await mcp("search_companies", {})).isError, undefined);
    },
  );
  await t.test(
    "raw DB tool cannot forge sessions, read keys or alter approvals",
    async () => {
      for (const [schema, table] of [
        ["roman_workspace", "host_keys"],
        ["roman_workspace", "proposals"],
        ["public", "outreach_owner_sessions"],
        ["pg_catalog", "pg_authid"],
      ]) {
        const result = await mcp("read_database", { schema, table });
        assert.equal(
          result.structuredContent.code,
          "DATABASE_PERMISSION_DENIED",
        );
        const write = await mcp("write_database", {
          schema,
          table,
          operation: "insert",
          rows: [{ values: {} }],
        });
        assert.equal(
          write.structuredContent.code,
          "DATABASE_PERMISSION_DENIED",
        );
      }
      const tables = (await mcp("read_database", {})).structuredContent.tables;
      assert.ok(
        tables.every(
          (row: any) =>
            row.schema !== "roman_workspace" &&
            !row.table.startsWith("outreach_owner"),
        ),
      );
    },
  );
  await t.test(
    "immutable files persist after gateway reconstruction; public tables are untouched",
    async () => {
      work = (
        await (
          await post("work_item_create", {
            operation_id: id(),
            project_id: project.id,
            title: "Task",
            goal: "Test",
          })
        ).json()
      ).data;
      const bytes = Buffer.from("Durable file \0 bytes");
      artifact = (
        await (
          await post("artifact_add", {
            operation_id: id(),
            work_item_id: work.id,
            title: "File",
            kind: "file",
            base64: bytes.toString("base64"),
          })
        ).json()
      ).data;
      assert.ok(artifact.id);
      const publicBefore = (
        await h.db.pool.query("SELECT count(*)::int n FROM projects")
      ).rows[0].n;
      await workspace.close();
      workspace = await createWorkspaceGateway(config);
      const result = await workspace.executeUi(
        "artifact_get",
        { id: artifact.id },
        ownerId,
      );
      assert.ok(JSON.stringify(result).includes(bytes.toString("base64")));
      assert.equal(
        (await h.db.pool.query("SELECT count(*)::int n FROM projects")).rows[0]
          .n,
        publicBefore,
      );
      const db = new Database(databaseUrl, {
        schema: "roman_workspace",
        migrationsDirectory: config.migrationsDirectory,
      });
      try {
        await db.migrate();
        const blobs = new PostgresBlobs(db, ownerId);
        assert.deepEqual(
          await blobs.get(ownerId + "/" + bytesHash(bytes)),
          bytes,
        );
        await assert.rejects(
          blobs.put(ownerId + "/" + bytesHash(bytes), Buffer.from("different")),
          /blob_hash_mismatch/,
        );
        assert.equal(
          (await db.pool.query("SELECT count(*)::int n FROM schema_migrations"))
            .rows[0].n,
          2,
        );
        const backup = (
          await workspace.executeUi("workspace_export", {}, ownerId)
        ).data;
        assert.ok(!Object.hasOwn(backup.data, "host_keys"));
        const restored = new Database(databaseUrl, {
          schema: "restore_workspace",
          migrationsDirectory: config.migrationsDirectory,
        });
        try {
          await restored.migrate();
          await restoreExport(
            restored,
            new PostgresBlobs(restored, ownerId),
            ownerId,
            backup,
          );
          assert.equal(
            (await restored.pool.query("SELECT title FROM projects")).rows[0]
              .title,
            "ЯКС",
          );
        } finally {
          await restored.close();
        }
      } finally {
        await db.close();
      }
    },
  );
});

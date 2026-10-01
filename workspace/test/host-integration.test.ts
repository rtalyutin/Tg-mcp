import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { harness } from "./harness.js";
import { id } from "../src/db.js";
import { restoreExport } from "../src/backup.js";
import { PostgresBlobs } from "../src/postgres-blobs.js";

test("host integration on native PostgreSQL with the existing owner and MCP login", async (t) => {
  const h = await harness();
  // Setup can fail before the client/server finally block (e.g. bad build info).
  t.after(() => h.close());
  const { migrateOutreach } = await import(
    new URL("../../dist/outreach/database.js", import.meta.url).href
  );
  const { AccessStore } = await import(
    new URL("../../dist/outreach/access.js", import.meta.url).href
  );
  const { DatabaseTools } = await import(
    new URL("../../dist/outreach/database-tools.js", import.meta.url).href
  );
  const { startLocalOutreach } = await import(
    new URL("../../dist/outreach/server.js", import.meta.url).href
  );
  const { createWorkspaceGateway } = await import(
    new URL("../dist/src/host-gateway.js", import.meta.url).href
  );
  await migrateOutreach(h.db.pool);
  // A same-named table with a different constraint policy must stay untouched.
  await h.db.pool.query(
    "ALTER TABLE public.projects ALTER CONSTRAINT projects_owner_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE",
  );
  const publicForeignKeys = async () =>
    (
      await h.db.pool.query(
        "SELECT conrelid::regclass::text AS tbl,conname,condeferrable,condeferred FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY tbl,conname",
      )
    ).rows;
  const foreignKeysBefore = await publicForeignKeys();
  const access = new AccessStore(h.db.pool);
  await access.seedOwner("synthetic-owner", "synthetic local password");
  const owner = (await h.db.pool.query("SELECT id FROM outreach_owners"))
    .rows[0].id;
  const credential = await access.addLogin(
    "!!!!!!!!!!!!!!!!",
    "synthetic workspace MCP",
  );
  const config = {
    databaseUrl: h.url,
    ownerId: owner,
    migrationsDirectory: fileURLToPath(
      new URL("../migrations/", import.meta.url),
    ),
  };
  let workspace = await createWorkspaceGateway(config);
  const databaseTools = new DatabaseTools(h.db.pool, credential.id);
  const app = await startLocalOutreach({
    pool: h.db.pool,
    workspace,
    databaseTools,
    trustedProxyCidrs: ["127.0.0.1/32"],
  });
  let requestNumber = 0;
  const request: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-forwarded-for", `198.51.100.${++requestNumber}`);
    return fetch(input, { ...init, headers });
  };
  const client = new Client({
    name: "workspace-native-integration",
    version: "1",
  });
  let cookie = "",
    csrf = "";
  const ui = (name: string, input: unknown, token = csrf) =>
    request(app.url + "/workspace/api/operations/" + name, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: app.url,
        cookie,
        "x-csrf-token": token,
      },
      body: JSON.stringify(input),
    });
  const mcp = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: "workspace_" + name, arguments: args });
  let project: any, task: any, artifact: any;
  let executionToken = "",
    executionSnapshot = "";
  try {
    await t.test(
      "migration changes only foreign keys in its own schema",
      async () => {
        assert.deepEqual(await publicForeignKeys(), foreignKeysBefore);
        const ownKeys = (
          await h.db.pool.query(
            "SELECT condeferrable,condeferred FROM pg_constraint WHERE contype='f' AND connamespace='roman_workspace'::regnamespace",
          )
        ).rows;
        assert.ok(ownKeys.length > 0);
        assert.ok(ownKeys.every((row) => row.condeferrable && row.condeferred));
      },
    );
    await t.test("owner API requires the existing web session", async () => {
      assert.equal(
        (await request(app.url + "/workspace/api/workspace")).status,
        401,
      );
      const login = await request(app.url + "/login", {
        method: "POST",
        headers: { origin: app.url, "content-type": "application/json" },
        body: JSON.stringify({
          login: "synthetic-owner",
          password: "synthetic local password",
        }),
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      assert.ok(cookie.startsWith("ycs_session="));
      const session = await (
        await request(app.url + "/workspace/api/session", {
          headers: { cookie },
        })
      ).json();
      csrf = session.csrf_token;
      assert.equal(session.version, "1.0.5");
      assert.equal(session.auth, "host");
      assert.equal(session.worker_ready, false);
    });
    await t.test(
      "authenticated writes require host CSRF and preserve idempotency",
      async () => {
        const input = { operation_id: id(), title: "ЯКС" };
        assert.equal((await ui("project_create", input, "wrong")).status, 403);
        project = (await (await ui("project_create", input)).json()).data;
        assert.equal(
          (await (await ui("project_create", input)).json()).data.id,
          project.id,
        );
        task = (
          await (
            await ui("work_item_create", {
              operation_id: id(),
              project_id: project.id,
              title: "Сезон",
              goal: "Проверить интеграцию",
            })
          ).json()
        ).data;
        const dash = await (
          await request(app.url + "/workspace/api/workspace", {
            headers: { cookie },
          })
        ).json();
        assert.equal(dash.data.projects.length, 1);
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          app.url + "/mcp?login=" + encodeURIComponent("!!!!!!!!!!!!!!!!"),
        ),
        { fetch: request },
      ),
    );
    await t.test(
      "the same MCP retains existing tools and exposes workspace model operations",
      async () => {
        const tools = (await client.listTools()).tools.map((x) => x.name);
        assert.ok(tools.includes("search_companies"));
        assert.ok(tools.includes("workspace_workspace_get"));
        assert.ok(!tools.includes("workspace_proposal_accept"));
        const access = await client.callTool({
          name: "get_dashboard_storage_access",
          arguments: {},
        });
        assert.equal(
          (access.structuredContent as any).workspace.version,
          "1.0.5",
        );
        assert.equal(
          ((await mcp("workspace_get")).structuredContent as any).data
            .projects[0].id,
          project.id,
        );
      },
    );
    await t.test(
      "explicit MCP human-only calls and forged actors are rejected",
      async () => {
        assert.equal(
          ((await mcp("proposal_accept", {})).structuredContent as any).error
            .code,
          "human_ui_required",
        );
        assert.equal(
          (
            (
              await mcp("project_create", {
                operation_id: id(),
                title: "forged",
                channel: "ui",
                owner_id: owner,
              })
            ).structuredContent as any
          ).error.code,
          "validation_error",
        );
        await assert.rejects(workspace.executeUi("workspace_get", {}, id()), {
          code: "owner_forbidden",
        });
      },
    );
    await t.test(
      "generic database access cannot forge auth or bypass workspace approvals",
      async () => {
        for (const [schema, table] of [
          ["roman_workspace", "host_keys"],
          ["roman_workspace", "projects"],
          ["public", "outreach_owner_sessions"],
          ["public", "outreach_owners"],
          ["public", "outreach_mcp_logins"],
          ["pg_catalog", "pg_class"],
        ]) {
          await assert.rejects(databaseTools.readRows({ schema, table }), {
            code: "DATABASE_PERMISSION_DENIED",
          });
          await assert.rejects(
            databaseTools.writeRows({
              schema,
              table,
              operation: "insert",
              rows: [{ values: {} }],
            }),
            { code: "DATABASE_PERMISSION_DENIED" },
          );
        }
        const tables = (await databaseTools.listTables({})).tables;
        assert.ok(
          tables.every(
            (x: any) =>
              x.schema !== "roman_workspace" &&
              ![
                "outreach_owners",
                "outreach_owner_sessions",
                "outreach_mcp_logins",
              ].includes(x.table),
          ),
        );
      },
    );
    await t.test("large MCP files use the durable DB blob store", async () => {
      const bytes = Buffer.alloc(90000, 0x37);
      const result = await mcp("artifact_add", {
        operation_id: id(),
        work_item_id: task.id,
        title: "persisted",
        kind: "file",
        base64: bytes.toString("base64"),
      });
      assert.ok(!result.isError, JSON.stringify(result));
      artifact = (result.structuredContent as any).data;
      const row = (
        await h.db.pool.query("SELECT bytes FROM roman_workspace.host_blobs")
      ).rows[0];
      assert.deepEqual(row.bytes, bytes);
      assert.equal(
        (
          await h.db.pool.query(
            "SELECT count(*)::int AS n FROM public.artifacts",
          )
        ).rows[0].n,
        0,
      );
    });
    await t.test(
      "concurrent file writes cannot exhaust the owner transaction pool",
      { timeout: 10000 },
      async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            workspace.executeUi(
              "artifact_add",
              {
                operation_id: id(),
                work_item_id: task.id,
                title: `parallel-${index}`,
                kind: "file",
                base64: Buffer.from(
                  `parallel persisted bytes ${index}`,
                ).toString("base64"),
              },
              owner,
            ),
          ),
        );
        assert.equal(results.length, 8);
        assert.ok(results.every((result) => result.data.id));
      },
    );
    await t.test(
      "claims and execution tokens cannot be replayed through another MCP credential",
      async () => {
        const native = (
          await workspace.executeUi(
            "connector_register",
            {
              operation_id: id(),
              name: "Synthetic native dispatcher",
              origin: "platform",
              transport: "native",
              location: "native",
              metadata: {},
            },
            owner,
          )
        ).data;
        await workspace.executeUi(
          "capability_observe",
          {
            operation_id: id(),
            connector_id: native.id,
            executor_id: "native",
            capability: "native.dispatch",
            configured: true,
            reachable: true,
            authenticated: true,
            allowed: true,
            actions: ["dispatch"],
            observed_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
          owner,
        );
        const snapshot = (
          await workspace.executeUi(
            "context_prepare",
            {
              operation_id: id(),
              work_item_id: task.id,
              contract_revision: "host-test-1",
              requested_action: "discussion",
              executor_id: "native",
              input_refs: [],
              skill_versions: [],
              requirements: [],
            },
            owner,
          )
        ).data;
        const run = (
          await workspace.executeUi(
            "run_create",
            {
              operation_id: id(),
              snapshot_id: snapshot.id,
              kind: "discussion",
              executor_id: "native",
              trigger: "interactive",
            },
            owner,
          )
        ).data;
        const claim = {
          operation_id: id(),
          id: run.id,
          expected_revision: Number(run.revision),
          claimant_id: id(),
        };
        const result = await mcp("claim_run", claim);
        assert.ok(!result.isError, JSON.stringify(result));
        const value = result.structuredContent as any;
        executionToken = value.execution_token;
        executionSnapshot = snapshot.id;
        assert.equal(typeof executionToken, "string");
        const other = await app.access.addLogin(
          "################",
          "synthetic other credential",
        );
        const code = (r: any) => r.structuredContent.error.code;
        assert.equal(
          code(
            await workspace.callMcp(
              "workspace_context_get",
              { id: snapshot.id, execution_token: executionToken },
              other.id,
            ),
          ),
          "invalid_execution_token",
        );
        assert.equal(
          code(await workspace.callMcp("workspace_claim_run", claim, other.id)),
          "operation_conflict",
        );
        assert.equal(
          code(
            await workspace.callMcp(
              "workspace_claim_run",
              {
                ...claim,
                operation_id: id(),
                expected_revision: Number(value.data.revision),
              },
              other.id,
            ),
          ),
          "claim_conflict",
        );
        assert.ok(
          !(
            await workspace.callMcp("workspace_claim_run", claim, credential.id)
          ).isError,
        );
        assert.equal(
          (
            await workspace.callMcp(
              "workspace_context_get",
              { id: snapshot.id, execution_token: executionToken },
              credential.id,
            )
          ).structuredContent.data.id,
          snapshot.id,
        );
      },
    );
    await t.test(
      "reinitialization preserves workspace, files, and isolated migration ledgers",
      async () => {
        await workspace.close();
        workspace = await createWorkspaceGateway(config);
        const result = await workspace.executeUi("workspace_get", {}, owner);
        const boundContext = await workspace.callMcp(
          "workspace_context_get",
          { id: executionSnapshot, execution_token: executionToken },
          credential.id,
        );
        assert.ok(!boundContext.isError, JSON.stringify(boundContext));
        assert.equal(result.data.projects[0].id, project.id);
        const file = await workspace.executeUi(
          "artifact_get",
          { id: artifact.id },
          owner,
        );
        assert.ok(file.data);
        const ledger = await h.db.pool.query(
          "SELECT (SELECT count(*) FROM public.schema_migrations)::int AS public_n,(SELECT count(*) FROM roman_workspace.schema_migrations)::int AS workspace_n",
        );
        assert.equal(ledger.rows[0].public_n, 2);
        assert.equal(ledger.rows[0].workspace_n, 2);
      },
    );
    await t.test(
      "hosted backups restore into an empty separate schema without touching host state",
      async () => {
        const backup = (
          await workspace.executeUi("workspace_export", {}, owner)
        ).data;
        const { Database } = await import("../src/db.js");
        const target = new Database(h.url, {
          schema: "restore_workspace",
          migrationsDirectory: config.migrationsDirectory,
        });
        try {
          await target.migrate();
          await restoreExport(
            target,
            new PostgresBlobs(target, owner),
            owner,
            backup,
          );
          assert.equal(
            (await target.pool.query("SELECT title FROM projects")).rows[0]
              .title,
            "ЯКС",
          );
          assert.deepEqual(
            (
              await target.pool.query(
                "SELECT bytes FROM host_blobs WHERE octet_length(bytes)=90000",
              )
            ).rows[0].bytes,
            Buffer.alloc(90000, 0x37),
          );
        } finally {
          await target.close();
        }
      },
    );
    await t.test(
      "revoking the shared MCP login also revokes workspace access",
      async () => {
        await app.access.revokeLogin(credential.id);
        const denied = await mcp("workspace_get");
        assert.equal(denied.isError, true);
        assert.equal(
          (denied.structuredContent as any).code,
          "SERVICE_UNAVAILABLE",
        );
      },
    );
    await t.test(
      "revoking the host owner session blocks the owner API",
      async () => {
        await app.access.revokeSession(cookie.slice("ycs_session=".length));
        assert.equal(
          (
            await request(app.url + "/workspace/api/workspace", {
              headers: { cookie },
            })
          ).status,
          401,
        );
        assert.equal((await request(app.url + "/healthz")).status, 200);
      },
    );
  } finally {
    await client.close();
    await app.close();
    await workspace.close();
  }
});

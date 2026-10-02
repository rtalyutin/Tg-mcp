import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExternalMcpGateway } from "../src/external-mcp.js";
import { Auth } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { id, hash, DomainError } from "../src/db.js";
import { bytesHash } from "../src/storage.js";
import { harness } from "./harness.js";
import type { Actor } from "../src/service.js";

const error = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code;
test("external MCP: real HTTP SDK + PostgreSQL + scoped backend MCP", async (t) => {
  const h = await harness({ readyTasks: true });
  t.after(() => h.close());
  const token = "synthetic-provider-readonly-token";
  let calls = 0,
    hint = true,
    mode = "ok";
  let entered: (() => void) | undefined, release: (() => void) | undefined;
  const remote = Fastify();
  remote.post("/mcp", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`)
      return reply.code(401).send();
    if (mode === "redirect") return reply.redirect("http://127.0.0.1:1/steal");
    const server = new McpServer({ name: "synthetic-source", version: "1" });
    server.registerTool(
      "read_document",
      {
        inputSchema: { document_id: z.string(), format: z.literal("text") },
        annotations: { readOnlyHint: hint },
      },
      async (input) => {
        calls++;
        if (mode === "wait") {
          entered?.();
          await new Promise<void>((r) => {
            release = r;
          });
        }
        if (mode === "tool-error")
          return { isError: true, content: [{ type: "text", text: token }] };
        const text =
          mode === "large"
            ? "x".repeat(32000)
            : `Document ${input.document_id}: ${token}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            source: input.document_id,
            echoed_credential: token,
          },
        };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  await remote.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => remote.close());
  const connector = await h.call("connector_register", {
    operation_id: id(),
    name: "Synthetic documents",
    origin: "owned",
    transport: "http",
    location: "remote",
    metadata: { identity_ref: "synthetic:reader" },
  });
  const config = {
    servers: [
      {
        connector_id: connector.id,
        endpoint: remote.listeningOrigin + "/mcp",
        identity_ref: "synthetic:reader",
        token_env: "TEST_DOC_TOKEN",
        read_only_credentials: true,
        tools: [
          {
            name: "read_document",
            capability: "documents.read",
            resource_argument: "document_id",
            fixed_arguments: { format: "text" },
          },
        ],
      },
    ],
  };
  const gateway = () =>
    new ExternalMcpGateway(config, {
      env: { TEST_DOC_TOKEN: token },
      testLoopback: true,
      timeoutMs: 2000,
      maxResponseBytes: 8192,
    });
  h.service.runtime.external_mcp = gateway();
  const p = await h.call("project_create", {
    operation_id: id(),
    title: "ЯКС",
  });
  const w = await h.call("work_item_create", {
    operation_id: id(),
    project_id: p.id,
    title: "Прочитать материал",
  });
  const versions = [];
  for (const name of ["loki", "run-roman-control-loop"]) {
    const bytes = Buffer.from(`# ${name}\nSynthetic test fixture`),
      sha256 = bytesHash(bytes);
    const skill = await h.call("skill_register", {
      operation_id: id(),
      name,
      version: "test",
      origin: "owned",
      source_ref: "synthetic",
      requirements: [],
      triggers: [],
      files: [{ path: "SKILL.md", base64: bytes.toString("base64"), sha256 }],
      digest: hash([{ path: "SKILL.md", sha256 }]),
    });
    versions.push({ skill_id: skill.id, version_id: skill.version.id });
  }
  const permission = await h.call(
    "proposal_record",
    {
      operation_id: id(),
      project_id: p.id,
      work_item_id: w.id,
      kind: "permission",
      body: {
        statement: "Read selected document",
        actions: [`${connector.id}:documents.read:read`],
        resources: ["doc-1"],
      },
    },
    h.model,
  );
  await h.call("proposal_accept", {
    operation_id: id(),
    id: permission.id,
    expected_revision: Number(permission.revision),
    content_hash: hash(permission.body),
  });
  const observation = async (
    identity_ref = "synthetic:reader",
    expires = Date.now() + 300000,
  ) =>
    h.call("capability_observe", {
      operation_id: id(),
      connector_id: connector.id,
      executor_id: "worker",
      capability: "documents.read",
      configured: true,
      reachable: true,
      authenticated: true,
      allowed: true,
      identity_ref,
      actions: ["read"],
      observed_at: new Date().toISOString(),
      expires_at: new Date(expires).toISOString(),
    });
  await observation();
  const snapshot = await h.call("context_prepare", {
    operation_id: id(),
    work_item_id: w.id,
    requested_action: "execution",
    contract_revision: "synthetic-v1",
    executor_id: "worker",
    input_refs: [],
    skill_versions: versions,
    requirements: [
      {
        connector_id: connector.id,
        capability: "documents.read",
        action: "read",
      },
    ],
    authorization_refs: [permission.id],
    model: "test-model",
    budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
  });
  assert.equal(snapshot.preflight.available, true);
  async function claim() {
    const run = await h.call("run_create", {
      operation_id: id(),
      snapshot_id: snapshot.id,
      kind: "execution",
      executor_id: "worker",
      trigger: "manual",
    });
    const claimant = id(),
      worker: Actor = {
        owner_id: h.owner,
        channel: "worker",
        executor_id: "worker",
      };
    const claimed = await h.call(
      "claim_run",
      {
        operation_id: id(),
        id: run.id,
        expected_revision: Number(run.revision),
        claimant_id: claimant,
      },
      worker,
    );
    return {
      run: claimed,
      actor: {
        ...worker,
        run_id: run.id,
        attempt_id: claimed.attempt_id,
        claimant_id: claimant,
      },
    };
  }
  const { run, actor } = await claim();
  const read = (resource = "doc-1", a: Actor = actor) =>
    h.call(
      "external_mcp_read",
      { connector_id: connector.id, tool_name: "read_document", resource },
      a,
    );
  await t.test(
    "accepted resource reaches real MCP, fixed args, credential redacted",
    async () => {
      const result = await read();
      assert.equal(calls, 1);
      assert.equal(result.untrusted, true);
      assert.match(result.content[0].text, /doc-1/);
      assert.equal(result.structured_content.echoed_credential, "[redacted]");
      assert.equal(JSON.stringify(result).includes(token), false);
      const available = await h.call("capabilities_list", {}, actor);
      assert.equal(available[0].effective_available, true);
      assert.deepEqual(available[0].external_read_tools, [
        {
          name: "read_document",
          capability: "documents.read",
          action: "read",
          resource_required: true,
        },
      ]);
    },
  );
  await t.test(
    "unbound, resource, tool and attempt denials happen before network",
    async () => {
      const before = calls;
      await assert.rejects(
        read("doc-1", h.model),
        error("execution_scope_required"),
      );
      await assert.rejects(read("doc-2"), error("external_resource_denied"));
      await assert.rejects(
        h.call(
          "external_mcp_read",
          {
            connector_id: connector.id,
            tool_name: "delete_document",
            resource: "doc-1",
          },
          actor,
        ),
        error("external_tool_denied"),
      );
      await assert.rejects(
        read("doc-1", { ...actor, claimant_id: id() }),
        error("attempt_fenced"),
      );
      await assert.rejects(
        h.call(
          "external_mcp_read",
          {
            connector_id: connector.id,
            tool_name: "read_document",
            resource: "doc-1",
            arguments: { endpoint: "http://127.0.0.1" },
          },
          actor,
        ),
        /unrecognized_keys/,
      );
      assert.equal(calls, before);
    },
  );
  await t.test(
    "identity mismatch and missing credentials fail closed",
    async () => {
      const before = calls;
      await observation("other:reader");
      assert.equal(
        (await h.call("capabilities_list", {}, actor))[0].effective_available,
        false,
      );
      await assert.rejects(read(), error("external_capability_unavailable"));
      await observation();
      h.service.runtime.external_mcp = new ExternalMcpGateway(config, {
        env: {},
        testLoopback: true,
      });
      await assert.rejects(read(), error("external_credentials_unavailable"));
      h.service.runtime.external_mcp = gateway();
      assert.equal(calls, before);
    },
  );
  await t.test(
    "hint, redirect, oversized and tool errors do not become success or leak credentials",
    async () => {
      hint = false;
      await assert.rejects(read(), error("external_read_contract_unverified"));
      hint = true;
      for (const value of ["redirect", "large", "tool-error"]) {
        mode = value;
        await assert.rejects(
          read(),
          (e) =>
            e instanceof DomainError &&
            e.status === 502 &&
            !JSON.stringify(e).includes(token),
        );
      }
      mode = "ok";
    },
  );
  await t.test(
    "scoped execution token calls gateway through real backend MCP client",
    async () => {
      const auth = new Auth({
        ownerId: h.owner,
        ownerSubject: "synthetic",
        uiOrigin: "http://localhost:5173",
        production: false,
        signingSecret: "s".repeat(48),
        devModelToken: "m".repeat(48),
      });
      const backend = createServer(h.service, auth);
      await backend.listen({ host: "127.0.0.1", port: 0 });
      const client = new Client({ name: "test-worker", version: "1" });
      try {
        const scoped = await auth.executionToken(actor, run);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(backend.listeningOrigin + "/mcp"),
            { requestInit: { headers: { "X-Execution-Token": scoped } } },
          ),
        );
        const tools = await client.listTools();
        assert.equal(
          tools.tools.some((t) => t.name === "external_mcp_read"),
          true,
        );
        const result = await client.callTool({
          name: "external_mcp_read",
          arguments: {
            connector_id: connector.id,
            tool_name: "read_document",
            resource: "doc-1",
          },
        });
        assert.equal(result.isError, undefined);
        assert.match(JSON.stringify(result), /doc-1/);
        assert.equal(JSON.stringify(result).includes(token), false);
      } finally {
        await client.close();
        await backend.close();
      }
    },
  );
  await t.test(
    "cancel commits during external read and late response is discarded",
    async () => {
      mode = "wait";
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const pending = read();
      const rejected = assert.rejects(pending, error("external_run_inactive"));
      await ready;
      await h.call("run_cancel", {
        operation_id: id(),
        id: run.id,
        expected_revision: Number(run.revision),
      });
      release?.();
      await rejected;
      mode = "ok";
      const before = calls;
      await assert.rejects(read(), error("external_run_inactive"));
      assert.equal(calls, before);
    },
  );
  await t.test(
    "permission revocation blocks running successor; expired lease blocks before read",
    async () => {
      const next = await claim();
      await h.db.pool.query(
        "UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [next.run.id],
      );
      await assert.rejects(
        read("doc-1", next.actor),
        error("external_run_inactive"),
      );
      await h.db.pool.query(
        "UPDATE runs SET lease_until=now()+interval '2 minutes' WHERE id=$1",
        [next.run.id],
      );
      const accepted = await h.service.db.pool.query(
        "SELECT revision FROM proposals WHERE id=$1",
        [permission.id],
      );
      await h.call("proposal_revoke", {
        operation_id: id(),
        id: permission.id,
        expected_revision: Number(accepted.rows[0].revision),
        reason: "Synthetic test revoke",
      });
      const before = calls;
      await assert.rejects(
        read("doc-1", next.actor),
        error("external_resource_denied"),
      );
      assert.equal(calls, before);
    },
  );
  await t.test(
    "configuration rejects arbitrary URL auth, insecure endpoints and shadowed resource",
    async () => {
      for (const endpoint of [
        "http://example.com/mcp",
        "https://name:pass@example.com/mcp",
        "https://example.com/mcp?token=secret",
        "https://example.com/mcp#fragment",
      ])
        assert.throws(
          () =>
            new ExternalMcpGateway({
              servers: [{ ...config.servers[0], endpoint }],
            }),
        );
      assert.throws(
        () =>
          new ExternalMcpGateway(
            {
              servers: [
                {
                  ...config.servers[0],
                  tools: [
                    {
                      ...config.servers[0]!.tools[0],
                      fixed_arguments: { document_id: "other" },
                    },
                  ],
                },
              ],
            },
            { testLoopback: true },
          ),
      );
    },
  );
});

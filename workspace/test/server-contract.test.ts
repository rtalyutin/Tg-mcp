import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth } from "../src/auth.js";
import {
  schemas,
  humanOnly,
  workerAllowed,
  type Operation,
} from "../src/contracts.js";
import { DomainError } from "../src/db.js";
import { createServer } from "../src/server.js";
import type { WorkspaceService, Actor } from "../src/service.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";

const owner = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const claimantId = "55555555-5555-4555-8555-555555555555";
const origin = "http://localhost:3000";
const modelHeaders = { authorization: "Bearer development-model-token" };
const mcpHeaders = {
  ...modelHeaders,
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
};
const run = {
  id: runId,
  attempt_id: attemptId,
  executor_id: "native",
  revision: 2,
  status: "running",
};

function setup() {
  const auth = new Auth({
    ownerId: owner,
    ownerSubject: "subject",
    uiOrigin: origin,
    production: false,
    signingSecret: "local-test-signing-secret-32-characters",
    devHumanSecret: "human-bootstrap-secret",
    devModelToken: "development-model-token",
    workerToken: "development-worker-token",
  });
  const calls: Array<{ name: Operation; input: unknown; actor: Actor }> = [];
  const state: { failure?: Error; readyFailure?: Error; receipts: unknown[] } =
    { receipts: [] };
  const service = {
    db: {
      pool: {
        query: async (sql: string) => {
          assert.equal(sql, "SELECT 1");
          if (state.readyFailure) throw state.readyFailure;
          return { rows: [{ value: 1 }] };
        },
      },
    },
    execute: async (name: Operation, raw: unknown, actor: Actor) => {
      const input = schemas[name].parse(raw);
      calls.push({ name, input, actor });
      if (state.failure) throw state.failure;
      const receipt = { operation_id: operationId, replayed: false };
      const data = name === "claim_run" ? run : { id: runId, name };
      const response = {
        data,
        receipt,
        server_time: "2026-09-30T00:00:00.000Z",
      };
      state.receipts.push(response);
      return response;
    },
  } as unknown as WorkspaceService;
  return { app: createServer(service, auth), auth, calls, state };
}

function rpc(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

test("health/readiness expose no DB details and operations require authentication", async (t) => {
  const { app, calls, state } = setup();
  t.after(() => app.close());
  assert.deepEqual((await app.inject({ url: "/health" })).json(), {
    status: "ok",
  });
  assert.deepEqual((await app.inject({ url: "/ready" })).json(), {
    status: "ready",
  });
  state.readyFailure = new Error(
    "postgres://user:secret@internal-db/production",
  );
  const unavailable = await app.inject({ url: "/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { status: "unavailable" });
  const rejected = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    payload: {},
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(calls.length, 0);
  assert.equal(rejected.body.includes("secret"), false);
});

test("HTTP read operations keep service envelope and ignore no client identity fields", async (t) => {
  const { app, calls } = setup();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: modelHeaders,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.name, "workspace_get");
  assert.equal(response.json().receipt.operation_id, operationId);
  assert.deepEqual(calls[0]!.actor, {
    owner_id: owner,
    channel: "model",
    executor_id: "native",
  });
  const spoofed = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: modelHeaders,
    payload: { owner_id: "other-owner", channel: "ui", executor_id: "worker" },
  });
  assert.equal(spoofed.statusCode, 400);
  assert.equal(spoofed.json().error.code, "validation_error");
  assert.equal(calls.length, 1);
});

test("UI session bootstrap issues HttpOnly cookie and CSRF; model cannot bootstrap or perform human actions", async (t) => {
  const { app, calls } = setup();
  t.after(() => app.close());
  const modelBootstrap = await app.inject({
    method: "POST",
    url: "/api/ui/session",
    headers: { ...modelHeaders, origin },
    payload: {},
  });
  assert.equal(modelBootstrap.statusCode, 401);
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/ui/session",
    headers: { origin },
    payload: { bootstrap_secret: "human-bootstrap-secret" },
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.ok(String(bootstrap.headers["set-cookie"]).includes("HttpOnly"));
  assert.ok(
    String(bootstrap.headers["set-cookie"]).includes("SameSite=Strict"),
  );
  assert.equal(bootstrap.body.includes("workspace_ui="), false);
  const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0]!;
  const payload = {
    operation_id: operationId,
    id: runId,
    expected_revision: 1,
    reason: "Archive with permission.",
  };
  const model = await app.inject({
    method: "POST",
    url: "/api/operations/project_archive",
    headers: modelHeaders,
    payload,
  });
  assert.equal(model.statusCode, 403);
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/operations/project_archive",
    headers: { cookie, origin },
    payload,
  });
  assert.equal(noCsrf.statusCode, 403);
  const accepted = await app.inject({
    method: "POST",
    url: "/api/operations/project_archive",
    headers: { cookie, origin, "x-csrf-token": bootstrap.json().csrf_token },
    payload,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.actor.channel, "ui");
});

test("CORS allows exactly the configured origin and permitted preflight headers", async (t) => {
  const { app } = setup();
  t.after(() => app.close());
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/mcp",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "Authorization, MCP-Protocol-Version",
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  for (const bad of [
    "http://localhost:3000.evil.example",
    "null",
    `${origin}/`,
  ]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...mcpHeaders, origin: bad },
      payload: rpc("tools/list"),
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.headers["access-control-allow-origin"], undefined);
  }
  const badHeaders = await app.inject({
    method: "OPTIONS",
    url: "/mcp",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-client-owner",
    },
  });
  assert.equal(badHeaders.statusCode, 403);
});

test("schema introspection is authenticated and derives each operation schema from existing Zod contracts", async (t) => {
  const { app } = setup();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/schema" })).statusCode, 401);
  const response = await app.inject({
    url: "/api/schema",
    headers: modelHeaders,
  });
  assert.equal(response.statusCode, 200);
  const operations = response.json().operations;
  assert.ok(
    operations.every(
      (entry: { name: Operation }) => !humanOnly.has(entry.name),
    ),
  );
  const project = operations.find(
    (entry: { name: string }) => entry.name === "project_create",
  );
  const expected = toJsonSchemaCompat(
    schemas.project_create.extend({
      execution_token: z.string().min(1).max(8192).optional(),
    }),
    { strictUnions: true, pipeStrategy: "input" },
  );
  assert.deepEqual(project.input_schema, expected);
  assert.equal(project.input_schema.additionalProperties, false);
  assert.equal(project.input_schema.properties.operation_id.format, "uuid");
});

test("claim execution token is transport-only and bound to the returned run", async (t) => {
  const { app, auth, calls, state } = setup();
  t.after(() => app.close());
  const claim = await app.inject({
    method: "POST",
    url: "/api/operations/claim_run",
    headers: modelHeaders,
    payload: {
      operation_id: operationId,
      id: runId,
      expected_revision: 1,
      claimant_id: claimantId,
    },
  });
  assert.equal(claim.statusCode, 200);
  const token = claim.json().execution_token;
  assert.equal(typeof token, "string");
  assert.equal(JSON.stringify(state.receipts).includes(token), false);
  assert.equal(
    JSON.stringify(state.receipts).includes("execution_token"),
    false,
  );
  const readback = await app.inject({
    method: "POST",
    url: "/api/operations/run_get",
    payload: { id: runId, execution_token: token },
  });
  assert.equal(readback.statusCode, 200);
  assert.deepEqual(calls[1]!.input, { id: runId });
  assert.equal(calls[1]!.actor.run_id, runId);
  assert.equal(calls[1]!.actor.attempt_id, attemptId);
  assert.equal(calls[1]!.actor.channel, "model");
  const actor = await auth.actor({ headers: {} } as never, false, token);
  assert.equal(actor.owner_id, owner);
});

test("MCP stateless initialization uses installed SDK and authenticates each request", async (t) => {
  const { app } = setup();
  t.after(() => app.close());
  const initialize = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...mcpHeaders, origin },
    payload: rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "local-contract-test", version: "1.0.0" },
    }),
  });
  assert.equal(initialize.statusCode, 200);
  assert.equal(
    initialize.json().result.serverInfo.name,
    "shared-workspace-backend",
  );
  assert.equal(initialize.headers["mcp-session-id"], undefined);
  assert.equal(initialize.headers["access-control-allow-origin"], origin);
  const unauthed = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream" },
    payload: rpc("tools/list"),
  });
  assert.equal(unauthed.statusCode, 401);
  assert.equal(unauthed.json().error.message, "unauthenticated");
  assert.equal(
    (await app.inject({ url: "/mcp", headers: modelHeaders })).statusCode,
    405,
  );
});

test("MCP never advertises or executes human-only tools, including with valid UI cookie and CSRF", async (t) => {
  const { app, calls } = setup();
  t.after(() => app.close());
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/ui/session",
    headers: { origin },
    payload: { bootstrap_secret: "human-bootstrap-secret" },
  });
  const headers = {
    ...mcpHeaders,
    cookie: String(bootstrap.headers["set-cookie"]).split(";")[0]!,
    origin,
    "x-csrf-token": bootstrap.json().csrf_token,
  };
  const tools = await app.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: rpc("tools/list"),
  });
  assert.equal(tools.statusCode, 200);
  assert.ok(
    tools
      .json()
      .result.tools.every(
        (entry: { name: Operation }) => !humanOnly.has(entry.name),
      ),
  );
  const denied = await app.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: rpc("tools/call", {
      name: "proposal_accept",
      arguments: {
        operation_id: operationId,
        id: runId,
        expected_revision: 1,
        content_hash: "a".repeat(64),
      },
    }),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.message, "human_ui_required");
  assert.equal(calls.length, 0);
});

test("worker and run-bound MCP identity only see workerAllowed tools", async (t) => {
  const { app, auth, calls } = setup();
  t.after(() => app.close());
  const workerToken = await auth.executionToken(
    { owner_id: owner, channel: "worker", executor_id: "worker" },
    { ...run, executor_id: "worker" },
  );
  for (const headers of [
    { ...mcpHeaders, authorization: "Bearer development-worker-token" },
    { ...mcpHeaders, "x-execution-token": workerToken },
  ]) {
    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: rpc("tools/list"),
    });
    assert.equal(tools.statusCode, 200);
    assert.deepEqual(
      new Set(
        tools.json().result.tools.map((entry: { name: string }) => entry.name),
      ),
      workerAllowed,
    );
  }
  const denied = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...mcpHeaders, "x-execution-token": workerToken },
    payload: rpc("tools/call", { name: "workspace_export", arguments: {} }),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("MCP call strips transport token before service and uses verified actor instead of supplied identity", async (t) => {
  const { app, auth, calls } = setup();
  t.after(() => app.close());
  const token = await auth.executionToken(
    { owner_id: owner, channel: "model", executor_id: "native" },
    run,
  );
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: mcpHeaders,
    payload: rpc("tools/call", {
      name: "run_get",
      arguments: { id: runId, execution_token: token },
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().result.structuredContent.data.name, "run_get");
  assert.deepEqual(calls[0]!.input, { id: runId });
  assert.equal(calls[0]!.actor.run_id, runId);
  const spoofed = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: mcpHeaders,
    payload: rpc("tools/call", {
      name: "run_get",
      arguments: { id: runId, channel: "ui", owner_id: "secret-owner" },
    }),
  });
  assert.equal(spoofed.statusCode, 400);
  assert.equal(spoofed.body.includes("secret-owner"), false);
  assert.equal(calls.length, 1);
});

test("HTTP and MCP sanitize service failures while preserving revision conflict metadata", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  state.failure = new Error(
    "postgres://user:secret@db/schema\nSELECT hidden FROM credentials",
  );
  const http = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: modelHeaders,
    payload: {},
  });
  assert.equal(http.statusCode, 500);
  assert.equal(http.json().error.code, "internal_error");
  assert.equal(http.body.includes("secret"), false);
  const mcp = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: mcpHeaders,
    payload: rpc("tools/call", { name: "workspace_get", arguments: {} }),
  });
  assert.equal(mcp.statusCode, 200);
  assert.equal(mcp.json().result.isError, true);
  assert.equal(mcp.body.includes("credentials"), false);
  state.failure = new DomainError("revision_conflict", 409, {
    current_revision: 4,
    credential: "secret-token",
  });
  const conflict = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: modelHeaders,
    payload: {},
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().error.details, { current_revision: 4 });
  assert.equal(conflict.body.includes("secret-token"), false);
});

test("body limit is at most 16 MiB and malformed requests disclose no parser contents", async (t) => {
  const { app, calls } = setup();
  t.after(() => app.close());
  const oversized = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: { ...modelHeaders, "content-type": "application/json" },
    payload: "x".repeat(16 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "body_too_large");
  const invalid = await app.inject({
    method: "POST",
    url: "/api/operations/workspace_get",
    headers: { ...modelHeaders, "content-type": "application/json" },
    payload: '{"secret":"parser-secret"',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes("parser-secret"), false);
  assert.equal(calls.length, 0);
});

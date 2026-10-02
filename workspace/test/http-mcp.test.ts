import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import Fastify from "fastify";
import { createHmac } from "node:crypto";
import { Auth } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { registerWebhook } from "../src/webhook.js";
import { restoreExport } from "../src/backup.js";
import { id, hash } from "../src/db.js";
import { harness } from "./harness.js";

test("HTTP + real MCP client + signed webhook + JSON restore", async (t) => {
  const h = await harness({ readyTasks: true });
  t.after(() => h.close());
  const auth = new Auth({
    ownerId: h.owner,
    ownerSubject: "owner",
    uiOrigin: "http://localhost:5173",
    production: false,
    signingSecret: "s".repeat(48),
    devHumanSecret: "h".repeat(48),
    devModelToken: "m".repeat(48),
    workerToken: "w".repeat(48),
  });
  const app = createServer(h.service, auth);
  const secret = "whsec_" + Buffer.from("webhook-test-key").toString("base64");
  registerWebhook(app, h.service, h.owner, secret);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = app.listeningOrigin;
  const p = await h.call("project_create", {
    operation_id: id(),
    title: "ЯКС",
  });
  const w = await h.call("work_item_create", {
    operation_id: id(),
    project_id: p.id,
    title: "Действия",
  });
  await t.test(
    "human session cookie + CSRF and real valid model denial",
    async () => {
      const start = await app.inject({
        method: "POST",
        url: "/api/ui/session",
        headers: { origin: auth.config.uiOrigin },
        payload: { bootstrap_secret: auth.config.devHumanSecret },
      });
      assert.equal(start.statusCode, 200);
      const cookie = String(start.headers["set-cookie"]).split(";")[0]!;
      const token = start.json().csrf_token;
      // Explicit owner verification fixture; draft/task creation does not imply acceptance.
      const verified = await h.call("work_item_attributes_update", {
        operation_id: id(),
        id: w.id,
        expected_revision: Number(w.revision),
        reason: "TEST FIXTURE: owner checked the result",
        attributes: {
          execution_state: "executed",
          result_refs: ["test://completed-result"],
          verification_state: "accepted",
          verified_by: "TEST FIXTURE: independent reviewer",
          verification_evidence: ["test://completion-check"],
        },
      });
      const payload = {
        operation_id: id(),
        id: w.id,
        expected_revision: Number(verified.revision),
        reason: "Проверено",
        evidence: [],
        manual_assessment: true,
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/operations/work_item_complete",
            headers: { cookie, origin: auth.config.uiOrigin },
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/operations/work_item_complete",
            headers: { authorization: "Bearer " + auth.config.devModelToken },
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/operations/work_item_complete",
            headers: {
              cookie,
              origin: auth.config.uiOrigin,
              "x-csrf-token": token,
            },
            payload,
          })
        ).statusCode,
        200,
      );
    },
  );
  await t.test(
    "MCP official client initialization/list/call and read effect",
    async () => {
      const client = new Client({ name: "integration", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(base + "/mcp"),
        {
          requestInit: {
            headers: { Authorization: "Bearer " + auth.config.devModelToken },
          },
        },
      );
      await client.connect(transport);
      const list = await client.listTools();
      assert.ok(list.tools.some((x) => x.name === "workspace_get"));
      assert.ok(!list.tools.some((x) => x.name === "proposal_accept"));
      const got = await client.callTool({
        name: "workspace_get",
        arguments: {},
      });
      assert.equal(got.isError, undefined);
      assert.ok(JSON.stringify(got).includes("ЯКС"));
      await client.close();
      assert.equal(
        (await h.db.pool.query("SELECT count(*)::int n FROM runs")).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    "signed webhook rejects tamper, deduplicates, idle never succeeds",
    async () => {
      const raw = JSON.stringify({
        id: "evt_test",
        type: "agent.session.idle",
        data: { id: "sess_unknown" },
      });
      const ts = String(Math.floor(Date.now() / 1000)),
        key = Buffer.from(secret.slice(6), "base64");
      const sig =
        "v1," +
        createHmac("sha256", key)
          .update("wh_test." + ts + "." + raw)
          .digest("base64");
      const headers = {
        "content-type": "application/json",
        "webhook-id": "wh_test",
        "webhook-timestamp": ts,
        "webhook-signature": sig,
      };
      const a = await app.inject({
        method: "POST",
        url: "/webhooks/openai",
        headers,
        payload: raw,
      });
      assert.equal(a.statusCode, 200, a.body);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/openai",
            headers,
            payload: raw,
          })
        ).json().replayed,
        true,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/openai",
            headers,
            payload: raw + " ",
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (await h.db.pool.query("SELECT count(*)::int n FROM runs")).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    "JSON export integrity survives serialization and restores empty DB",
    async () => {
      await h.call("artifact_add", {
        operation_id: id(),
        work_item_id: w.id,
        title: "binary",
        kind: "file",
        base64: Buffer.from("exact").toString("base64"),
      });
      const backup = JSON.parse(
        JSON.stringify(await h.call("workspace_export")),
      );
      assert.equal(hash(backup.data), backup.manifest.metadata_hash);
      const target = await harness({ readyTasks: true });
      try {
        await target.db.tx(target.owner, async (c) => {
          await c.query("DELETE FROM entity_parameter_options");
          await c.query("DELETE FROM entity_parameters");
          await c.query("DELETE FROM workspaces");
        });
        await restoreExport(target.db, target.service.blobs, h.owner, backup);
        const count = (
          await target.db.pool.query("SELECT count(*)::int n FROM projects")
        ).rows[0].n;
        assert.equal(count, 1);
        const restored = await target.service.execute(
          "workspace_export",
          {},
          h.ui,
        );
        assert.equal(
          restored.data.manifest.metadata_hash,
          backup.manifest.metadata_hash,
        );
        await assert.rejects(
          restoreExport(target.db, target.service.blobs, h.owner, backup),
          /restore_requires_empty_database/,
        );
      } finally {
        await target.close();
      }
    },
  );
});

test("JWT cryptography, audience, owner and authorized UI client", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const issuer = Fastify();
  issuer.get("/jwks", async () => ({ keys: [jwk] }));
  await issuer.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => issuer.close());
  const owner = id(),
    url = issuer.listeningOrigin;
  const auth = new Auth({
    ownerId: owner,
    ownerSubject: "owner",
    uiOrigin: "http://localhost:5173",
    production: false,
    signingSecret: "k".repeat(48),
    model: { issuer: url, audience: "model", jwks: url + "/jwks" },
    ui: { issuer: url, audience: "ui", jwks: url + "/jwks", clientId: "pane" },
  });
  const token = (aud: string, sub = "owner", azp = "pane") =>
    new SignJWT({ azp })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(url)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(privateKey);
  const req = (jwt: string) =>
    ({
      headers: { authorization: "Bearer " + jwt, origin: auth.config.uiOrigin },
      body: {},
    }) as any;
  assert.equal((await auth.actor(req(await token("model")))).channel, "model");
  await assert.rejects(
    auth.actor(req(await token("model", "other"))),
    /unauthenticated/,
  );
  await assert.rejects(auth.actor(req(await token("ui"))), /unauthenticated/);
  await assert.rejects(
    auth.uiSession(req(await token("model"))),
    /unauthenticated/,
  );
  await assert.rejects(
    auth.uiSession(req(await token("ui", "owner", "other-client"))),
    /ui_client_required/,
  );
  assert.ok(
    (await auth.uiSession(req(await token("ui")))).cookie.includes("HttpOnly"),
  );
});

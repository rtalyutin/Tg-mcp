import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OpenAIUiToolMetadataSchema,
  OpenAIUiResourceMetadataSchema,
} from "@openai/mcp-extensions/server";
import {
  startLocalOutreach,
  type WorkspaceRoute,
} from "../src/outreach/server.ts";
import { workspaceResourceUri } from "../src/workspace-web.ts";

test("workspace view: authenticated MCP resources, owner API isolation and data-free shell", async () => {
  const calls: { name: string; channel: string }[] = [];
  const value = {
    data: {
      workspace: { title: "Synthetic owner" },
      projects: [],
      attention: [],
      active_runs: [],
    },
    server_time: "2026-10-01T09:00:00Z",
  };
  const workspace: WorkspaceRoute = {
    ownerId: "synthetic-owner",
    definitions: [
      {
        name: "workspace_workspace_get",
        description: "Read",
        inputSchema: { type: "object", properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    ],
    status: () => ({ enabled: true }),
    uiSchema: () => ({}),
    async executeUi(name) {
      calls.push({ name, channel: "ui" });
      return value;
    },
    async callMcp(name, input) {
      calls.push({ name, channel: "model" });
      return Object.keys(input as object).length
        ? {
            isError: true,
            content: [],
            structuredContent: { error: { code: "validation_error" } },
          }
        : {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
    },
    error: () => ({ status: 500, body: {} }),
    async close() {},
  };
  const app = await startLocalOutreach({ pool: {} as pg.Pool, workspace });
  app.access.admitIp = async () => ({ allowed: true, retryAfter: 0 });
  app.access.recordAccess = async () => {};
  app.access.recordRateRejection = async () => {};
  app.access.authenticateLogin = async (secret) =>
    secret === "!!!!!!!!!!!!!!!!" ? { id: "synthetic-credential" } : null;
  app.access.getSession = async (token) =>
    token === "synthetic-session"
      ? { ownerId: "synthetic-owner", csrfToken: "synthetic-csrf" }
      : token === "another-owner"
        ? { ownerId: "another-owner", csrfToken: "synthetic-csrf" }
        : null;
  const client = new Client({ name: "workspace-view-test", version: "1" });
  const denied = new Client({ name: "workspace-denied-test", version: "1" });
  try {
    const shell = await fetch(app.url + "/workspace");
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /<html lang="ru">/);
    assert.doesNotMatch(
      html,
      /synthetic-owner|synthetic-session|synthetic-csrf|Анонс первого тура/,
    );
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const css = html.match(/<style>([\s\S]*)<\/style>/)![1]!;
    const hash = (s: string) => createHash("sha256").update(s).digest("base64");
    assert.ok(
      shell.headers
        .get("content-security-policy")!
        .includes(`script-src 'sha256-${hash(script)}'`),
    );
    assert.ok(
      shell.headers
        .get("content-security-policy")!
        .includes(`style-src 'sha256-${hash(css)}'`),
    );
    assert.equal(
      (await fetch(app.url + "/workspace/../../package.json")).status,
      503,
    );
    assert.equal(
      (await fetch(app.url + "/workspace/?login=secret")).status,
      404,
    );
    assert.equal(
      (await fetch(app.url + "/workspace/api/workspace")).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.url + "/workspace/api/workspace", {
          headers: { cookie: "ycs_session=another-owner" },
        })
      ).status,
      401,
    );
    const owner = { cookie: "ycs_session=synthetic-session" };
    const read = await fetch(app.url + "/workspace/api/workspace", {
      headers: owner,
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), value);
    assert.equal(
      (
        await fetch(app.url + "/workspace/api/operations/project_create", {
          method: "POST",
          headers: {
            ...owner,
            origin: app.url,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(app.url + "/mcp?login=!!!!!!!!!!!!!!!!"),
      ),
    );
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "workspace_open_projects",
    )!;
    assert.ok(tool);
    OpenAIUiToolMetadataSchema.parse(tool._meta!["openai/ui"]);
    assert.equal(
      (tool._meta!.ui as { resourceUri: string }).resourceUri,
      workspaceResourceUri,
    );
    assert.ok(
      (await client.listResources()).resources.some(
        (r) => r.uri === workspaceResourceUri,
      ),
    );
    const resource = await client.readResource({ uri: workspaceResourceUri });
    const metadata = resource.contents[0]!._meta!["openai/ui"];
    OpenAIUiResourceMetadataSchema.parse(metadata);
    assert.deepEqual(
      (metadata as { availableDisplayModes: string[] }).availableDisplayModes,
      ["fullscreen"],
    );
    assert.equal(resource.contents[0]!.mimeType, "text/html;profile=mcp-app");
    assert.ok("text" in resource.contents[0]!);
    assert.equal(resource.contents[0]!.text, html);
    await assert.rejects(client.readResource({ uri: "file:///etc/passwd" }));
    const before = calls.length;
    const opened = await client.callTool({
      name: "workspace_open_projects",
      arguments: {},
    });
    assert.notEqual(opened.isError, true);
    assert.deepEqual(calls.slice(before), [
      { name: "workspace_workspace_get", channel: "model" },
    ]);
    await denied.connect(
      new StreamableHTTPClientTransport(
        new URL(app.url + "/mcp?login=????????????????"),
      ),
    );
    assert.deepEqual((await denied.listResources()).resources, []);
    await assert.rejects(denied.readResource({ uri: workspaceResourceUri }));
    assert.ok(
      !(await denied.listTools()).tools.some(
        (t) => t.name === "workspace_open_projects",
      ),
    );
  } finally {
    await client.close();
    await denied.close();
    await app.close();
  }
});

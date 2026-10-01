import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

export const workspaceResourceUri = "ui://workspace/projects-v1.html";
export const workspaceProjectsTool = {
  name: "workspace_open_projects",
  title: "Проекты и внимание",
  description:
    "Open the shared workspace projects and attention screen. Shows state only; does not launch AI work.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: {
    ui: { resourceUri: workspaceResourceUri, visibility: ["model", "app"] },
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
  },
};
export const workspaceAppOperations = new Set(
  [
    "workspace_get",
    "project_get",
    "work_item_get",
    "artifact_get",
    "search",
    "attention_list",
    "operation_status_get",
    "project_create",
  ].map((name) => "workspace_" + name),
);
export const workspaceResources = [
  {
    uri: workspaceResourceUri,
    name: "workspace-projects",
    title: "Проекты и внимание",
    mimeType: "text/html;profile=mcp-app",
  },
];
const asset = (name: string) =>
  new URL(`../workspace/ui/dist/${name}`, import.meta.url);
export async function readWorkspaceResource() {
  const text = await readFile(asset("index.html"), "utf8");
  return {
    contents: [
      {
        uri: workspaceResourceUri,
        mimeType: "text/html;profile=mcp-app",
        text,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [] },
            prefersBorder: false,
          },
          "openai/ui": {
            availableDisplayModes: ["fullscreen"],
            preferredDisplayMode: "fullscreen",
          },
          "openai/widgetDescription":
            "Личное рабочее пространство: проекты, внимание и текущая работа. Открытие объекта показывает состояние без запуска.",
        },
      },
    ],
  };
}
/** A public data-free shell; every data request still requires the owner session. */
export async function serveWorkspaceWeb(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.url !== "/workspace" && req.url !== "/workspace/") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  const [html, csp] = await Promise.all([
    readFile(asset("index.html")),
    readFile(asset("csp.txt"), "utf8"),
  ]);
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": html.length,
  });
  res.end(req.method === "HEAD" ? undefined : html);
}

import { App } from "@modelcontextprotocol/ext-apps";
import { unwrap, serverError } from "./model.js";

export async function connectTransport({ onInitial, onFailure }) {
  // The MCP view contains no host cookies, MCP login, tokens or network endpoints.
  if (window.parent !== window) {
    const app = new App(
      { name: "Совместная работа", version: "1.1.0" },
      { availableDisplayModes: ["fullscreen"] },
      { autoResize: false },
    );
    app.ontoolresult = (result) => {
      try {
        onInitial(unwrap(result));
      } catch (error) {
        onFailure(error);
      }
    };
    await app.connect();
    const context = app.getHostContext();
    if (
      context?.displayMode !== "fullscreen" &&
      context?.availableDisplayModes?.includes("fullscreen")
    ) {
      await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
    }
    return {
      mode: "plugin",
      read: async (operation, args = {}) =>
        unwrap(
          await app.callServerTool({
            name: `workspace_${operation}`,
            arguments: args,
          }),
        ),
      create: async (args) =>
        unwrap(
          await app.callServerTool({
            name: "workspace_project_create",
            arguments: args,
          }),
        ),
      close: () => app.close(),
    };
  }
  let csrf;
  const request = async (url, init = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    if (response.status === 401) throw new Error("auth_required");
    const body = await response.json();
    if (!response.ok)
      throw serverError(
        body.error,
        response.status === 403 ? "access_denied" : "service_unavailable",
      );
    return body;
  };
  const session = await request("/workspace/api/session");
  csrf = session.csrf_token;
  const read = async (operation, args = {}) =>
    operation === "workspace_get"
      ? unwrap(await request("/workspace/api/workspace"))
      : unwrap(
          await request(`/workspace/api/operations/${operation}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf,
            },
            body: JSON.stringify(args),
          }),
        );
  return {
    mode: "web",
    read,
    create: (args) => read("project_create", args),
    close() {},
  };
}

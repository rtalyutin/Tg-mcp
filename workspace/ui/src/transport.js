import { App } from "@modelcontextprotocol/ext-apps";
import { unwrap, serverError } from "./model.js";

const readTimeout = 20000;
// Command deadlines and receipt recovery must retain their existing semantics.
const timedReads = new Set([
  "workspace_get",
  "project_get",
  "work_item_get",
  "artifact_get",
  "search",
  "attention_list",
  "operation_status_get",
  "work_item_attributes_get",
  "task_parameter_list",
]);

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
    await app.connect(undefined, { timeout: readTimeout });
    const context = app.getHostContext();
    if (
      context?.displayMode !== "fullscreen" &&
      context?.availableDisplayModes?.includes("fullscreen")
    ) {
      // Display acknowledgement is optional; data reads must not wait for it.
      void app
        .requestDisplayMode({ mode: "fullscreen" }, { timeout: 3000 })
        .catch(() => {});
    }
    return {
      mode: "plugin",
      read: async (operation, args = {}) =>
        unwrap(
          await app.callServerTool(
            {
              name: `workspace_${operation}`,
              arguments: args,
            },
            timedReads.has(operation)
              ? {
                  timeout: readTimeout,
                  maxTotalTimeout: readTimeout,
                  resetTimeoutOnProgress: false,
                }
              : undefined,
          ),
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
  const request = async (url, init = {}, timed = true) => {
    const controller = timed ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), readTimeout)
      : undefined;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 401) throw new Error("auth_required");
      const body = await response.json();
      if (!response.ok)
        throw serverError(
          body.error,
          response.status === 403 ? "access_denied" : "service_unavailable",
        );
      return body;
    } catch (error) {
      if (controller?.signal.aborted) throw new Error("loading_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const session = await request("/workspace/api/session");
  csrf = session.csrf_token;
  const read = async (operation, args = {}) =>
    operation === "workspace_get"
      ? unwrap(await request("/workspace/api/workspace"))
      : unwrap(
          await request(
            `/workspace/api/operations/${operation}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-csrf-token": csrf,
              },
              body: JSON.stringify(args),
            },
            timedReads.has(operation),
          ),
        );
  return {
    mode: "web",
    read,
    create: (args) => read("project_create", args),
    close() {},
  };
}

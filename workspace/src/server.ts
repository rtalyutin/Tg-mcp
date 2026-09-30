import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  schemas,
  reads,
  humanOnly,
  workerAllowed,
  type Operation,
} from "./contracts.js";
import { DomainError } from "./db.js";
import type { WorkspaceService, Actor } from "./service.js";
import type { Auth } from "./auth.js";

const BODY_LIMIT = 16 * 1024 * 1024;
const tokenSchema = z.string().min(1).max(8192);
const bootstrapSchema = z
  .object({ bootstrap_secret: tokenSchema.optional() })
  .strict();
const names = Object.keys(schemas) as Operation[];
const transportSchemas = Object.fromEntries(
  names.map((name) => [
    name,
    schemas[name].extend({ execution_token: tokenSchema.optional() }),
  ]),
) as Record<Operation, z.AnyZodObject>;
const CORS_HEADERS = [
  "authorization",
  "content-type",
  "x-csrf-token",
  "x-execution-token",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function operation(value: unknown): Operation {
  if (typeof value !== "string" || !Object.hasOwn(schemas, value))
    throw new DomainError("unknown_operation", 404);
  return value as Operation;
}

function stripTransport(raw: unknown): { input: unknown; token?: string } {
  if (!object(raw)) return { input: raw };
  const { execution_token, ...input } = raw;
  if (execution_token === undefined) return { input };
  const parsed = tokenSchema.safeParse(execution_token);
  if (!parsed.success) throw new DomainError("invalid_execution_token", 401);
  return { input, token: parsed.data };
}

function executionToken(
  req: FastifyRequest,
  bodyToken?: string,
): string | undefined {
  const header = req.headers["x-execution-token"];
  if (
    header !== undefined &&
    (typeof header !== "string" || !tokenSchema.safeParse(header).success)
  ) {
    throw new DomainError("invalid_execution_token", 401);
  }
  if (header !== undefined && bodyToken !== undefined && header !== bodyToken) {
    throw new DomainError("execution_token_conflict", 400);
  }
  return bodyToken ?? header;
}

function allowed(name: Operation, actor: Actor, mcp: boolean): void {
  // Authentication establishes identity. Client-provided owner/channel/executor fields never do.
  if (humanOnly.has(name) && (mcp || actor.channel !== "ui"))
    throw new DomainError("human_ui_required", 403);
  if (
    (actor.channel === "worker" || actor.run_id) &&
    !workerAllowed.has(name)
  ) {
    throw new DomainError("execution_scope_denied", 403);
  }
}

function visible(actor: Actor, mcp: boolean): Operation[] {
  return names.filter(
    (name) =>
      !(humanOnly.has(name) && (mcp || actor.channel !== "ui")) &&
      !(
        (actor.channel === "worker" || actor.run_id) &&
        !workerAllowed.has(name)
      ),
  );
}

function safeError(error: unknown): {
  status: number;
  code: string;
  details?: { current_revision: number };
} {
  if (error instanceof ZodError)
    return { status: 400, code: "validation_error" };
  if (error instanceof DomainError) {
    const code = /^[a-z][a-z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : "operation_rejected";
    const status =
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 400;
    const current = error.details.current_revision;
    return {
      status,
      code,
      ...(typeof current === "number" &&
      Number.isSafeInteger(current) &&
      current >= 0
        ? { details: { current_revision: current } }
        : {}),
    };
  }
  if (object(error) && error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
    return { status: 413, code: "body_too_large" };
  if (
    object(error) &&
    (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
  ) {
    return { status: 400, code: "invalid_json" };
  }
  if (object(error) && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
    return { status: 415, code: "unsupported_media_type" };
  return { status: 500, code: "internal_error" };
}

function errorBody(error: ReturnType<typeof safeError>) {
  return {
    error: {
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    },
    server_time: new Date().toISOString(),
  };
}

function rpcError(error: ReturnType<typeof safeError>) {
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: error.status === 401 ? -32001 : -32000,
      message: error.code,
    },
  };
}

async function execute(
  service: WorkspaceService,
  auth: Auth,
  name: Operation,
  input: unknown,
  actor: Actor,
) {
  // The operation receipt and audit are committed before a transport credential is minted.
  const result = await service.execute(name, input, actor);
  if (name !== "claim_run") return result;
  return {
    ...result,
    execution_token: await auth.executionToken(actor, result.data),
  };
}

/**
 * HTTP factory only: deployment must provide HTTPS and the configured, distinct auth audiences.
 * No remote host authentication is established by constructing this server.
 * MCP SDK 1.31 owns Streamable HTTP framing and schema conversion; every request gets a fresh stateless transport.
 */
export function createServer(
  service: WorkspaceService,
  auth: Auth,
): FastifyInstance {
  let uiOrigin: URL;
  try {
    uiOrigin = new URL(auth.config.uiOrigin);
  } catch {
    throw new Error("Invalid configured UI origin");
  }
  if (
    !["http:", "https:"].includes(uiOrigin.protocol) ||
    uiOrigin.origin !== auth.config.uiOrigin ||
    uiOrigin.username ||
    uiOrigin.password
  )
    throw new Error("Invalid configured UI origin");

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
  });
  const activeMcp = new Set<McpServer>();

  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== auth.config.uiOrigin)
      throw new DomainError("origin_forbidden", 403);
    if (origin !== undefined) {
      reply
        .header("Access-Control-Allow-Origin", auth.config.uiOrigin)
        .header("Access-Control-Allow-Credentials", "true")
        .header("Vary", "Origin")
        .header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const safe = safeError(error);
    reply
      .code(safe.status)
      .send(
        req.url.split("?")[0] === "/mcp" ? rpcError(safe) : errorBody(safe),
      );
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send(errorBody({ status: 404, code: "not_found" })),
  );

  app.options("/*", async (req, reply) => {
    if (req.headers.origin !== auth.config.uiOrigin)
      throw new DomainError("origin_forbidden", 403);
    const method = req.headers["access-control-request-method"];
    if (
      !["GET", "POST", "DELETE"].includes(
        typeof method === "string" ? method : "",
      )
    ) {
      throw new DomainError("cors_method_forbidden", 403);
    }
    const requested = req.headers["access-control-request-headers"];
    if (
      requested !== undefined &&
      (typeof requested !== "string" ||
        requested
          .split(",")
          .some(
            (header) => !CORS_HEADERS.includes(header.trim().toLowerCase()),
          ))
    ) {
      throw new DomainError("cors_headers_forbidden", 403);
    }
    return reply
      .header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
      .header("Access-Control-Allow-Headers", CORS_HEADERS.join(", "))
      .code(204)
      .send();
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    try {
      await service.db.pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post("/api/ui/session", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    bootstrapSchema.parse(req.body ?? {});
    const session = await auth.uiSession(req);
    return reply
      .header("Set-Cookie", session.cookie)
      .send({ csrf_token: session.csrf_token });
  });

  app.get("/api/schema", async (req) => {
    const actor = await auth.actor(req, false, executionToken(req));
    return {
      operations: visible(actor, false).map((name) => ({
        name,
        input_schema: toJsonSchemaCompat(transportSchemas[name], {
          strictUnions: true,
          pipeStrategy: "input",
        }),
        read_only: reads.has(name),
        human_only: humanOnly.has(name),
      })),
    };
  });

  app.post<{ Params: { name: string } }>(
    "/api/operations/:name",
    async (req) => {
      const name = operation(req.params.name);
      const transport = stripTransport(req.body ?? {});
      const actor = await auth.actor(
        req,
        !reads.has(name),
        executionToken(req, transport.token),
      );
      allowed(name, actor, false);
      return execute(service, auth, name, transport.input, actor);
    },
  );

  app.post("/mcp", async (req, reply) => {
    const body = object(req.body) ? req.body : undefined;
    let name: Operation | undefined;
    let transport: ReturnType<typeof stripTransport> | undefined;
    if (body?.method === "tools/call") {
      if (!object(body.params)) throw new DomainError("validation_error");
      name = operation(body.params.name);
      transport = stripTransport(body.params.arguments ?? {});
    }
    const actor = await auth.actor(
      req,
      name !== undefined && !reads.has(name),
      executionToken(req, transport?.token),
    );
    if (name !== undefined) {
      allowed(name, actor, true);
      // Prevent SDK validation errors from reflecting sensitive values in malformed arguments.
      schemas[name].parse(transport!.input);
    }
    const mcp = new McpServer({
      name: "shared-workspace-backend",
      version: "1.0.0",
    });
    for (const toolName of visible(actor, true)) {
      mcp.registerTool(
        toolName,
        {
          description: `Workspace operation: ${toolName}`,
          inputSchema: transportSchemas[toolName],
          annotations: {
            readOnlyHint: reads.has(toolName),
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const raw = stripTransport(args);
            allowed(toolName, actor, true);
            const result = await execute(
              service,
              auth,
              toolName,
              raw.input,
              actor,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            const safe = errorBody(safeError(error));
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(safe) }],
              structuredContent: safe,
            };
          }
        },
      );
    }
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: BODY_LIMIT,
    });
    activeMcp.add(mcp);
    const cleanup = () => {
      activeMcp.delete(mcp);
      void mcp.close().catch(() => undefined);
    };
    reply.raw.once("close", cleanup);
    reply.raw.once("finish", cleanup);
    try {
      await mcp.connect(http);
      // Hijacked responses skip Fastify's serialization; copy the security/CORS headers first.
      for (const [key, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(key, value);
      reply.hijack();
      await http.handleRequest(req.raw, reply.raw, req.body);
    } catch (error) {
      cleanup();
      if (!reply.raw.headersSent) {
        const safe = safeError(error);
        reply.raw.writeHead(safe.status, {
          "Content-Type": "application/json",
        });
        reply.raw.end(JSON.stringify(rpcError(safe)));
      } else if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  const noStream = async (req: FastifyRequest, reply: FastifyReply) => {
    await auth.actor(req, false, executionToken(req));
    return reply
      .header("Allow", "POST")
      .code(405)
      .send(rpcError({ status: 405, code: "method_not_allowed" }));
  };
  app.get("/mcp", noStream);
  app.delete("/mcp", noStream);
  app.addHook("onClose", async () => {
    await Promise.all(
      [...activeMcp].map((mcp) => mcp.close().catch(() => undefined)),
    );
  });
  return app;
}

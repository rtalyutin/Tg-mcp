import { randomBytes, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SignJWT, jwtVerify } from "jose";
import { z, ZodError } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { Database, DomainError } from "./db.js";
import { schemas, humanOnly, reads, type Operation } from "./contracts.js";
import { WorkspaceService, type Actor } from "./service.js";
import { PostgresBlobs } from "./postgres-blobs.js";

const names = Object.keys(schemas) as Operation[];
const token = z.string().min(1).max(8192);
export function hostError(error: unknown) {
  const code =
    error instanceof ZodError
      ? "validation_error"
      : error instanceof DomainError &&
          /^[a-z][a-z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : "internal_error";
  const status =
    error instanceof ZodError
      ? 400
      : error instanceof DomainError
        ? error.status
        : 500;
  const revision =
    error instanceof DomainError ? error.details.current_revision : undefined;
  return {
    status,
    body: {
      error: {
        code,
        ...(typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision >= 0
          ? { details: { current_revision: revision } }
          : {}),
      },
      server_time: new Date().toISOString(),
    },
  };
}

/** Only the host authenticates owners/login credentials; no second login, listener or account. */
export async function createWorkspaceGateway(config: {
  databaseUrl: string;
  ownerId: string;
  migrationsDirectory: string;
}) {
  if (!z.string().uuid().safeParse(config.ownerId).success)
    throw new Error("invalid_workspace_owner");
  const db = new Database(config.databaseUrl, {
    schema: "roman_workspace",
    migrationsDirectory: config.migrationsDirectory,
    max: 3,
  });
  // Waiting owner transactions must not consume the connection needed by the
  // current writer to persist a blob. Separate pools keep the total at four.
  const blobDb = new Database(config.databaseUrl, {
    schema: "roman_workspace",
    max: 1,
  });
  try {
    await db.migrate();
    await db.pool.query(
      "INSERT INTO host_keys(name,secret) VALUES('execution_signing',$1) ON CONFLICT(name) DO NOTHING",
      [randomBytes(32).toString("base64url")],
    );
    const secret = (
      await db.pool.query(
        "SELECT secret FROM host_keys WHERE name='execution_signing'",
      )
    ).rows[0]?.secret;
    if (typeof secret !== "string" || secret.length < 43)
      throw new Error("workspace_signing_key_missing");
    const key = new TextEncoder().encode(secret);
    const service = new WorkspaceService(
      db,
      new PostgresBlobs(blobDb, config.ownerId),
      {
        worker_ready: false,
        capability_max_age_ms: 600000,
      },
    );
    await service.init(config.ownerId);
    const build = JSON.parse(
      await readFile(new URL("../build-info.json", import.meta.url), "utf8"),
    );
    if (
      build.version !== "1.0.5" ||
      !/^[a-f0-9]{64}$/.test(build.source_digest)
    )
      throw new Error("workspace_build_info_invalid");
    const status = () => ({
      enabled: true,
      version: build.version,
      source_digest: build.source_digest,
      schema: "roman_workspace",
      auth: "host",
      worker_ready: false,
    });
    const definitions = names
      .filter((name) => !humanOnly.has(name))
      .map((name) => ({
        name: "workspace_" + name,
        description: `${name}: shared project workspace. Confirmations require the owner's web UI.`,
        inputSchema: toJsonSchemaCompat(
          schemas[name].extend({ execution_token: token.optional() }),
          { strictUnions: true },
        ) as { type: "object"; [key: string]: unknown },
        annotations: {
          readOnlyHint: reads.has(name),
          destructiveHint: false,
          openWorldHint: name === "external_mcp_read",
        },
      }));
    definitions.unshift({
      name: "workspace_host_status",
      description:
        "Read workspace hosting version and availability; no secrets.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
    const uiSchema = () =>
      Object.fromEntries(
        names.map((name) => [
          name,
          toJsonSchemaCompat(schemas[name], { strictUnions: true }),
        ]),
      );
    const executeUi = async (name: string, input: unknown, ownerId: string) => {
      if (ownerId !== config.ownerId)
        throw new DomainError("owner_forbidden", 403);
      if (!Object.hasOwn(schemas, name))
        throw new DomainError("unknown_operation", 404);
      return service.execute(name as Operation, input, {
        owner_id: ownerId,
        channel: "ui",
        executor_id: "native",
      });
    };
    const callMcp = async (
      name: string,
      raw: unknown,
      credentialId: string,
    ) => {
      try {
        if (!z.string().uuid().safeParse(credentialId).success)
          throw new DomainError("unauthenticated", 401);
        if (name === "workspace_host_status") {
          z.object({})
            .strict()
            .parse(raw ?? {});
          const value = status();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
            structuredContent: value,
          };
        }
        const operation = name.slice("workspace_".length) as Operation;
        if (
          !name.startsWith("workspace_") ||
          !Object.hasOwn(schemas, operation)
        )
          throw new DomainError("unknown_operation", 404);
        if (humanOnly.has(operation))
          throw new DomainError("human_ui_required", 403);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
          throw new DomainError("validation_error");
        const { execution_token, ...input } = raw as Record<string, unknown>;
        let actor: Actor = {
          owner_id: config.ownerId,
          channel: "model",
          executor_id: "native",
        };
        if (execution_token !== undefined) {
          try {
            const { payload: p } = await jwtVerify(
              token.parse(execution_token),
              key,
              {
                issuer: "tg-mcp-workspace",
                audience: "run-execution",
                algorithms: ["HS256"],
              },
            );
            if (
              p.sub !== config.ownerId ||
              p.credential_id !== credentialId ||
              p.channel !== "model" ||
              p.executor_id !== "native" ||
              ![p.run_id, p.attempt_id].every(
                (v) => z.string().uuid().safeParse(v).success,
              ) ||
              typeof p.claimant_id !== "string"
            )
              throw new Error();
            actor = {
              ...actor,
              run_id: p.run_id as string,
              attempt_id: p.attempt_id as string,
              claimant_id: p.claimant_id,
            };
          } catch {
            throw new DomainError("invalid_execution_token", 401);
          }
        }
        if (operation === "claim_run") {
          // The caller's UUID is a request label, not proof of claim ownership.
          // Binding it to the authenticated credential also protects receipt
          // replay and same-claimant retries before an execution token exists.
          const claim = schemas.claim_run.parse(input);
          const bytes = createHmac("sha256", key)
            .update(credentialId)
            .update("\0")
            .update(claim.claimant_id)
            .digest()
            .subarray(0, 16);
          bytes[6] = (bytes[6]! & 0x0f) | 0x40;
          bytes[8] = (bytes[8]! & 0x3f) | 0x80;
          const hex = bytes.toString("hex");
          input.claimant_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        const result = await service.execute(operation, input, actor);
        if (operation === "claim_run") {
          const run = result.data;
          if (!run.attempt_id || run.executor_id !== "native")
            throw new DomainError("claim_required", 409);
          result.execution_token = await new SignJWT({
            credential_id: credentialId,
            channel: "model",
            executor_id: "native",
            run_id: run.id,
            attempt_id: run.attempt_id,
            claimant_id: String(run.attempt_executor).slice(
              run.executor_id.length + 1,
            ),
          })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject(config.ownerId)
            .setIssuer("tg-mcp-workspace")
            .setAudience("run-execution")
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(key);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        const value = hostError(error).body;
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value,
        };
      }
    };
    return {
      ownerId: config.ownerId,
      definitions,
      uiSchema,
      status,
      executeUi,
      callMcp,
      error: hostError,
      close: async () => {
        await db.close();
        await blobDb.close();
      },
    };
  } catch (error) {
    await db.close();
    await blobDb.close();
    throw error;
  }
}

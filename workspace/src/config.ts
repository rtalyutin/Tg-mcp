import { z } from "zod";
import { Database } from "./db.js";
import { Auth, type AuthConfig } from "./auth.js";
import { LocalBlobs, S3Blobs } from "./storage.js";
import { WorkspaceService } from "./service.js";
import { ExternalMcpGateway } from "./external-mcp.js";
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  OWNER_ID: z.string().uuid(),
  OWNER_SUBJECT: z.string().min(1),
  UI_ORIGIN: z.string().url(),
  AUTH_SIGNING_SECRET: z.string().min(32),
  MODEL_JWT_ISSUER: z.string().url().optional(),
  MODEL_JWT_AUDIENCE: z.string().optional(),
  MODEL_JWKS_URL: z.string().url().optional(),
  UI_JWT_ISSUER: z.string().url().optional(),
  UI_JWT_AUDIENCE: z.string().optional(),
  UI_JWKS_URL: z.string().url().optional(),
  UI_CLIENT_ID: z.string().optional(),
  DEV_HUMAN_SECRET: z.string().min(32).optional(),
  DEV_MODEL_TOKEN: z.string().min(32).optional(),
  WORKER_TOKEN: z.string().min(32).optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_BLOB_DIR: z.string().default("var/blobs"),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  WORKER_MODEL: z.string().optional(),
  WORKER_MCP_URL: z.string().url().optional(),
  WORKER_WORKSPACE_CONNECTOR_ID: z.string().uuid().optional(),
  OPENAI_WEBHOOK_SECRET: z.string().optional(),
  EXTERNAL_MCP_CONFIG: z.string().min(1).optional(),
  WORKER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300000)
    .default(30000),
  WORKER_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  CAPABILITY_MAX_AGE_MS: z.coerce.number().int().min(1000).default(300000),
});
export function readConfig(raw: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Invalid environment: " +
        parsed.error.issues.map((x) => x.path.join(".")).join(", "),
    );
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const auth: AuthConfig = {
    ownerId: e.OWNER_ID,
    ownerSubject: e.OWNER_SUBJECT,
    uiOrigin: e.UI_ORIGIN,
    signingSecret: e.AUTH_SIGNING_SECRET,
    production,
    devHumanSecret: e.DEV_HUMAN_SECRET,
    devModelToken: e.DEV_MODEL_TOKEN,
    workerToken: e.WORKER_TOKEN,
  };
  if (e.MODEL_JWT_ISSUER || e.MODEL_JWT_AUDIENCE || e.MODEL_JWKS_URL) {
    if (!e.MODEL_JWT_ISSUER || !e.MODEL_JWT_AUDIENCE || !e.MODEL_JWKS_URL)
      throw new Error("Complete MODEL JWT configuration required");
    auth.model = {
      issuer: e.MODEL_JWT_ISSUER,
      audience: e.MODEL_JWT_AUDIENCE,
      jwks: e.MODEL_JWKS_URL,
    };
  }
  if (e.UI_JWT_ISSUER || e.UI_JWT_AUDIENCE || e.UI_JWKS_URL || e.UI_CLIENT_ID) {
    if (
      !e.UI_JWT_ISSUER ||
      !e.UI_JWT_AUDIENCE ||
      !e.UI_JWKS_URL ||
      !e.UI_CLIENT_ID
    )
      throw new Error("Complete UI JWT configuration required");
    auth.ui = {
      issuer: e.UI_JWT_ISSUER,
      audience: e.UI_JWT_AUDIENCE,
      jwks: e.UI_JWKS_URL,
      clientId: e.UI_CLIENT_ID,
    };
  }
  if (production && e.STORAGE_DRIVER !== "s3")
    throw new Error("Production requires S3 storage");
  if (
    production &&
    [e.MODEL_JWKS_URL, e.UI_JWKS_URL, e.MODEL_JWT_ISSUER, e.UI_JWT_ISSUER].some(
      (x) => x && !x.startsWith("https://"),
    )
  )
    throw new Error("Production auth requires HTTPS");
  if (e.STORAGE_DRIVER === "s3" && (!e.S3_BUCKET || !e.AWS_REGION))
    throw new Error("S3_BUCKET and AWS_REGION required");
  if (e.WORKER_MCP_URL && !e.WORKER_MCP_URL.startsWith("https://"))
    throw new Error("Worker MCP requires HTTPS");
  if (e.DEV_MODEL_TOKEN && e.WORKER_TOKEN === e.DEV_MODEL_TOKEN)
    throw new Error("Distinct service credentials required");
  return {
    ...e,
    auth,
    workerReady: Boolean(
      e.OPENAI_API_KEY && e.WORKER_MODEL && e.WORKER_MCP_URL,
    ),
  };
}
export function components(e: ReturnType<typeof readConfig>) {
  const db = new Database(e.DATABASE_URL),
    auth = new Auth(e.auth);
  const blobs =
    e.STORAGE_DRIVER === "s3"
      ? new S3Blobs(e.S3_BUCKET!, {
          region: e.AWS_REGION,
          endpoint: e.S3_ENDPOINT,
          forcePathStyle: Boolean(e.S3_ENDPOINT),
        })
      : new LocalBlobs(e.LOCAL_BLOB_DIR);
  const service = new WorkspaceService(db, blobs, {
    worker_ready: e.workerReady,
    worker_model: e.WORKER_MODEL,
    capability_max_age_ms: e.CAPABILITY_MAX_AGE_MS,
    worker_workspace_connector_id: e.WORKER_WORKSPACE_CONNECTOR_ID,
    external_mcp: e.EXTERNAL_MCP_CONFIG
      ? ExternalMcpGateway.fromFile(e.EXTERNAL_MCP_CONFIG)
      : undefined,
  });
  return { db, auth, service };
}

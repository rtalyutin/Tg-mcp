import OpenAI from "openai";
import type { FastifyInstance } from "fastify";
import type { WorkspaceService } from "./service.js";
import { DomainError, hash } from "./db.js";
import { z } from "zod";
const eventSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().regex(/^agent\.session\.[a-z_]+$/),
    data: z.object({ id: z.string().min(1).max(200) }).passthrough(),
  })
  .passthrough();
export function registerWebhook(
  app: FastifyInstance,
  service: WorkspaceService,
  owner: string,
  secret?: string,
) {
  app.register(async (routes) => {
    routes.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    routes.post("/webhooks/openai", async (req) => {
      if (!secret) throw new DomainError("webhook_unconfigured", 503);
      const raw = req.body as string;
      const sdk = new OpenAI({
        apiKey: "webhook-verification-only",
        webhookSecret: secret,
        maxRetries: 0,
      });
      try {
        await sdk.webhooks.verifySignature(
          raw,
          req.headers as Record<string, string>,
        );
      } catch {
        throw new DomainError("invalid_webhook_signature", 401);
      }
      let e: z.infer<typeof eventSchema>;
      try {
        e = eventSchema.parse(JSON.parse(raw));
      } catch {
        throw new DomainError("invalid_webhook_event");
      }
      const key = String(req.headers["webhook-id"]);
      return service.db.tx(owner, async (c) => {
        const existing = (
          await c.query(
            "SELECT payload_hash FROM webhook_events WHERE event_id=$1",
            [key],
          )
        ).rows[0];
        if (existing) {
          if (existing.payload_hash !== hash(raw))
            throw new DomainError("webhook_conflict", 409);
          return { accepted: true, replayed: true };
        }
        await c.query(
          "INSERT INTO webhook_events(event_id,owner_id,session_id,event_type,payload_hash) VALUES($1,$2,$3,$4,$5)",
          [key, owner, e.data.id, e.type, hash(raw)],
        );
        // Durable notification only. Worker retrieves authoritative session/turn/output.
        // Delivery order, idle and HTTP receipt never mark a Run succeeded.
        return { accepted: true, replayed: false };
      });
    });
  });
}

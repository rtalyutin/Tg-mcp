import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { DomainError } from "./db.js";
import type { Actor } from "./service.js";
export interface AuthConfig {
  ownerId: string;
  ownerSubject: string;
  uiOrigin: string;
  production: boolean;
  signingSecret: string;
  model?: { issuer: string; audience: string; jwks: string };
  ui?: { issuer: string; audience: string; jwks: string; clientId: string };
  devHumanSecret?: string;
  devModelToken?: string;
  workerToken?: string;
}
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export class Auth {
  private signingKey: Uint8Array;
  constructor(public config: AuthConfig) {
    if (config.production && /^CHANGE_ME/.test(config.signingSecret))
      throw new Error("Replace placeholder signing secret before production");
    if (config.signingSecret.length < 32)
      throw new Error("AUTH_SIGNING_SECRET must be at least 32 characters");
    if (config.production && (config.devHumanSecret || config.devModelToken))
      throw new Error("Development credentials forbidden in production");
    if (
      config.model?.audience === config.ui?.audience &&
      config.model &&
      config.ui
    )
      throw new Error("UI and model audiences must differ");
    if (
      config.production &&
      (!config.model || !config.ui || !config.uiOrigin.startsWith("https://"))
    )
      throw new Error(
        "Production requires distinct configured issuers/audiences and HTTPS UI origin",
      );
    this.signingKey = new TextEncoder().encode(config.signingSecret);
  }
  private cookie(req: FastifyRequest, name: string) {
    return req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1);
  }
  private async remote(token: string, scope: "model" | "ui") {
    const cfg = this.config[scope];
    if (!cfg) throw new DomainError("auth_channel_unconfigured", 401);
    try {
      const { payload } = await jwtVerify(
        token,
        createRemoteJWKSet(new URL(cfg.jwks)),
        {
          issuer: cfg.issuer,
          audience: cfg.audience,
          algorithms: ["RS256", "ES256", "EdDSA"],
        },
      );
      if (payload.sub !== this.config.ownerSubject)
        throw new DomainError("unauthenticated", 401);
      if (scope === "ui" && payload.azp !== this.config.ui!.clientId)
        throw new DomainError("ui_client_required", 403);
      return payload;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError("unauthenticated", 401);
    }
  }
  async uiSession(req: FastifyRequest) {
    const body = req.body as any;
    if (
      !this.config.production &&
      this.config.devHumanSecret &&
      body?.bootstrap_secret &&
      equal(body.bootstrap_secret, this.config.devHumanSecret)
    ) {
    } else {
      const t = req.headers.authorization?.replace(/^Bearer /, "");
      if (!t) throw new DomainError("unauthenticated", 401);
      await this.remote(t, "ui");
    }
    if (req.headers.origin !== this.config.uiOrigin)
      throw new DomainError("origin_forbidden", 403);
    const csrf = randomBytes(32).toString("base64url");
    const token = await new SignJWT({ kind: "human-ui", csrf })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(this.config.ownerId)
      .setIssuer("shared-workspace")
      .setAudience("human-ui")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(this.signingKey);
    return {
      cookie: `workspace_ui=${token}; HttpOnly; Path=/; SameSite=${this.config.production ? "None" : "Strict"}; Max-Age=3600${this.config.production ? "; Secure" : ""}`,
      csrf_token: csrf,
    };
  }
  async actor(
    req: FastifyRequest,
    mutation = false,
    executionToken?: string,
  ): Promise<Actor> {
    if (executionToken) {
      try {
        const { payload } = await jwtVerify(executionToken, this.signingKey, {
          issuer: "shared-workspace",
          audience: "run-execution",
          algorithms: ["HS256"],
        });
        if (
          payload.sub !== this.config.ownerId ||
          typeof payload.run_id !== "string" ||
          typeof payload.attempt_id !== "string" ||
          typeof payload.claimant_id !== "string" ||
          typeof payload.executor_id !== "string" ||
          !["model", "worker"].includes(String(payload.channel))
        )
          throw new Error();
        return {
          owner_id: this.config.ownerId,
          channel: payload.channel as "model" | "worker",
          executor_id: payload.executor_id,
          run_id: payload.run_id,
          attempt_id: payload.attempt_id,
          claimant_id: payload.claimant_id,
        };
      } catch {
        throw new DomainError("invalid_execution_token", 401);
      }
    }
    const cookie = this.cookie(req, "workspace_ui");
    if (cookie) {
      try {
        const { payload } = await jwtVerify(cookie, this.signingKey, {
          issuer: "shared-workspace",
          audience: "human-ui",
          algorithms: ["HS256"],
        });
        if (payload.sub !== this.config.ownerId || payload.kind !== "human-ui")
          throw new Error();
        if (
          mutation &&
          (req.headers.origin !== this.config.uiOrigin ||
            req.headers["x-csrf-token"] !== payload.csrf)
        )
          throw new DomainError("csrf_required", 403);
        return {
          owner_id: this.config.ownerId,
          channel: "ui",
          executor_id: "native",
        };
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new DomainError("unauthenticated", 401);
      }
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) throw new DomainError("unauthenticated", 401);
    if (this.config.workerToken && equal(token, this.config.workerToken))
      return {
        owner_id: this.config.ownerId,
        channel: "worker",
        executor_id: "worker",
      };
    if (
      !this.config.production &&
      this.config.devModelToken &&
      equal(token, this.config.devModelToken)
    )
      return {
        owner_id: this.config.ownerId,
        channel: "model",
        executor_id: "native",
      };
    await this.remote(token, "model");
    return {
      owner_id: this.config.ownerId,
      channel: "model",
      executor_id: "native",
    };
  }
  async executionToken(actor: Actor, run: any) {
    if (!run.attempt_id) throw new DomainError("claim_required", 409);
    const claimant = String(run.attempt_executor).slice(
      run.executor_id.length + 1,
    );
    return new SignJWT({
      run_id: run.id,
      attempt_id: run.attempt_id,
      claimant_id: claimant,
      executor_id: run.executor_id,
      channel: actor.channel === "worker" ? "worker" : "model",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(actor.owner_id)
      .setIssuer("shared-workspace")
      .setAudience("run-execution")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(this.signingKey);
  }
}

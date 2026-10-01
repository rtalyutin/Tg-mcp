import {
  Database,
  DomainError,
  one,
  revision,
  id,
  hash,
  canonical,
  type Client,
} from "./db.js";
import {
  schemas,
  humanOnly,
  workerAllowed,
  reads,
  type Operation,
} from "./contracts.js";
import { nextSlot } from "./schedule.js";
import { bytesHash, type BlobStore } from "./storage.js";
import type { ExternalMcpGateway } from "./external-mcp.js";
export interface Actor {
  owner_id: string;
  channel: "ui" | "model" | "worker";
  executor_id: string;
  run_id?: string;
  attempt_id?: string;
  claimant_id?: string;
}
export interface Runtime {
  worker_ready: boolean;
  worker_model?: string;
  capability_max_age_ms: number;
  worker_workspace_connector_id?: string;
  external_mcp?: ExternalMcpGateway;
}
const terminal = new Set(["succeeded", "failed", "cancelled"]);
export class WorkspaceService {
  constructor(
    public db: Database,
    public blobs: BlobStore,
    public runtime: Runtime,
  ) {}
  async init(owner: string, title = "Совместная работа") {
    await this.db.pool.query(
      "INSERT INTO workspaces(owner_id,title) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [owner, title],
    );
  }
  async execute(name: Operation, raw: unknown, actor: Actor): Promise<any> {
    if (!schemas[name]) throw new DomainError("unknown_operation", 404);
    if (humanOnly.has(name) && actor.channel !== "ui")
      throw new DomainError("human_ui_required", 403);
    if (actor.channel === "worker" && !workerAllowed.has(name))
      throw new DomainError("worker_scope_denied", 403);
    const b: any = schemas[name].parse(raw);
    if (actor.run_id && !workerAllowed.has(name))
      throw new DomainError("execution_scope_denied", 403);
    if (actor.run_id && name === "claim_run" && b.id !== actor.run_id)
      throw new DomainError("execution_scope_denied", 403);
    if (name === "external_mcp_read") {
      // Network is deliberately outside the owner transaction: cancel/revoke
      // can commit while a slow external read is in flight.
      await this.db.tx(actor.owner_id, (c) =>
        this.authorizeExternalRead(c, b, actor),
      );
      const data = await this.runtime.external_mcp!.read(
        b.connector_id,
        b.tool_name,
        b.resource,
      );
      await this.db.tx(actor.owner_id, async (c) => {
        await this.authorizeExternalRead(c, b, actor);
        await this.audit(c, actor, name, b.connector_id, {
          tool_name: b.tool_name,
          resource_hash: hash(b.resource),
        });
      });
      return { data, server_time: new Date().toISOString() };
    }
    return this.db.tx(actor.owner_id, async (c) => {
      let payload: string | undefined;
      if (!reads.has(name)) {
        payload = hash({
          name,
          body: b,
          channel: actor.channel,
          executor: actor.executor_id,
          scope: actor.run_id
            ? [actor.run_id, actor.attempt_id, actor.claimant_id]
            : null,
        });
        const prior = (
          await c.query(
            "SELECT * FROM operation_receipts WHERE owner_id=$1 AND operation_id=$2",
            [actor.owner_id, b.operation_id],
          )
        ).rows[0];
        if (prior) {
          if (prior.payload_hash !== payload)
            throw new DomainError("operation_conflict", 409);
          return {
            data: prior.result,
            receipt: { operation_id: b.operation_id, replayed: true },
            server_time: new Date().toISOString(),
          };
        }
      }
      const data = await this.dispatch(c, name, b, actor);
      if (payload) {
        await c.query(
          "INSERT INTO operation_receipts(owner_id,operation_id,payload_hash,operation_kind,actor,result) VALUES($1,$2,$3,$4,$5,$6)",
          [
            actor.owner_id,
            b.operation_id,
            payload,
            name,
            actor.channel,
            JSON.stringify(data),
          ],
        );
        await this.audit(c, actor, name, data?.id ?? b.id ?? null, {
          operation_id: b.operation_id,
        });
        await c.query(
          "UPDATE workspaces SET revision=revision+1,updated_at=now() WHERE owner_id=$1",
          [actor.owner_id],
        );
      }
      return {
        data,
        ...(payload
          ? { receipt: { operation_id: b.operation_id, replayed: false } }
          : {}),
        server_time: new Date().toISOString(),
      };
    });
  }
  async audit(
    c: Client,
    a: Actor,
    kind: string,
    target: string | null,
    details: Record<string, unknown> = {},
  ) {
    await c.query(
      "INSERT INTO audit_events(owner_id,operation_id,actor,kind,target_id,details) VALUES($1,$2,$3,$4,$5,$6)",
      [
        a.owner_id,
        details.operation_id ?? null,
        a.channel,
        kind,
        target,
        JSON.stringify(details),
      ],
    );
  }
  async row(c: Client, table: string, owner: string, target: string) {
    return one(c, `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2`, [
      owner,
      target,
    ]);
  }
  async active(c: Client, owner: string, work: string) {
    const w = await this.row(c, "work_items", owner, work);
    if (w.status === "archived")
      throw new DomainError("work_item_archived", 409);
    await this.activeProject(c, owner, w.project_id);
    return w;
  }
  async activeProject(c: Client, owner: string, project: string) {
    const p = await this.row(c, "projects", owner, project);
    const r = await c.query(
      "WITH RECURSIVE chain AS (SELECT * FROM projects WHERE owner_id=$1 AND id=$2 UNION ALL SELECT p.* FROM projects p JOIN chain c ON p.id=c.parent_id AND p.owner_id=c.owner_id) SELECT id FROM chain WHERE status='archived'",
      [owner, project],
    );
    if (r.rowCount) throw new DomainError("project_archived", 409);
    return p;
  }
  async subtree(c: Client, owner: string, root: string) {
    return (
      await c.query(
        "WITH RECURSIVE tree AS (SELECT id FROM projects WHERE owner_id=$1 AND id=$2 UNION ALL SELECT p.id FROM projects p JOIN tree t ON p.parent_id=t.id WHERE p.owner_id=$1) SELECT id FROM tree",
        [owner, root],
      )
    ).rows.map((r) => r.id);
  }
  async safeToArchive(
    c: Client,
    owner: string,
    projects: string[],
    work?: string,
  ) {
    const runs = await c.query(
      "SELECT id,status FROM runs WHERE owner_id=$1 AND project_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR work_item_id=$3) AND status NOT IN ('succeeded','failed','cancelled')",
      [owner, projects, work ?? null],
    );
    const jobs = await c.query(
      "SELECT j.id,j.status FROM recurring_jobs j JOIN work_items w ON w.id=j.work_item_id AND w.owner_id=j.owner_id WHERE j.owner_id=$1 AND w.project_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR w.id=$3) AND (j.status='active' OR (j.reference_only AND j.old_pause_status IS DISTINCT FROM 'confirmed'))",
      [owner, projects, work ?? null],
    );
    if (runs.rowCount || jobs.rowCount)
      throw new DomainError("archive_requires_stop_and_pause", 409, {
        runs: runs.rows,
        jobs: jobs.rows,
      });
  }
  async event(c: Client, owner: string, b: any) {
    const e = await c.query(
      "INSERT INTO attention_events(id,owner_id,project_id,work_item_id,source,source_event_id,type,reason,refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,source,source_event_id) DO NOTHING RETURNING *",
      [
        id(),
        owner,
        b.project_id,
        b.work_item_id ?? null,
        b.source,
        b.source_event_id,
        b.type,
        b.reason,
        JSON.stringify(b.refs ?? []),
      ],
    );
    return (
      e.rows[0] ??
      one(
        c,
        "SELECT * FROM attention_events WHERE owner_id=$1 AND source=$2 AND source_event_id=$3",
        [owner, b.source, b.source_event_id],
      )
    );
  }
  async preflight(c: Client, owner: string, s: any, kind = "execution") {
    const obstacles: string[] = [];
    await this.active(c, owner, s.work_item_id);
    if (
      s.executor_id === "worker" &&
      (!this.runtime.worker_ready || !this.runtime.worker_model)
    )
      obstacles.push("Worker не настроен");
    const selected = (
      await c.query(
        "SELECT requirements FROM skill_versions WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, (s.skill_versions ?? []).map((x: any) => x.version_id)],
      )
    ).rows.flatMap((x) => x.requirements);
    const requirements = [
      ...(kind === "discussion" ? [] : selected),
      ...(s.executor_id === "native"
        ? [
            {
              connector_id: null,
              capability: "native.dispatch",
              action: "dispatch",
            },
          ]
        : []),
      ...(kind === "discussion" ? [] : (s.requirements ?? [])),
    ];
    for (const r of requirements) {
      if (
        s.executor_id === "worker" &&
        !this.workerReadConfigured(r.connector_id, r.capability, r.action)
      ) {
        obstacles.push("Worker adapter не настроен для " + r.capability);
        continue;
      }
      if (
        s.executor_id === "worker" &&
        !["read", "observe"].includes(r.action)
      ) {
        obstacles.push("Worker: внешнее изменение запрещено");
        continue;
      }
      const obs = (
        await c.query(
          "SELECT o.*,c.location,c.metadata,c.transport FROM capability_observations o JOIN connectors c ON c.id=o.connector_id AND c.owner_id=o.owner_id WHERE o.owner_id=$1 AND ($2::uuid IS NULL OR o.connector_id=$2) AND o.executor_id=$3 AND o.capability=$4",
          [owner, r.connector_id, s.executor_id, r.capability],
        )
      ).rows;
      const now = Date.now();
      const usable = obs.some(
        (o) =>
          o.configured &&
          o.reachable &&
          o.authenticated &&
          o.allowed &&
          Date.parse(o.expires_at) > now &&
          now - Date.parse(o.observed_at) <=
            this.runtime.capability_max_age_ms &&
          o.actions.includes(r.action) &&
          (!this.runtime.external_mcp?.available(
            r.connector_id,
            r.capability,
            r.action,
          ) ||
            (o.transport === "http" &&
              o.location === "remote" &&
              o.identity_ref ===
                this.runtime.external_mcp.identityRef(r.connector_id) &&
              o.metadata.identity_ref === o.identity_ref)) &&
          !(o.location === "desktop" && s.executor_id !== "desktop"),
      );
      if (!usable)
        obstacles.push(
          `Недоступно: ${r.capability} / ${r.action} / ${s.executor_id}`,
        );
      if (
        s.executor_id === "worker" &&
        this.runtime.external_mcp?.available(
          r.connector_id,
          r.capability,
          r.action,
        )
      ) {
        const grants = await c.query(
          "SELECT * FROM proposals WHERE owner_id=$1 AND id=ANY($2::uuid[])",
          [owner, s.authorization_refs ?? []],
        );
        if (
          !grants.rows.some((p) =>
            this.externalGrant(p, s, r.connector_id, r.capability),
          )
        )
          obstacles.push("Нет разрешения на внешнее чтение: " + r.capability);
      }
    }
    for (const r of s.authorization_refs ?? []) {
      const p = await this.row(c, "proposals", owner, r);
      if (
        p.kind !== "permission" ||
        p.status !== "accepted" ||
        p.project_id !== s.project_id ||
        (p.work_item_id && p.work_item_id !== s.work_item_id)
      )
        obstacles.push("Нет разрешения в области задачи");
    }
    for (const r of s.skill_versions ?? [])
      await one(
        c,
        "SELECT id FROM skill_versions WHERE owner_id=$1 AND skill_id=$2 AND id=$3",
        [owner, r.skill_id, r.version_id],
      );
    if (s.executor_id === "worker") {
      const base = (
        await c.query(
          "SELECT s.name FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.owner_id=s.owner_id WHERE s.owner_id=$1 AND s.origin='owned' AND v.id=ANY($2::uuid[])",
          [owner, (s.skill_versions ?? []).map((x: any) => x.version_id)],
        )
      ).rows.map((x) => x.name);
      if (!base.includes("loki") || !base.includes("run-roman-control-loop"))
        obstacles.push("Worker требует полные версии Локи и Work Engine");
      if (!s.model || !s.budget)
        obstacles.push("Worker требует явно выбранные модель и мягкий бюджет");
      if (s.model && s.model !== this.runtime.worker_model)
        obstacles.push("Модель worker не совпадает с выбранной");
    }
    return { available: obstacles.length === 0, obstacles };
  }
  async makeSnapshot(c: Client, b: any, a: Actor) {
    const w = await this.active(c, a.owner_id, b.work_item_id);
    const p = await this.row(c, "projects", a.owner_id, w.project_id);
    const artifactRefs =
      b.input_refs ??
      (
        await c.query(
          "SELECT a.id artifact_id,a.current_version_id version_id FROM artifacts a JOIN artifact_links l ON l.artifact_id=a.id AND l.owner_id=a.owner_id WHERE l.owner_id=$1 AND l.work_item_id=$2",
          [a.owner_id, w.id],
        )
      ).rows;
    const materials = [];
    for (const r of artifactRefs)
      materials.push(
        await one(
          c,
          "SELECT v.*,a.title,a.kind FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id AND a.owner_id=v.owner_id JOIN artifact_links l ON l.artifact_id=a.id AND l.owner_id=a.owner_id WHERE v.owner_id=$1 AND v.artifact_id=$2 AND v.id=$3 AND l.work_item_id=$4",
          [a.owner_id, r.artifact_id, r.version_id, w.id],
        ),
      );
    const accepted = (
      await c.query(
        "SELECT * FROM proposals WHERE owner_id=$1 AND project_id=$2 AND (work_item_id IS NULL OR work_item_id=$3) AND status='accepted'",
        [a.owner_id, w.project_id, w.id],
      )
    ).rows;
    const packages = [];
    for (const r of b.skill_versions ?? [])
      packages.push(
        await one(
          c,
          "SELECT v.*,s.name,s.origin,s.source_ref FROM skill_versions v JOIN skills s ON s.id=v.skill_id AND s.owner_id=v.owner_id WHERE v.owner_id=$1 AND v.skill_id=$2 AND v.id=$3",
          [a.owner_id, r.skill_id, r.version_id],
        ),
      );
    const body = {
      project_id: p.id,
      work_item_id: w.id,
      project_revision: Number(p.revision),
      work_item_revision: Number(w.revision),
      goal: w.goal,
      title: w.title,
      instruction: b.instruction ?? w.goal,
      model: b.model ?? null,
      budget: b.budget ?? null,
      contract_revision: b.contract_revision,
      requested_action: b.requested_action,
      executor_id: b.executor_id,
      input_refs: artifactRefs,
      materials,
      accepted_decisions: accepted.filter((x) => x.kind === "decision"),
      accepted_continuation:
        accepted.find((x) => x.id === w.accepted_continuation_id) ?? null,
      skill_versions: b.skill_versions ?? [],
      packages,
      requirements: b.requirements ?? [],
      authorization_refs: b.authorization_refs ?? [],
      authorization_grants: accepted.filter(
        (x) =>
          x.kind === "permission" &&
          (b.authorization_refs ?? []).includes(x.id),
      ),
    };
    const sid = id();
    await c.query(
      "INSERT INTO context_snapshots(id,owner_id,project_id,work_item_id,body,digest) VALUES($1,$2,$3,$4,$5,$6)",
      [sid, a.owner_id, p.id, w.id, JSON.stringify(body), hash(body)],
    );
    return { id: sid, project_id: p.id, work_item_id: w.id, body };
  }
  async enqueue(
    c: Client,
    s: any,
    kind: string,
    executor: string,
    trigger: string,
    owner: string,
    parent: string | null = null,
  ) {
    if (s.body.executor_id !== executor)
      throw new DomainError("executor_snapshot_mismatch", 409);
    if (s.body.requested_action !== kind)
      throw new DomainError("snapshot_purpose_mismatch", 409);
    const pf = await this.preflight(c, owner, s.body, kind);
    if (!pf.available) throw new DomainError("preflight_blocked", 409, pf);
    return one(
      c,
      "INSERT INTO runs(id,owner_id,project_id,work_item_id,snapshot_id,executor_id,kind,trigger,parent_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        id(),
        owner,
        s.project_id,
        s.work_item_id,
        s.id,
        executor,
        kind,
        trigger,
        parent,
      ],
    );
  }
  async scope(c: Client, r: any, a: Actor, attempt?: string) {
    if (r.executor_id !== a.executor_id)
      throw new DomainError("executor_mismatch", 403);
    if (
      a.run_id !== r.id ||
      a.attempt_id !== attempt ||
      attempt !== r.attempt_id
    )
      throw new DomainError("execution_scope_denied", 403);
    if (
      !a.claimant_id ||
      r.attempt_executor !== a.executor_id + ":" + a.claimant_id
    )
      throw new DomainError("attempt_fenced", 409);
  }
  workerReadConfigured(connector: string, capability: string, action: string) {
    return (
      (connector === this.runtime.worker_workspace_connector_id &&
        capability === "workspace.read" &&
        ["read", "observe"].includes(action)) ||
      Boolean(
        this.runtime.external_mcp?.available(connector, capability, action),
      )
    );
  }
  externalGrant(
    p: any,
    s: any,
    connector: string,
    capability: string,
    resource?: string,
  ) {
    return (
      p.kind === "permission" &&
      p.status === "accepted" &&
      p.project_id === s.project_id &&
      (!p.work_item_id || p.work_item_id === s.work_item_id) &&
      p.body.actions?.includes(`${connector}:${capability}:read`) &&
      Array.isArray(p.body.resources) &&
      p.body.resources.length > 0 &&
      (resource === undefined || p.body.resources.includes(resource))
    );
  }
  async authorizeExternalRead(c: Client, b: any, a: Actor) {
    if (!a.run_id) throw new DomainError("execution_scope_required", 403);
    const r = await this.row(c, "runs", a.owner_id, a.run_id);
    await this.scope(c, r, a, a.attempt_id);
    if (
      r.status !== "running" ||
      r.cancellation_requested_at ||
      !r.lease_until ||
      Date.parse(r.lease_until) <= Date.now()
    )
      throw new DomainError("external_run_inactive", 409);
    if (r.kind !== "execution")
      throw new DomainError("external_execution_required", 403);
    await this.active(c, a.owner_id, r.work_item_id);
    const s = await this.row(c, "context_snapshots", a.owner_id, r.snapshot_id);
    const gateway = this.runtime.external_mcp;
    if (!gateway) throw new DomainError("external_adapter_not_configured", 409);
    const binding = gateway.binding(b.connector_id, b.tool_name);
    const requirements = [
      ...s.body.requirements,
      ...s.body.packages.flatMap((p: any) => p.requirements),
    ];
    if (
      !requirements.some(
        (x: any) =>
          x.connector_id === b.connector_id &&
          x.capability === binding.capability &&
          x.action === "read",
      )
    )
      throw new DomainError("external_capability_scope_denied", 403);
    const connector = await this.row(
      c,
      "connectors",
      a.owner_id,
      b.connector_id,
    );
    if (
      connector.transport !== "http" ||
      connector.location !== "remote" ||
      connector.metadata.identity_ref !== binding.identity_ref
    )
      throw new DomainError("external_identity_mismatch", 403);
    const observed = await c.query(
      "SELECT * FROM capability_observations WHERE owner_id=$1 AND connector_id=$2 AND executor_id=$3 AND capability=$4",
      [a.owner_id, b.connector_id, a.executor_id, binding.capability],
    );
    if (
      !observed.rows.some(
        (o) =>
          o.identity_ref === binding.identity_ref &&
          o.configured &&
          o.reachable &&
          o.authenticated &&
          o.allowed &&
          o.actions.includes("read") &&
          Date.parse(o.expires_at) > Date.now() &&
          Date.now() - Date.parse(o.observed_at) <=
            this.runtime.capability_max_age_ms,
      )
    )
      throw new DomainError("external_capability_unavailable", 409);
    const grants = await c.query(
      "SELECT * FROM proposals WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [a.owner_id, s.body.authorization_refs ?? []],
    );
    if (
      !grants.rows.some((p) =>
        this.externalGrant(
          p,
          s.body,
          b.connector_id,
          binding.capability,
          b.resource,
        ),
      )
    )
      throw new DomainError("external_resource_denied", 403);
  }
  async dispatch(c: Client, n: Operation, b: any, a: Actor): Promise<any> {
    const owner = a.owner_id;
    switch (n) {
      case "workspace_get": {
        const workspace = await one(
          c,
          "SELECT * FROM workspaces WHERE owner_id=$1",
          [owner],
        );
        const projects = (
          await c.query(
            `SELECT p.*,row_to_json(w) current_task,(SELECT count(*)::int FROM attention_events e WHERE e.owner_id=p.owner_id AND e.project_id=p.id AND (e.state='open' OR(e.state='snoozed' AND e.snoozed_until<=now()))) open_attention,(SELECT array_agg(DISTINCT e.type) FROM attention_events e WHERE e.owner_id=p.owner_id AND e.project_id=p.id AND (e.state='open' OR(e.state='snoozed' AND e.snoozed_until<=now()))) attention_types,(SELECT created_at FROM audit_events x WHERE x.owner_id=p.owner_id AND x.target_id IN (p.id,p.current_work_item_id) ORDER BY id DESC LIMIT 1) last_change_at FROM projects p LEFT JOIN work_items w ON w.id=p.current_work_item_id AND w.owner_id=p.owner_id WHERE p.owner_id=$1 ORDER BY p.created_at,p.id`,
            [owner],
          )
        ).rows;
        const attention = await this.dispatch(
          c,
          "attention_list",
          { state: "open", limit: 50 },
          a,
        );
        return {
          workspace,
          projects,
          attention,
          active_runs: (
            await c.query(
              "SELECT id,project_id,work_item_id,executor_id,status FROM runs WHERE owner_id=$1 AND status NOT IN ('succeeded','failed','cancelled')",
              [owner],
            )
          ).rows,
        };
      }
      case "project_get": {
        const p = await this.row(c, "projects", owner, b.id);
        return {
          ...p,
          children: (
            await c.query(
              "SELECT * FROM projects WHERE owner_id=$1 AND parent_id=$2",
              [owner, b.id],
            )
          ).rows,
          work_items: (
            await c.query(
              "SELECT * FROM work_items WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at,id",
              [owner, b.id],
            )
          ).rows,
          path: (
            await c.query(
              "WITH RECURSIVE chain AS (SELECT id,parent_id,title,0 depth FROM projects WHERE owner_id=$1 AND id=$2 UNION ALL SELECT p.id,p.parent_id,p.title,c.depth+1 FROM projects p JOIN chain c ON c.parent_id=p.id WHERE p.owner_id=$1) SELECT id,title FROM chain ORDER BY depth DESC",
              [owner, b.id],
            )
          ).rows,
        };
      }
      case "work_item_get": {
        const w = await this.row(c, "work_items", owner, b.id);
        return {
          ...w,
          materials: (
            await c.query(
              "SELECT a.* FROM artifacts a JOIN artifact_links l ON l.owner_id=a.owner_id AND l.artifact_id=a.id WHERE l.owner_id=$1 AND l.work_item_id=$2",
              [owner, b.id],
            )
          ).rows,
          proposals: (
            await c.query(
              "SELECT * FROM proposals WHERE owner_id=$1 AND project_id=$2 AND (work_item_id IS NULL OR work_item_id=$3) ORDER BY created_at",
              [owner, w.project_id, b.id],
            )
          ).rows,
          runs: (
            await c.query(
              "SELECT * FROM runs WHERE owner_id=$1 AND work_item_id=$2 ORDER BY created_at DESC",
              [owner, b.id],
            )
          ).rows,
        };
      }
      case "operation_status_get":
        return one(
          c,
          "SELECT operation_id,operation_kind,result,created_at FROM operation_receipts WHERE owner_id=$1 AND operation_id=$2",
          [owner, b.operation_id],
        );
      case "history_get":
        return (
          await c.query(
            "SELECT * FROM audit_events WHERE owner_id=$1 AND id>$2 ORDER BY id LIMIT $3",
            [owner, b.after, b.limit],
          )
        ).rows;
      case "project_create":
        if (b.parent_id) await this.activeProject(c, owner, b.parent_id);
        return one(
          c,
          "INSERT INTO projects(id,owner_id,parent_id,title) VALUES($1,$2,$3,$4) RETURNING *",
          [id(), owner, b.parent_id, b.title],
        );
      case "project_update": {
        const p = await this.row(c, "projects", owner, b.id);
        revision(p, b.expected_revision);
        if (b.current_work_item_id !== undefined && a.channel !== "ui")
          throw new DomainError("human_ui_required", 403);
        if (b.parent_id !== undefined && b.parent_id !== null) {
          const targets = await this.subtree(c, owner, p.id);
          if (targets.includes(b.parent_id))
            throw new DomainError("project_cycle", 409);
          const parent = await this.row(c, "projects", owner, b.parent_id);
          if (p.status === "active")
            await this.activeProject(c, owner, parent.id);
        }
        if (b.current_work_item_id)
          await one(
            c,
            "SELECT id FROM work_items WHERE owner_id=$1 AND project_id=$2 AND id=$3 AND status<>'archived'",
            [owner, p.id, b.current_work_item_id],
          );
        return one(
          c,
          "UPDATE projects SET title=$3,parent_id=$4,current_work_item_id=$5,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [
            owner,
            p.id,
            b.title ?? p.title,
            b.parent_id === undefined ? p.parent_id : b.parent_id,
            b.current_work_item_id === undefined
              ? p.current_work_item_id
              : b.current_work_item_id,
          ],
        );
      }
      case "project_archive":
      case "project_restore": {
        const p = await this.row(c, "projects", owner, b.id);
        revision(p, b.expected_revision);
        const tree = await this.subtree(c, owner, p.id);
        if (n === "project_archive") {
          await this.safeToArchive(c, owner, tree);
          await c.query(
            "UPDATE projects SET status='archived',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'archived'",
            [owner, tree],
          );
        } else {
          if (p.parent_id) await this.activeProject(c, owner, p.parent_id);
          await c.query(
            "UPDATE projects SET status='active',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status='archived'",
            [owner, tree],
          );
        }
        return {
          ...(await this.row(c, "projects", owner, p.id)),
          affected_projects: tree,
        };
      }
      case "work_item_create":
        await this.activeProject(c, owner, b.project_id);
        return one(
          c,
          "INSERT INTO work_items(id,owner_id,project_id,title,goal) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id(), owner, b.project_id, b.title, b.goal],
        );
      case "work_item_update":
      case "work_item_complete":
      case "work_item_archive":
      case "work_item_restore": {
        const w = await this.row(c, "work_items", owner, b.id);
        revision(w, b.expected_revision);
        let status = w.status,
          prev = w.previous_status;
        if (n === "work_item_restore") {
          await this.activeProject(c, owner, w.project_id);
          if (w.status !== "archived")
            throw new DomainError("not_archived", 409);
          status = prev ?? "planned";
          prev = null;
        } else {
          await this.active(c, owner, w.id);
          if (n === "work_item_complete") {
            if (!b.evidence.length && !b.manual_assessment)
              throw new DomainError("completion_evidence_required");
            status = "completed";
          } else if (n === "work_item_archive") {
            await this.safeToArchive(c, owner, [w.project_id], w.id);
            prev = w.status;
            status = "archived";
            await c.query(
              "UPDATE projects SET current_work_item_id=NULL,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND current_work_item_id=$2",
              [owner, w.id],
            );
          } else if (b.status) {
            if (w.status === "completed" && a.channel !== "ui")
              throw new DomainError("human_ui_required", 403);
            status = b.status;
          }
        }
        await this.audit(c, a, "work_item_state", w.id, {
          from: w.status,
          to: status,
          reason: b.reason ?? null,
          evidence: b.evidence ?? [],
          manual_assessment: b.manual_assessment ?? false,
        });
        return one(
          c,
          "UPDATE work_items SET title=$3,goal=$4,status=$5,previous_status=$6,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, w.id, b.title ?? w.title, b.goal ?? w.goal, status, prev],
        );
      }
      case "artifact_add":
      case "artifact_version_create": {
        const artifact =
          n === "artifact_add"
            ? { id: id(), kind: b.kind, revision: 1 }
            : await this.row(c, "artifacts", owner, b.id);
        if (n === "artifact_add") await this.active(c, owner, b.work_item_id);
        else {
          revision(artifact, b.expected_revision);
          const links = (
            await c.query(
              "SELECT work_item_id FROM artifact_links WHERE owner_id=$1 AND artifact_id=$2",
              [owner, artifact.id],
            )
          ).rows;
          for (const l of links) await this.active(c, owner, l.work_item_id);
        }
        const value = await this.materialValue(b, artifact.kind, owner);
        if (n === "artifact_add") {
          await c.query(
            "INSERT INTO artifacts(id,owner_id,title,kind) VALUES($1,$2,$3,$4)",
            [artifact.id, owner, b.title, b.kind],
          );
          await c.query("INSERT INTO artifact_links VALUES($1,$2,$3)", [
            owner,
            artifact.id,
            b.work_item_id,
          ]);
        }
        const version = await one(
          c,
          "INSERT INTO artifact_versions(id,owner_id,artifact_id,content,blob_key,content_hash,external_ref,observed_revision,author) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            id(),
            owner,
            artifact.id,
            value.content,
            value.blob_key,
            value.content_hash,
            value.external_ref,
            b.observed_revision ?? null,
            a.channel,
          ],
        );
        const current = await one(
          c,
          "UPDATE artifacts SET current_version_id=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, artifact.id, version.id],
        );
        return { id: artifact.id, artifact: current, version };
      }
      case "artifact_link":
        await this.row(c, "artifacts", owner, b.id);
        await this.active(c, owner, b.work_item_id);
        await c.query(
          "INSERT INTO artifact_links VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [owner, b.id, b.work_item_id],
        );
        return { id: b.id, work_item_id: b.work_item_id };
      case "artifact_get": {
        const artifact = await this.row(c, "artifacts", owner, b.id);
        const version = await one(
          c,
          "SELECT * FROM artifact_versions WHERE owner_id=$1 AND artifact_id=$2 AND id=$3",
          [owner, b.id, b.version_id ?? artifact.current_version_id],
        );
        if (a.run_id || a.channel === "worker")
          await this.workerMaterialScope(c, a, artifact.id, version.id);
        return {
          artifact,
          version,
          ...(version.blob_key
            ? {
                base64: (await this.blobs.get(version.blob_key)).toString(
                  "base64",
                ),
              }
            : {}),
        };
      }
      case "proposal_record": {
        const p = await this.activeProject(c, owner, b.project_id);
        if (b.work_item_id) {
          const w = await this.active(c, owner, b.work_item_id);
          if (w.project_id !== p.id)
            throw new DomainError("project_work_item_mismatch");
        }
        if (b.body.latest_result_ref)
          await one(
            c,
            "SELECT rr.id FROM run_results rr JOIN runs r ON r.id=rr.run_id AND r.owner_id=rr.owner_id WHERE rr.owner_id=$1 AND rr.id=$2 AND r.work_item_id=$3",
            [owner, b.body.latest_result_ref, b.work_item_id ?? null],
          );
        const prop = await one(
          c,
          "INSERT INTO proposals(id,owner_id,project_id,work_item_id,kind,body,author) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id(),
            owner,
            b.project_id,
            b.work_item_id ?? null,
            b.kind,
            JSON.stringify(b.body),
            a.channel,
          ],
        );
        await this.event(c, owner, {
          project_id: p.id,
          work_item_id: b.work_item_id,
          source: "proposal",
          source_event_id: prop.id,
          type: "decision_required",
          reason: b.body.statement,
          refs: [prop.id],
        });
        return prop;
      }
      case "proposal_accept":
      case "proposal_revoke": {
        const prop = await this.row(c, "proposals", owner, b.id);
        revision(prop, b.expected_revision);
        await this.activeProject(c, owner, prop.project_id);
        if (prop.work_item_id) await this.active(c, owner, prop.work_item_id);
        if (n === "proposal_accept" && hash(prop.body) !== b.content_hash)
          throw new DomainError("proposal_content_changed", 409);
        const p = await one(
          c,
          "UPDATE proposals SET status=$3,accepted_by=$4,accepted_at=now(),revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [
            owner,
            prop.id,
            n === "proposal_accept" ? "accepted" : "revoked",
            "ui",
          ],
        );
        if (prop.kind === "continuation" && n === "proposal_accept") {
          await c.query(
            "UPDATE proposals SET status='revoked',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND work_item_id=$2 AND kind='continuation' AND id<>$3 AND status='accepted'",
            [owner, prop.work_item_id, prop.id],
          );
          await c.query(
            "UPDATE work_items SET accepted_continuation_id=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
            [owner, prop.work_item_id, prop.id],
          );
        }
        if (prop.kind === "continuation" && n === "proposal_revoke")
          await c.query(
            "UPDATE work_items SET accepted_continuation_id=NULL,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND accepted_continuation_id=$2",
            [owner, prop.id],
          );
        return p;
      }
      case "context_prepare": {
        const s = await this.makeSnapshot(c, b, a);
        return {
          ...s,
          preflight: await this.preflight(c, owner, s.body, b.requested_action),
        };
      }
      case "context_get": {
        const s = await this.row(c, "context_snapshots", owner, b.id);
        if (a.channel === "worker" || a.run_id) {
          const r = await this.row(
            c,
            "runs",
            owner,
            a.run_id ?? "00000000-0000-0000-0000-000000000000",
          );
          await this.scope(c, r, a, a.attempt_id);
          if (r.snapshot_id !== s.id)
            throw new DomainError("snapshot_scope_denied", 403);
        }
        return s;
      }
      case "run_create": {
        const s = await this.row(c, "context_snapshots", owner, b.snapshot_id);
        if (b.parent_run_id) await this.row(c, "runs", owner, b.parent_run_id);
        const run = await this.enqueue(
          c,
          s,
          b.kind,
          b.executor_id,
          b.trigger,
          owner,
          b.parent_run_id ?? null,
        );
        return {
          ...run,
          dispatch_intent:
            b.executor_id === "worker"
              ? null
              : {
                  run_id: run.id,
                  snapshot_id: s.id,
                  message: `Продолжи задачу ${s.work_item_id}; run_id=${run.id}; snapshot_id=${s.id}. Сначала получи контекст, затем claim_run. Область работы фиксирована.`,
                },
        };
      }
      case "run_get": {
        const r = await this.row(c, "runs", owner, b.id);
        if (a.channel === "worker" || a.run_id)
          await this.scope(c, r, a, a.attempt_id);
        return {
          ...r,
          result: r.result_ref
            ? await this.row(c, "run_results", owner, r.result_ref)
            : null,
        };
      }
      case "claim_run": {
        const r = await this.row(c, "runs", owner, b.id);
        if (r.executor_id !== a.executor_id)
          throw new DomainError("executor_mismatch", 403);
        if (r.cancellation_requested_at || terminal.has(r.status))
          throw new DomainError("run_not_claimable", 409);
        await this.active(c, owner, r.work_item_id);
        if (r.attempt_id) {
          if (
            r.status === "running" &&
            r.attempt_executor === a.executor_id + ":" + b.claimant_id
          )
            return r;
          throw new DomainError("claim_conflict", 409);
        }
        revision(r, b.expected_revision);
        const s = await this.row(c, "context_snapshots", owner, r.snapshot_id);
        const pf = await this.preflight(c, owner, s.body, r.kind);
        if (!pf.available) throw new DomainError("preflight_blocked", 409, pf);
        if (!["awaiting_executor", "dispatch_unknown"].includes(r.status))
          throw new DomainError("run_not_claimable", 409);
        return one(
          c,
          "UPDATE runs SET status='running',attempt_id=$3,attempt_executor=$4,lease_until=now()+interval '2 minutes',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, r.id, id(), a.executor_id + ":" + b.claimant_id],
        );
      }
      case "save_run_result": {
        const r = await this.row(c, "runs", owner, b.id);
        await this.scope(c, r, a, b.attempt_id);
        const s = await this.row(c, "context_snapshots", owner, r.snapshot_id);
        if (canonical(b.body.input_refs) !== canonical(s.body.input_refs))
          throw new DomainError("input_provenance_mismatch", 409);
        if (b.body.evidence_status === "VERIFIED" && !b.body.evidence.length)
          throw new DomainError("verification_evidence_required");
        for (const ref of b.body.artifact_refs)
          await one(
            c,
            "SELECT v.id FROM artifact_versions v JOIN artifact_links l ON l.artifact_id=v.artifact_id AND l.owner_id=v.owner_id WHERE v.owner_id=$1 AND v.id=$2 AND l.work_item_id=$3",
            [owner, ref, r.work_item_id],
          );
        let stale = false;
        for (const ref of s.body.input_refs) {
          const material = await this.row(
            c,
            "artifacts",
            owner,
            ref.artifact_id,
          );
          if (material.current_version_id !== ref.version_id) stale = true;
        }
        const w = await this.row(c, "work_items", owner, r.work_item_id);
        if (Number(w.revision) !== s.body.work_item_revision) stale = true;
        const decisions = (
          await c.query(
            "SELECT id,revision FROM proposals WHERE owner_id=$1 AND project_id=$2 AND (work_item_id IS NULL OR work_item_id=$3) AND kind='decision' AND status='accepted' ORDER BY id",
            [owner, r.project_id, r.work_item_id],
          )
        ).rows.map((x) => ({ id: x.id, revision: Number(x.revision) }));
        const oldDecisions = s.body.accepted_decisions
          .map((x: any) => ({ id: x.id, revision: Number(x.revision) }))
          .sort((a: any, b: any) => a.id.localeCompare(b.id));
        if (canonical(decisions) !== canonical(oldDecisions)) stale = true;
        const cancelled =
          !!r.cancellation_requested_at || r.status === "cancelled";
        if (terminal.has(r.status) && !cancelled)
          throw new DomainError("run_terminal", 409);
        if (
          !cancelled &&
          !["running", "unknown", "waiting_user"].includes(r.status)
        )
          throw new DomainError("run_not_running", 409);
        const result = await one(
          c,
          "INSERT INTO run_results(id,owner_id,run_id,attempt_id,body,stale_input,cancelled_run) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id(),
            owner,
            r.id,
            b.attempt_id,
            JSON.stringify({
              ...b.body,
              skill_versions: s.body.skill_versions,
            }),
            stale,
            cancelled,
          ],
        );
        if (!cancelled) {
          await this.active(c, owner, r.work_item_id);
          await c.query(
            "UPDATE runs SET status='succeeded',result_ref=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
            [owner, r.id, result.id],
          );
          if (r.kind === "execution")
            await this.event(c, owner, {
              project_id: r.project_id,
              work_item_id: r.work_item_id,
              source: "run",
              source_event_id: result.id,
              type: "result_ready",
              reason: stale
                ? "Готов кандидат: входы изменились"
                : "Результат сохранён в задаче",
              refs: [result.id],
            });
        }
        return {
          id: result.id,
          result,
          run: await this.row(c, "runs", owner, r.id),
        };
      }
      case "run_cancel": {
        const r = await this.row(c, "runs", owner, b.id);
        if (terminal.has(r.status)) return { ...r, no_op: true };
        revision(r, b.expected_revision);
        const status =
          !r.attempt_id && !r.provider_session_ref && !r.dispatch_intent_at
            ? "cancelled"
            : "cancel_requested";
        return one(
          c,
          "UPDATE runs SET cancellation_requested_at=COALESCE(cancellation_requested_at,now()),status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, r.id, status],
        );
      }
      case "dispatch_report": {
        const r = await this.row(c, "runs", owner, b.id);
        revision(r, b.expected_revision);
        if (!["awaiting_executor", "dispatch_unknown"].includes(r.status))
          throw new DomainError("dispatch_state_conflict", 409);
        return one(
          c,
          "UPDATE runs SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [
            owner,
            r.id,
            b.status === "unknown" ? "dispatch_unknown" : "awaiting_executor",
          ],
        );
      }
      case "run_transition": {
        const r = await this.row(c, "runs", owner, b.id);
        await this.scope(c, r, a, b.attempt_id);
        revision(r, b.expected_revision);
        if (terminal.has(r.status)) throw new DomainError("run_terminal", 409);
        let status = b.status;
        if (r.cancellation_requested_at) {
          if (!["unknown", "cancelled"].includes(status))
            throw new DomainError("cancel_requested", 409);
        } else if (status === "cancelled")
          throw new DomainError("cancellation_not_requested", 409);
        const updated = await one(
          c,
          "UPDATE runs SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, r.id, status],
        );
        if (["unknown", "blocked", "waiting_user", "failed"].includes(status))
          await this.event(c, owner, {
            project_id: r.project_id,
            work_item_id: r.work_item_id,
            source: "run_state",
            source_event_id: r.id + ":" + updated.revision,
            type: status === "waiting_user" ? "decision_required" : "obstacle",
            reason: b.reason,
            refs: [r.id],
          });
        return updated;
      }
      case "run_resume": {
        const r = await this.row(c, "runs", owner, b.id);
        revision(r, b.expected_revision);
        if (
          r.cancellation_requested_at ||
          terminal.has(r.status) ||
          !["blocked", "waiting_user"].includes(r.status)
        )
          throw new DomainError("run_cannot_resume", 409);
        const s = await this.row(c, "context_snapshots", owner, r.snapshot_id);
        const pf = await this.preflight(c, owner, s.body, r.kind);
        if (!pf.available) throw new DomainError("preflight_blocked", 409, pf);
        if (r.executor_id === "worker" && r.status === "waiting_user") {
          if (
            !r.provider_session_ref ||
            !r.provider_turn_id ||
            r.provider_wait_reason !== "PROVIDER_TURN_WAITING"
          )
            throw new DomainError("provider_action_requires_adapter", 409);
          if (!b.answer?.trim()) throw new DomainError("answer_required");
          await c.query(
            "INSERT INTO provider_inputs(id,owner_id,run_id,answer,baseline_turn_id) VALUES($1,$2,$3,$4,$5)",
            [id(), owner, r.id, b.answer, r.provider_turn_id],
          );
        }
        const resumed = await one(
          c,
          "UPDATE runs SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, r.id, r.attempt_id ? "running" : "awaiting_executor"],
        );
        return {
          ...resumed,
          ...(r.executor_id !== "worker"
            ? {
                dispatch_intent: {
                  run_id: r.id,
                  snapshot_id: r.snapshot_id,
                  answer: b.answer ?? null,
                },
              }
            : {}),
        };
      }
      case "attention_list": {
        const selectedProjects = b.project_id
          ? b.include_descendants
            ? await this.subtree(c, owner, b.project_id)
            : [b.project_id]
          : null;
        if (b.before_id)
          await this.row(c, "attention_events", owner, b.before_id);
        return (
          await c.query(
            `SELECT e.*,p.title project_title,w.title work_item_title FROM attention_events e JOIN projects p ON p.id=e.project_id AND p.owner_id=e.owner_id LEFT JOIN work_items w ON w.id=e.work_item_id AND w.owner_id=e.owner_id WHERE e.owner_id=$1 AND ($2::uuid[] IS NULL OR e.project_id=ANY($2)) AND ($3::text IS NULL OR e.type=$3) AND ($4='all' OR e.state=$4 OR ($4='open' AND e.state='snoozed' AND e.snoozed_until<=now())) AND ($5::timestamptz IS NULL OR e.created_at<$5) AND ($6::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM attention_events WHERE owner_id=$1 AND id=$6)) ORDER BY e.created_at DESC,e.id DESC LIMIT $7`,
            [
              owner,
              selectedProjects,
              b.type ?? null,
              b.state,
              b.before ?? null,
              b.before_id ?? null,
              b.limit,
            ],
          )
        ).rows;
      }
      case "request_attention":
        if (a.channel === "worker" || a.run_id) {
          const r = await this.row(
            c,
            "runs",
            owner,
            a.run_id ?? "00000000-0000-0000-0000-000000000000",
          );
          await this.scope(c, r, a, a.attempt_id);
          if (
            r.project_id !== b.project_id ||
            r.work_item_id !== b.work_item_id
          )
            throw new DomainError("attention_scope_denied", 403);
        }
        return this.event(c, owner, b);
      case "attention_update": {
        const e = await this.row(c, "attention_events", owner, b.id);
        revision(e, b.expected_revision);
        if (
          b.action === "snooze" &&
          (!b.snoozed_until || Date.parse(b.snoozed_until) <= Date.now())
        )
          throw new DomainError("future_snooze_required");
        if (b.action === "resolve" && !b.reason)
          throw new DomainError("resolution_required");
        return one(
          c,
          "UPDATE attention_events SET read_at=$3,state=$4,snoozed_until=$5,resolution=$6,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [
            owner,
            e.id,
            b.action === "read" ? new Date() : e.read_at,
            b.action === "read"
              ? e.state
              : b.action === "snooze"
                ? "snoozed"
                : "resolved",
            b.action === "snooze" ? b.snoozed_until : e.snoozed_until,
            b.action === "resolve" ? b.reason : e.resolution,
          ],
        );
      }
      case "skills_list":
        return (
          await c.query(
            "SELECT * FROM skills WHERE owner_id=$1 ORDER BY name,id",
            [owner],
          )
        ).rows;
      case "skill_register":
        return this.registerSkill(c, b, a);
      case "skill_select_version": {
        const s = await this.row(c, "skills", owner, b.id);
        revision(s, b.expected_revision);
        await one(
          c,
          "SELECT id FROM skill_versions WHERE owner_id=$1 AND skill_id=$2 AND id=$3",
          [owner, s.id, b.version_id],
        );
        return one(
          c,
          "UPDATE skills SET current_version_id=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, s.id, b.version_id],
        );
      }
      case "skill_package_read": {
        const v = await one(
          c,
          "SELECT v.*,s.name,s.origin FROM skill_versions v JOIN skills s ON s.id=v.skill_id AND s.owner_id=v.owner_id WHERE v.owner_id=$1 AND v.skill_id=$2 AND v.id=$3",
          [owner, b.id, b.version_id],
        );
        if (a.channel === "worker" || a.run_id) {
          const r = await this.row(
            c,
            "runs",
            owner,
            a.run_id ?? "00000000-0000-0000-0000-000000000000",
          );
          await this.scope(c, r, a, a.attempt_id);
          const s = await this.row(
            c,
            "context_snapshots",
            owner,
            r.snapshot_id,
          );
          if (
            !s.body.skill_versions.some(
              (x: any) => x.skill_id === b.id && x.version_id === b.version_id,
            )
          )
            throw new DomainError("skill_scope_denied", 403);
        }
        return v;
      }
      case "connector_register": {
        if (b.id) {
          const v = await this.row(c, "connectors", owner, b.id);
          revision(v, b.expected_revision);
          return one(
            c,
            "UPDATE connectors SET name=$3,origin=$4,transport=$5,location=$6,metadata=$7,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
            [
              owner,
              b.id,
              b.name,
              b.origin,
              b.transport,
              b.location,
              JSON.stringify(b.metadata),
            ],
          );
        }
        return one(
          c,
          "INSERT INTO connectors(id,owner_id,name,origin,transport,location,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id(),
            owner,
            b.name,
            b.origin,
            b.transport,
            b.location,
            JSON.stringify(b.metadata),
          ],
        );
      }
      case "capability_observe": {
        await this.row(c, "connectors", owner, b.connector_id);
        if (
          Date.parse(b.expires_at) <= Date.parse(b.observed_at) ||
          Date.parse(b.observed_at) > Date.now() + 5000
        )
          throw new DomainError("invalid_observation_time");
        return one(
          c,
          "INSERT INTO capability_observations(owner_id,connector_id,executor_id,capability,configured,reachable,authenticated,allowed,identity_ref,actions,observed_at,expires_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(owner_id,connector_id,executor_id,capability) DO UPDATE SET configured=excluded.configured,reachable=excluded.reachable,authenticated=excluded.authenticated,allowed=excluded.allowed,identity_ref=excluded.identity_ref,actions=excluded.actions,observed_at=excluded.observed_at,expires_at=excluded.expires_at,reason=excluded.reason RETURNING *",
          [
            owner,
            b.connector_id,
            b.executor_id,
            b.capability,
            b.configured,
            b.reachable,
            b.authenticated,
            b.allowed,
            b.identity_ref ?? null,
            JSON.stringify(b.actions),
            b.observed_at,
            b.expires_at,
            b.reason ?? null,
          ],
        );
      }
      case "capabilities_list": {
        if (a.run_id && b.executor_id && b.executor_id !== a.executor_id)
          throw new DomainError("executor_mismatch", 403);
        let permitted: string[] | null = null;
        if (a.channel === "worker" || a.run_id) {
          const r = await this.row(
            c,
            "runs",
            owner,
            a.run_id ?? "00000000-0000-0000-0000-000000000000",
          );
          await this.scope(c, r, a, a.attempt_id);
          const sn = await this.row(
            c,
            "context_snapshots",
            owner,
            r.snapshot_id,
          );
          permitted = [
            ...sn.body.requirements,
            ...sn.body.packages.flatMap((p: any) => p.requirements),
          ].map((x: any) => x.connector_id);
        }
        const rows = (
          await c.query(
            "SELECT c.*,o.executor_id,o.capability,o.configured,o.reachable,o.authenticated,o.allowed,o.observed_at,o.expires_at,o.reason,o.actions,o.identity_ref observed_identity_ref,(o.configured AND o.reachable AND o.authenticated AND o.allowed AND o.expires_at>now() AND o.observed_at>now()-($3*interval '1 millisecond') AND NOT(c.location='desktop' AND o.executor_id<>'desktop')) effective_available FROM connectors c LEFT JOIN capability_observations o ON o.connector_id=c.id AND o.owner_id=c.owner_id WHERE c.owner_id=$1 AND ($2::text IS NULL OR o.executor_id=$2) ORDER BY c.name,o.executor_id",
            [
              owner,
              b.executor_id ??
                (a.run_id
                  ? a.executor_id
                  : a.channel === "worker"
                    ? "worker"
                    : null),
              this.runtime.capability_max_age_ms,
            ],
          )
        ).rows;
        return rows
          .filter((x) => permitted === null || permitted.includes(x.id))
          .map((x) => {
            const external = this.runtime.external_mcp?.available(
              x.id,
              x.capability,
              "read",
            );
            const identityMatches =
              !external ||
              (x.transport === "http" &&
                x.location === "remote" &&
                x.metadata.identity_ref ===
                  this.runtime.external_mcp!.identityRef(x.id) &&
                x.observed_identity_ref === x.metadata.identity_ref);
            return {
              ...x,
              effective_available:
                !!x.effective_available &&
                identityMatches &&
                (x.executor_id !== "worker" ||
                  (this.runtime.worker_ready &&
                    this.workerReadConfigured(x.id, x.capability, "read"))),
              external_read_tools: identityMatches
                ? (this.runtime.external_mcp?.publicTools(x.id, x.capability) ??
                  [])
                : [],
            };
          });
      }
      case "recurring_job_save":
        return this.saveJob(c, b, a);
      case "recurring_job_activate":
      case "recurring_job_pause":
      case "recurring_job_retire": {
        const j = await this.row(c, "recurring_jobs", owner, b.id);
        revision(j, b.expected_revision);
        if (j.reference_only && n !== "recurring_job_retire")
          throw new DomainError("reference_only_schedule", 409);
        if (j.status === "retired")
          throw new DomainError("schedule_retired", 409);
        if (n === "recurring_job_retire") {
          if (j.reference_only && j.old_pause_status !== "confirmed")
            throw new DomainError("old_schedule_pause_unconfirmed", 409);
          if (j.status === "active")
            throw new DomainError("pause_before_retire", 409);
          const busy = await c.query(
            "SELECT r.id FROM runs r JOIN occurrences o ON o.run_id=r.id WHERE o.job_id=$1 AND r.status NOT IN ('succeeded','failed','cancelled')",
            [j.id],
          );
          if (busy.rowCount)
            throw new DomainError("stop_runs_before_retire", 409);
          return one(
            c,
            "UPDATE recurring_jobs SET status='retired',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, j.id],
          );
        }
        if (n === "recurring_job_activate") {
          if (j.status === "retired")
            throw new DomainError("schedule_retired", 409);
          await this.active(c, owner, j.work_item_id);
          if (j.replacement_ref && j.old_pause_status !== "confirmed")
            throw new DomainError("old_schedule_pause_unconfirmed", 409);
          if (
            j.executor_id !== "worker" ||
            !this.runtime.worker_ready ||
            !this.runtime.worker_model ||
            j.configuration.model !== this.runtime.worker_model ||
            !j.configuration.budget
          )
            throw new DomainError("worker_model_budget_required", 409);
          const w = await this.row(c, "work_items", owner, j.work_item_id);
          const pf = await this.preflight(c, owner, {
            ...j.configuration,
            executor_id: j.executor_id,
            work_item_id: w.id,
            project_id: w.project_id,
          });
          if (!pf.available)
            throw new DomainError("preflight_blocked", 409, pf);
          const slot = nextSlot(j.schedule, j.timezone, new Date());
          return one(
            c,
            "UPDATE recurring_jobs SET status='active',next_planned_at=$3,next_skipped_dst=$4,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, j.id, slot.at, slot.skipped_dst],
          );
        }
        return one(
          c,
          "UPDATE recurring_jobs SET status='paused',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, j.id],
        );
      }
      case "recurring_jobs_list":
        return (
          await c.query(
            "SELECT * FROM recurring_jobs WHERE owner_id=$1 AND ($2::uuid IS NULL OR work_item_id=$2) ORDER BY created_at,id",
            [owner, b.work_item_id ?? null],
          )
        ).rows;
      case "search": {
        const q = "%" + b.q.replace(/[\\%_]/g, "\\$&") + "%";
        return (
          await c.query(
            `SELECT * FROM (SELECT 'project' type,id,title,id project_id,NULL::uuid work_item_id FROM projects WHERE owner_id=$1 AND title ILIKE $2 UNION ALL SELECT 'task',id,title,project_id,id FROM work_items WHERE owner_id=$1 AND (title ILIKE $2 OR goal ILIKE $2) UNION ALL SELECT 'decision',id,body->>'statement',project_id,work_item_id FROM proposals WHERE owner_id=$1 AND kind='decision' AND body->>'statement' ILIKE $2 UNION ALL SELECT DISTINCT 'material',a.id,a.title,w.project_id,w.id FROM artifacts a JOIN artifact_links l ON l.artifact_id=a.id AND l.owner_id=a.owner_id JOIN work_items w ON w.id=l.work_item_id AND w.owner_id=l.owner_id JOIN artifact_versions v ON v.id=a.current_version_id AND v.owner_id=a.owner_id WHERE a.owner_id=$1 AND (a.title ILIKE $2 OR v.content ILIKE $2)) s ORDER BY type,title,id LIMIT $3`,
            [owner, q, b.limit],
          )
        ).rows;
      }
      case "workspace_export":
        return this.export(c, owner);
    }
  }
  async materialValue(b: any, kind: string, owner: string) {
    if (
      [b.content, b.base64, b.external_ref].filter((v) => v !== undefined)
        .length !== 1
    )
      throw new DomainError("one_material_value_required");
    if (kind === "text" && b.content !== undefined)
      return {
        content: b.content,
        blob_key: null,
        external_ref: null,
        content_hash: hash(b.content),
      };
    if (kind === "external" && b.external_ref)
      return {
        content: null,
        blob_key: null,
        external_ref: b.external_ref,
        content_hash: hash({
          url: b.external_ref,
          observed_revision: b.observed_revision ?? null,
        }),
      };
    if (kind === "file" && b.base64 !== undefined) {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          b.base64,
        )
      )
        throw new DomainError("invalid_base64");
      const bytes = Buffer.from(b.base64, "base64");
      if (bytes.length > 8 * 1024 * 1024)
        throw new DomainError("file_too_large", 413);
      const h = bytesHash(bytes),
        key = owner + "/" + h;
      await this.blobs.put(key, bytes);
      if (bytesHash(await this.blobs.get(key)) !== h)
        throw new DomainError("blob_verification_failed", 503);
      return {
        content: null,
        blob_key: key,
        external_ref: null,
        content_hash: h,
      };
    }
    throw new DomainError("material_kind_mismatch");
  }
  async workerMaterialScope(
    c: Client,
    a: Actor,
    material: string,
    version: string,
  ) {
    const r = await this.row(
      c,
      "runs",
      a.owner_id,
      a.run_id ?? "00000000-0000-0000-0000-000000000000",
    );
    await this.scope(c, r, a, a.attempt_id);
    const s = await this.row(c, "context_snapshots", a.owner_id, r.snapshot_id);
    if (
      !s.body.input_refs.some(
        (x: any) => x.artifact_id === material && x.version_id === version,
      )
    )
      throw new DomainError("material_scope_denied", 403);
  }
  async registerSkill(c: Client, b: any, a: Actor) {
    const paths = new Set<string>();
    let packageBytes = 0;
    for (const f of b.files) {
      if (
        f.path.startsWith("/") ||
        f.path.includes("\\") ||
        f.path.split("/").some((x: string) => !x || x === "." || x === "..") ||
        paths.has(f.path) ||
        /[\x00-\x1f]/.test(f.path)
      )
        throw new DomainError("unsafe_or_duplicate_package_path");
      paths.add(f.path);
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.toString("base64") !== f.base64)
        throw new DomainError("invalid_package_base64");
      packageBytes += bytes.length;
      if (packageBytes > 8 * 1024 * 1024)
        throw new DomainError("package_too_large", 413);
      if (bytesHash(bytes) !== f.sha256)
        throw new DomainError("package_hash_mismatch");
    }
    if (b.origin === "owned" && !paths.has("SKILL.md"))
      throw new DomainError("skill_main_required");
    if (b.origin !== "owned" && b.files.length)
      throw new DomainError("dependency_source_not_owned");
    const manifest = b.files
      .map((f: any) => ({ path: f.path, sha256: f.sha256, base64: f.base64 }))
      .sort((x: any, y: any) => x.path.localeCompare(y.path));
    if (
      hash(manifest.map((x: any) => ({ path: x.path, sha256: x.sha256 }))) !==
      b.digest
    )
      throw new DomainError("package_digest_mismatch");
    const owner = a.owner_id,
      s = b.id ? await this.row(c, "skills", owner, b.id) : { id: id() };
    if (b.id) {
      revision(s, b.expected_revision);
      if (s.origin !== b.origin)
        throw new DomainError("skill_origin_immutable");
    } else
      await c.query(
        "INSERT INTO skills(id,owner_id,name,origin,source_ref) VALUES($1,$2,$3,$4,$5)",
        [s.id, owner, b.name, b.origin, b.source_ref],
      );
    const v = await one(
      c,
      "INSERT INTO skill_versions(id,owner_id,skill_id,version,manifest,digest,requirements,triggers) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        id(),
        owner,
        s.id,
        b.version,
        JSON.stringify(manifest),
        b.digest,
        JSON.stringify(b.requirements),
        JSON.stringify(b.triggers),
      ],
    );
    const skill = await one(
      c,
      "UPDATE skills SET current_version_id=$3,name=$4,source_ref=$5,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
      [owner, s.id, v.id, b.name, b.source_ref],
    );
    return { id: s.id, skill, version: v };
  }
  async saveJob(c: Client, b: any, a: Actor) {
    await this.active(c, a.owner_id, b.work_item_id);
    nextSlot(b.schedule, b.timezone, new Date());
    if (b.executor_id !== "worker" && !b.reference_only)
      throw new DomainError("routine_requires_worker");
    if (
      b.configuration.requirements.some(
        (r: any) => !["read", "observe"].includes(r.action),
      )
    )
      throw new DomainError("routine_external_write_forbidden", 403);
    if (b.id) {
      const j = await this.row(c, "recurring_jobs", a.owner_id, b.id);
      revision(j, b.expected_revision);
      if (j.status === "active" || j.status === "retired")
        throw new DomainError("pause_before_edit", 409);
      return one(
        c,
        "UPDATE recurring_jobs SET work_item_id=$3,instruction=$4,instruction_revision=instruction_revision+1,schedule=$5,schedule_revision=schedule_revision+1,timezone=$6,executor_id=$7,configuration=$8,reference_only=$9,provider_ref=$10,replacement_ref=$11,old_pause_status=$12,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
        [
          a.owner_id,
          j.id,
          b.work_item_id,
          b.instruction,
          JSON.stringify(b.schedule),
          b.timezone,
          b.executor_id,
          JSON.stringify(b.configuration),
          b.reference_only,
          b.provider_ref ?? null,
          b.replacement_ref ?? null,
          b.old_pause_status ?? null,
        ],
      );
    }
    return one(
      c,
      "INSERT INTO recurring_jobs(id,owner_id,work_item_id,instruction,schedule,timezone,executor_id,configuration,reference_only,provider_ref,replacement_ref,old_pause_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [
        id(),
        a.owner_id,
        b.work_item_id,
        b.instruction,
        JSON.stringify(b.schedule),
        b.timezone,
        b.executor_id,
        JSON.stringify(b.configuration),
        b.reference_only,
        b.provider_ref ?? null,
        b.replacement_ref ?? null,
        b.old_pause_status ?? null,
      ],
    );
  }
  async export(c: Client, owner: string) {
    const tables = [
      "workspaces",
      "projects",
      "work_items",
      "artifacts",
      "artifact_versions",
      "artifact_links",
      "proposals",
      "skills",
      "skill_versions",
      "connectors",
      "capability_observations",
      "context_snapshots",
      "runs",
      "run_results",
      "provider_inputs",
      "recurring_jobs",
      "occurrences",
      "attention_events",
      "operation_receipts",
      "audit_events",
    ];
    const data: Record<string, unknown[]> = {},
      files: Record<string, string> = {};
    for (const table of tables)
      data[table] = (
        await c.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [owner])
      ).rows;
    for (const v of data.artifact_versions as any[])
      if (v.blob_key) {
        const bytes = await this.blobs.get(v.blob_key);
        if (bytesHash(bytes) !== v.content_hash)
          throw new DomainError("export_blob_hash_mismatch", 503);
        files[v.blob_key] = bytes.toString("base64");
      }
    return {
      format: "shared-workspace/1",
      created_at: new Date().toISOString(),
      data,
      files,
      manifest: {
        metadata_hash: hash(data),
        files: Object.entries(files).map(([key, b]) => ({
          key,
          sha256: bytesHash(Buffer.from(b, "base64")),
        })),
      },
    };
  }
}

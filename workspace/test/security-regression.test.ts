import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";
import { id, hash, DomainError } from "../src/db.js";
import { bytesHash } from "../src/storage.js";
import { Worker } from "../src/worker.js";
import { Auth } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { nextSlot } from "../src/schedule.js";
import type { Actor } from "../src/service.js";

async function setup(h: Awaited<ReturnType<typeof harness>>) {
  const p = await h.call("project_create", {
    operation_id: id(),
    title: "Verifier project",
  });
  const w = await h.call("work_item_create", {
    operation_id: id(),
    project_id: p.id,
    title: "Verifier work",
    goal: "Read authorized sources and save an internal result",
  });
  return { p, w };
}
async function packageVersion(
  h: Awaited<ReturnType<typeof harness>>,
  name: string,
  requirements: any[] = [],
) {
  const bytes = Buffer.from("# " + name + "\nUse only allowed tools.");
  const file = {
    path: "SKILL.md",
    base64: bytes.toString("base64"),
    sha256: bytesHash(bytes),
  };
  const r = await h.call("skill_register", {
    operation_id: id(),
    name,
    origin: "owned",
    source_ref: "synthetic verifier fixture",
    version: "1.0.0",
    requirements,
    triggers: [],
    files: [file],
    digest: hash([{ path: file.path, sha256: file.sha256 }]),
  });
  return { skill_id: r.id, version_id: r.version.id };
}
async function nativeDispatch(h: Awaited<ReturnType<typeof harness>>) {
  const c = await h.call("connector_register", {
    operation_id: id(),
    name: "Synthetic native dispatch",
    origin: "owned",
    transport: "native",
    location: "native",
    metadata: {},
  });
  await h.call("capability_observe", {
    operation_id: id(),
    connector_id: c.id,
    executor_id: "native",
    capability: "native.dispatch",
    configured: true,
    reachable: true,
    authenticated: true,
    allowed: true,
    actions: ["dispatch"],
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(),
  });
  return c;
}
const denied = (e: unknown) =>
  e instanceof DomainError && (e.status === 403 || e.status === 404);

test("independent regression: worker service credential cannot read material without a claimed run", async () => {
  const h = await harness();
  try {
    const { w } = await setup(h);
    const a = await h.call("artifact_add", {
      operation_id: id(),
      work_item_id: w.id,
      title: "Unrelated private file",
      kind: "file",
      base64: Buffer.from("secret fixture bytes").toString("base64"),
    });
    const worker: Actor = {
      owner_id: h.owner,
      channel: "worker",
      executor_id: "worker",
    };
    await assert.rejects(
      h.call("artifact_get", { id: a.id, version_id: a.version.id }, worker),
      denied,
    );
  } finally {
    await h.close();
  }
});

test("independent regression: selected skill requirements participate in preflight", async () => {
  const h = await harness();
  try {
    const { w } = await setup(h);
    const connector = await nativeDispatch(h);
    const skill = await packageVersion(h, "requires-unavailable-source", [
      { connector_id: connector.id, capability: "source.read", action: "read" },
    ]);
    const snapshot = await h.call("context_prepare", {
      operation_id: id(),
      work_item_id: w.id,
      contract_revision: "verifier-v1",
      requested_action: "execution",
      executor_id: "native",
      input_refs: [],
      skill_versions: [skill],
      requirements: [],
      authorization_refs: [],
    });
    assert.equal(
      snapshot.preflight.available,
      false,
      "Missing source.read dependency must block, even when caller omitted duplicate requirements",
    );
    const discussion = await h.call("context_prepare", {
      operation_id: id(),
      work_item_id: w.id,
      contract_revision: "verifier-v1",
      requested_action: "discussion",
      executor_id: "native",
      input_refs: [],
      skill_versions: [skill],
      requirements: [],
      authorization_refs: [],
    });
    assert.equal(
      discussion.preflight.available,
      true,
      "Discussion must not require external capabilities not yet used",
    );
  } finally {
    await h.close();
  }
});

test("independent regression: owner model cannot close human attention", async () => {
  const h = await harness();
  try {
    const { p, w } = await setup(h);
    const e = await h.call("request_attention", {
      operation_id: id(),
      project_id: p.id,
      work_item_id: w.id,
      source: "verifier",
      source_event_id: id(),
      type: "decision_required",
      reason: "Human must choose the target",
      refs: [],
    });
    await assert.rejects(
      h.call(
        "attention_update",
        {
          operation_id: id(),
          id: e.id,
          expected_revision: Number(e.revision),
          action: "resolve",
          reason: "Model resolved this",
        },
        h.model,
      ),
      denied,
    );
  } finally {
    await h.close();
  }
});

test("independent transport: valid owner model cannot accept, complete, archive, or mint UI credential", async () => {
  const h = await harness();
  const auth = new Auth({
    ownerId: h.owner,
    ownerSubject: "verifier-owner",
    uiOrigin: "http://localhost:3000",
    production: false,
    signingSecret: "verifier-signing-secret-at-least-32-characters",
    devHumanSecret: "separate-human-secret",
    devModelToken: "valid-owner-model-token",
  });
  const app = createServer(h.service, auth);
  try {
    const { p, w } = await setup(h);
    const prop = await h.call("proposal_record", {
      operation_id: id(),
      project_id: p.id,
      work_item_id: w.id,
      kind: "decision",
      body: { statement: "Synthetic proposed decision" },
    });
    const targets = [
      [
        "proposal_accept",
        {
          id: prop.id,
          expected_revision: Number(prop.revision),
          content_hash: hash(prop.body),
        },
      ],
      [
        "work_item_complete",
        {
          id: w.id,
          expected_revision: Number(w.revision),
          reason: "Manual test",
          evidence: [],
          manual_assessment: true,
        },
      ],
      [
        "work_item_archive",
        {
          id: w.id,
          expected_revision: Number(w.revision),
          reason: "Manual test",
        },
      ],
      [
        "project_archive",
        {
          id: p.id,
          expected_revision: Number(p.revision),
          reason: "Manual test",
        },
      ],
    ] as const;
    for (const [name, b] of targets) {
      const r = await app.inject({
        method: "POST",
        url: "/api/operations/" + name,
        headers: { authorization: "Bearer valid-owner-model-token" },
        payload: { operation_id: id(), ...b },
      });
      assert.equal(r.statusCode, 403, name);
      assert.equal(r.json().error.code, "human_ui_required");
    }
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/ui/session",
      headers: {
        authorization: "Bearer valid-owner-model-token",
        origin: "http://localhost:3000",
      },
      payload: {},
    });
    assert.equal(bootstrap.statusCode, 401);
    assert.equal(bootstrap.headers["set-cookie"], undefined);
  } finally {
    await app.close();
    await h.close();
  }
});

test("independent controlled race: provider create ID survives worker lease takeover without second create", async () => {
  const h = await harness();
  try {
    const { w } = await setup(h);
    const skill_versions = [
      await packageVersion(h, "loki"),
      await packageVersion(h, "run-roman-control-loop"),
    ];
    const snapshot = await h.call("context_prepare", {
      operation_id: id(),
      work_item_id: w.id,
      contract_revision: "verifier-worker-v1",
      requested_action: "execution",
      executor_id: "worker",
      input_refs: [],
      skill_versions,
      requirements: [],
      authorization_refs: [],
      model: "test-model",
      budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
    });
    const run = await h.call("run_create", {
      operation_id: id(),
      snapshot_id: snapshot.id,
      kind: "execution",
      executor_id: "worker",
      trigger: "manual",
    });
    let signalStarted!: () => void,
      resolveCreate!: (value: { id: string }) => void;
    const started = new Promise<void>((r) => (signalStarted = r));
    const pending = new Promise<{ id: string }>((r) => (resolveCreate = r));
    let creates = 0;
    const adapter = {
      async create() {
        creates++;
        signalStarted();
        return pending;
      },
      async retrieve(session: string) {
        return { id: session, state: "running" as const };
      },
      async cancel() {},
    };
    const a = new Worker(h.service, h.owner, () => adapter),
      b = new Worker(h.service, h.owner, () => adapter);
    const first = a.poll();
    await started;
    // Controlled failure injection in the private test database replaces a real 2-minute wait.
    await h.db.pool.query(
      "UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    await b.poll();
    resolveCreate({ id: "session_verifier_known" });
    await first;
    const stored = (
      await h.db.pool.query(
        "SELECT provider_session_ref,status,attempt_id FROM runs WHERE id=$1",
        [run.id],
      )
    ).rows[0];
    assert.equal(
      creates,
      1,
      "Takeover must never blindly create another provider session",
    );
    assert.equal(
      stored.provider_session_ref,
      "session_verifier_known",
      "An observed provider ID must remain durable for reconciliation",
    );
  } finally {
    await h.close();
  }
});

test("independent domain: CAS and idempotency preserve one confirmed logical change", async () => {
  const h = await harness();
  try {
    const { p } = await setup(h);
    const operation_id = id();
    const body = { operation_id, title: "Idempotent project" };
    const [first, repeat] = await Promise.all([
      h.call("project_create", body),
      h.call("project_create", body),
    ]);
    assert.equal(first.id, repeat.id);
    assert.equal(
      (
        await h.db.pool.query(
          "SELECT count(*)::int n FROM projects WHERE title=$1",
          [body.title],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      h.call("project_create", { ...body, title: "Conflicting payload" }),
      (e: unknown) =>
        e instanceof DomainError && e.code === "operation_conflict",
    );
    const updates = await Promise.allSettled(
      ["Client A", "Client B"].map((title) =>
        h.call("project_update", {
          operation_id: id(),
          id: p.id,
          expected_revision: Number(p.revision),
          title,
        }),
      ),
    );
    assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      updates.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof DomainError &&
          r.reason.code === "revision_conflict",
      ).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("independent provenance: revoked snapshot decision makes a late result stale", async () => {
  const h = await harness();
  try {
    const { p, w } = await setup(h);
    await nativeDispatch(h);
    const proposed = await h.call("proposal_record", {
      operation_id: id(),
      project_id: p.id,
      work_item_id: w.id,
      kind: "decision",
      body: { statement: "Use the old approved instruction" },
    });
    const accepted = await h.call("proposal_accept", {
      operation_id: id(),
      id: proposed.id,
      expected_revision: Number(proposed.revision),
      content_hash: hash(proposed.body),
    });
    const s = await h.call("context_prepare", {
      operation_id: id(),
      work_item_id: w.id,
      contract_revision: "verifier-v1",
      requested_action: "execution",
      executor_id: "native",
      input_refs: [],
      skill_versions: [],
      requirements: [],
      authorization_refs: [],
    });
    const r = await h.call("run_create", {
      operation_id: id(),
      snapshot_id: s.id,
      kind: "execution",
      executor_id: "native",
      trigger: "manual",
    });
    const claimant_id = id();
    const claimed = await h.call(
      "claim_run",
      {
        operation_id: id(),
        id: r.id,
        expected_revision: Number(r.revision),
        claimant_id,
      },
      h.model,
    );
    await h.call("proposal_revoke", {
      operation_id: id(),
      id: accepted.id,
      expected_revision: Number(accepted.revision),
      reason: "Human revoked the previous decision",
    });
    const rr = await h.call(
      "save_run_result",
      {
        operation_id: id(),
        id: r.id,
        attempt_id: claimed.attempt_id,
        body: {
          text: "Result following revoked decision",
          artifact_refs: [],
          input_refs: [],
          evidence_status: "PREPARED",
          evidence: [],
          limitations: [],
        },
      },
      { ...h.model, run_id: r.id, attempt_id: claimed.attempt_id, claimant_id },
    );
    assert.equal(
      rr.result.stale_input,
      true,
      "A revoked accepted decision is a changed contextual input",
    );
    assert.equal(rr.result.applied, false);
  } finally {
    await h.close();
  }
});

test("independent domain: archive rechecks old snapshot and cancellation cannot become success", async () => {
  const h = await harness();
  try {
    const { p, w } = await setup(h);
    await nativeDispatch(h);
    const s = await h.call("context_prepare", {
      operation_id: id(),
      work_item_id: w.id,
      contract_revision: "verifier-v1",
      requested_action: "execution",
      executor_id: "native",
      input_refs: [],
      skill_versions: [],
      requirements: [],
      authorization_refs: [],
    });
    const archived = await h.call("work_item_archive", {
      operation_id: id(),
      id: w.id,
      expected_revision: Number(w.revision),
      reason: "Human archive",
    });
    await assert.rejects(
      h.call("run_create", {
        operation_id: id(),
        snapshot_id: s.id,
        kind: "execution",
        executor_id: "native",
        trigger: "manual",
      }),
      (e: unknown) =>
        e instanceof DomainError && e.code === "work_item_archived",
    );
    const restored = await h.call("work_item_restore", {
      operation_id: id(),
      id: w.id,
      expected_revision: Number(archived.revision),
    });
    const r = await h.call("run_create", {
      operation_id: id(),
      snapshot_id: s.id,
      kind: "execution",
      executor_id: "native",
      trigger: "manual",
    });
    const claimant_id = id();
    const claimed = await h.call(
      "claim_run",
      {
        operation_id: id(),
        id: r.id,
        expected_revision: Number(r.revision),
        claimant_id,
      },
      h.model,
    );
    const actor = {
      ...h.model,
      run_id: r.id,
      attempt_id: claimed.attempt_id,
      claimant_id,
    };
    const cancelled = await h.call("run_cancel", {
      operation_id: id(),
      id: r.id,
      expected_revision: Number(claimed.revision),
    });
    await assert.rejects(
      h.call(
        "claim_run",
        {
          operation_id: id(),
          id: r.id,
          expected_revision: Number(cancelled.revision),
          claimant_id,
        },
        h.model,
      ),
      (e: unknown) =>
        e instanceof DomainError && e.code === "run_not_claimable",
    );
    await assert.rejects(
      h.call("work_item_archive", {
        operation_id: id(),
        id: w.id,
        expected_revision: Number(restored.revision),
        reason: "Archive with unknown stop",
      }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.code === "archive_requires_stop_and_pause",
    );
    const late = await h.call(
      "save_run_result",
      {
        operation_id: id(),
        id: r.id,
        attempt_id: claimed.attempt_id,
        body: {
          text: "Late result",
          artifact_refs: [],
          input_refs: [],
          evidence_status: "PREPARED",
          evidence: [],
          limitations: [],
        },
      },
      actor,
    );
    assert.equal(late.result.cancelled_run, true);
    assert.equal(late.result.applied, false);
    assert.notEqual(late.run.status, "succeeded");
    await h.call(
      "run_transition",
      {
        operation_id: id(),
        id: r.id,
        attempt_id: claimed.attempt_id,
        expected_revision: Number(cancelled.revision),
        status: "cancelled",
        reason: "Stopped in controlled fixture",
      },
      actor,
    );
    await h.call("work_item_archive", {
      operation_id: id(),
      id: w.id,
      expected_revision: Number(restored.revision),
      reason: "Confirmed stop",
    });
    await h.call("project_archive", {
      operation_id: id(),
      id: p.id,
      expected_revision: Number(p.revision),
      reason: "Human archive",
    });
    await assert.rejects(
      h.call("run_create", {
        operation_id: id(),
        snapshot_id: s.id,
        kind: "execution",
        executor_id: "native",
        trigger: "manual",
      }),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
  } finally {
    await h.close();
  }
});

test("independent scheduler: DST, duplicate slot, overlap, pause and downtime have distinct outcomes", async () => {
  const gap = nextSlot(
    { type: "daily", time: "02:30" },
    "Europe/Berlin",
    new Date("2026-03-28T23:00:00Z"),
  );
  assert.equal(gap.skipped_dst, true);
  const overlap = nextSlot(
    { type: "daily", time: "02:30" },
    "Europe/Berlin",
    new Date("2026-10-24T23:00:00Z"),
  );
  assert.equal(overlap.at.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(
    nextSlot(
      { type: "daily", time: "02:30" },
      "Europe/Berlin",
      overlap.at,
    ).at.toISOString(),
    "2026-10-26T01:30:00.000Z",
  );
  const h = await harness();
  try {
    const { w } = await setup(h);
    const skill_versions = [
      await packageVersion(h, "loki"),
      await packageVersion(h, "run-roman-control-loop"),
    ];
    const configuration = {
      input_refs: [],
      skill_versions,
      requirements: [],
      authorization_refs: [],
      model: "test-model",
      budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
    };
    const start = new Date("2030-01-01T00:00:00Z");
    const make = () =>
      h.call("recurring_job_save", {
        operation_id: id(),
        work_item_id: w.id,
        instruction: "Read only",
        schedule: {
          type: "interval",
          minutes: 1,
          anchor_at_utc: start.toISOString(),
        },
        timezone: "Europe/Moscow",
        executor_id: "worker",
        configuration,
      });
    const job = await make();
    const active = await h.call("recurring_job_activate", {
      operation_id: id(),
      id: job.id,
      expected_revision: Number(job.revision),
    });
    await h.db.pool.query(
      "UPDATE recurring_jobs SET next_planned_at=$2 WHERE id=$1",
      [job.id, start],
    );
    const worker = new Worker(h.service, h.owner, () => {
      throw new Error("No provider call is authorized by this scheduler test");
    });
    await Promise.all([
      worker.schedulerTick(start),
      worker.schedulerTick(start),
    ]);
    let rows = (
      await h.db.pool.query(
        "SELECT * FROM occurrences WHERE job_id=$1 ORDER BY planned_at_utc",
        [job.id],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "enqueued");
    await worker.schedulerTick(new Date(start.getTime() + 60000));
    rows = (
      await h.db.pool.query(
        "SELECT * FROM occurrences WHERE job_id=$1 ORDER BY planned_at_utc",
        [job.id],
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ["enqueued", "skipped_overlap"],
    );
    await h.call("recurring_job_pause", {
      operation_id: id(),
      id: job.id,
      expected_revision: Number(active.revision),
    });
    await worker.schedulerTick(new Date(start.getTime() + 120000));
    assert.equal(
      (
        await h.db.pool.query(
          "SELECT count(*)::int n FROM occurrences WHERE job_id=$1",
          [job.id],
        )
      ).rows[0].n,
      2,
    );
    const missed = await make();
    await h.call("recurring_job_activate", {
      operation_id: id(),
      id: missed.id,
      expected_revision: Number(missed.revision),
    });
    await h.db.pool.query(
      "UPDATE recurring_jobs SET next_planned_at=$2 WHERE id=$1",
      [missed.id, start],
    );
    await worker.schedulerTick(new Date(start.getTime() + 120001), true);
    const misses = (
      await h.db.pool.query(
        "SELECT outcome,run_id FROM occurrences WHERE job_id=$1",
        [missed.id],
      )
    ).rows;
    assert.equal(misses.length, 3);
    assert.ok(
      misses.every(
        (r) => r.outcome === "skipped_downtime" && r.run_id === null,
      ),
    );
  } finally {
    await h.close();
  }
});

test("independent retire lifecycle: human-only transition preserves history and cannot be revived through pause", async () => {
  const h = await harness();
  const auth = new Auth({
    ownerId: h.owner,
    ownerSubject: "verifier-owner",
    uiOrigin: "http://localhost:3000",
    production: false,
    signingSecret: "verifier-signing-secret-at-least-32-characters",
    devModelToken: "valid-owner-model-token",
  });
  const app = createServer(h.service, auth);
  try {
    const { w } = await setup(h);
    const skill_versions = [
      await packageVersion(h, "loki"),
      await packageVersion(h, "run-roman-control-loop"),
    ];
    const start = new Date("2030-02-01T00:00:00Z");
    const fields = {
      work_item_id: w.id,
      instruction: "Read internally; retain schedule history",
      schedule: {
        type: "interval",
        minutes: 1,
        anchor_at_utc: start.toISOString(),
      },
      timezone: "Europe/Moscow",
      executor_id: "worker",
      configuration: {
        input_refs: [],
        skill_versions,
        requirements: [],
        authorization_refs: [],
        model: "test-model",
        budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
      },
    };
    const draft = await h.call("recurring_job_save", {
      operation_id: id(),
      ...fields,
    });
    const model = await app.inject({
      method: "POST",
      url: "/api/operations/recurring_job_retire",
      headers: { authorization: "Bearer valid-owner-model-token" },
      payload: {
        operation_id: id(),
        id: draft.id,
        expected_revision: Number(draft.revision),
      },
    });
    assert.equal(model.statusCode, 403);
    assert.equal(model.json().error.code, "human_ui_required");
    const catalog = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer valid-owner-model-token",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert.equal(catalog.statusCode, 200);
    assert.ok(
      !catalog
        .json()
        .result.tools.some((t: any) => t.name === "recurring_job_retire"),
    );
    const retiredDraft = await h.call("recurring_job_retire", {
      operation_id: id(),
      id: draft.id,
      expected_revision: Number(draft.revision),
    });
    assert.equal(retiredDraft.status, "retired");

    const job = await h.call("recurring_job_save", {
      operation_id: id(),
      ...fields,
    });
    const active = await h.call("recurring_job_activate", {
      operation_id: id(),
      id: job.id,
      expected_revision: Number(job.revision),
    });
    await assert.rejects(
      h.call("recurring_job_retire", {
        operation_id: id(),
        id: job.id,
        expected_revision: Number(active.revision),
      }),
      (e: unknown) =>
        e instanceof DomainError && e.code === "pause_before_retire",
    );
    await h.db.pool.query(
      "UPDATE recurring_jobs SET next_planned_at=$2 WHERE id=$1",
      [job.id, start],
    );
    const worker = new Worker(h.service, h.owner, () => {
      throw new Error("Retirement fixture must not create a provider session");
    });
    await worker.schedulerTick(start);
    const occurrence = (
      await h.db.pool.query("SELECT * FROM occurrences WHERE job_id=$1", [
        job.id,
      ])
    ).rows[0];
    assert.equal(occurrence.outcome, "enqueued");
    const paused = await h.call("recurring_job_pause", {
      operation_id: id(),
      id: job.id,
      expected_revision: Number(active.revision),
    });
    await assert.rejects(
      h.call("recurring_job_retire", {
        operation_id: id(),
        id: job.id,
        expected_revision: Number(paused.revision),
      }),
      (e: unknown) =>
        e instanceof DomainError && e.code === "stop_runs_before_retire",
    );
    const run = await h.call("run_get", { id: occurrence.run_id });
    await h.call("run_cancel", {
      operation_id: id(),
      id: run.id,
      expected_revision: Number(run.revision),
    });
    await worker.poll();
    assert.equal((await h.call("run_get", { id: run.id })).status, "cancelled");
    const history = async () => ({
      occurrences: (
        await h.db.pool.query(
          "SELECT * FROM occurrences WHERE job_id=$1 ORDER BY id",
          [job.id],
        )
      ).rows,
      runs: (await h.db.pool.query("SELECT * FROM runs WHERE id=$1", [run.id]))
        .rows,
      snapshots: (
        await h.db.pool.query("SELECT * FROM context_snapshots WHERE id=$1", [
          run.snapshot_id,
        ])
      ).rows,
    });
    const before = await history();
    const retired = await h.call("recurring_job_retire", {
      operation_id: id(),
      id: job.id,
      expected_revision: Number(paused.revision),
    });
    assert.equal(retired.status, "retired");
    assert.deepEqual(await history(), before);
    await assert.rejects(
      h.call("recurring_job_activate", {
        operation_id: id(),
        id: job.id,
        expected_revision: Number(retired.revision),
      }),
      (e: unknown) => e instanceof DomainError && e.code === "schedule_retired",
    );
    await assert.rejects(
      h.call("recurring_job_save", {
        operation_id: id(),
        id: job.id,
        expected_revision: Number(retired.revision),
        ...fields,
      }),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    // A neighboring operation must not turn retired into paused and bypass the guards above.
    try {
      const pause = await h.call("recurring_job_pause", {
        operation_id: id(),
        id: job.id,
        expected_revision: Number(retired.revision),
      });
      assert.equal(
        pause.status,
        "retired",
        "Pause must not revive a retired job",
      );
    } catch (e) {
      assert.ok(e instanceof DomainError && e.code === "schedule_retired");
    }
    const listed = await h.call("recurring_jobs_list", { work_item_id: w.id });
    assert.equal(listed.find((j: any) => j.id === job.id).status, "retired");
    await worker.schedulerTick(new Date(start.getTime() + 120000));
    assert.deepEqual(await history(), before);
  } finally {
    await app.close();
    await h.close();
  }
});

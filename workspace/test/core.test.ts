import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";
import { id, hash, DomainError } from "../src/db.js";
import { bytesHash } from "../src/storage.js";
import { nextSlot } from "../src/schedule.js";
import { Worker } from "../src/worker.js";
import type { AgentsAdapter } from "../src/adapter-contract.js";

test("PostgreSQL domain, concurrency, worker and scheduler", async (t) => {
  const h = await harness();
  const { call, db, service, ui, model, owner } = h;
  const err = (code: string) => (e: any) =>
    e instanceof DomainError && e.code === code;
  const mut = (body: any) => ({ operation_id: id(), ...body });
  const p = await call("project_create", mut({ title: "ЯКС" }));
  const w = await call(
    "work_item_create",
    mut({ project_id: p.id, title: "Сезон", goal: "Проверить входы" }),
  );
  let con: any;
  await t.test("opening dashboard is read-only", async () => {
    const n = (await db.pool.query("SELECT count(*) FROM runs")).rows[0].count;
    await call("workspace_get");
    await call("project_get", { id: p.id });
    assert.equal(
      (await db.pool.query("SELECT count(*) FROM runs")).rows[0].count,
      n,
    );
  });
  await t.test("operation replay and conflicting payload", async () => {
    const b = mut({ title: "Один раз" });
    const a = await call("project_create", b);
    assert.equal((await call("project_create", b)).id, a.id);
    await assert.rejects(
      call("project_create", { ...b, title: "Другой" }),
      err("operation_conflict"),
    );
  });
  await t.test("two clients CAS and recursive cycle guard", async () => {
    const child = await call(
      "project_create",
      mut({ title: "Дочерний", parent_id: p.id }),
    );
    await assert.rejects(
      call(
        "project_update",
        mut({ id: p.id, expected_revision: 1, parent_id: child.id }),
      ),
      err("project_cycle"),
    );
    const pair = await Promise.allSettled(
      ["A", "B"].map((title) =>
        call(
          "project_update",
          mut({ id: child.id, expected_revision: 1, title }),
        ),
      ),
    );
    assert.equal(pair.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      pair.filter(
        (x) =>
          x.status === "rejected" &&
          (x.reason as any).code === "revision_conflict",
      ).length,
      1,
    );
  });
  await t.test(
    "human acceptance hash and model privilege separation",
    async () => {
      const proposal = await call(
        "proposal_record",
        mut({
          project_id: p.id,
          work_item_id: w.id,
          kind: "decision",
          body: { statement: "Использовать PostgreSQL" },
        }),
        model,
      );
      const body = mut({
        id: proposal.id,
        expected_revision: 1,
        content_hash: hash(proposal.body),
      });
      await assert.rejects(
        call("proposal_accept", body, model),
        err("human_ui_required"),
      );
      await assert.rejects(
        call("proposal_accept", { ...body, content_hash: "0".repeat(64) }),
        err("proposal_content_changed"),
      );
      assert.equal((await call("proposal_accept", body)).status, "accepted");
      await assert.rejects(
        call(
          "work_item_complete",
          mut({
            id: w.id,
            expected_revision: 1,
            reason: "x",
            evidence: [],
            manual_assessment: true,
          }),
          model,
        ),
        err("human_ui_required"),
      );
    },
  );
  await t.test(
    "attention dedup, read, snooze and resolve are distinct",
    async () => {
      const b = mut({
        project_id: p.id,
        work_item_id: w.id,
        source: "test",
        source_event_id: "same",
        type: "obstacle",
        reason: "Ошибка",
      });
      const e = await call("request_attention", b);
      assert.equal(
        (await call("request_attention", { ...b, operation_id: id() })).id,
        e.id,
      );
      const read = await call(
        "attention_update",
        mut({ id: e.id, expected_revision: 1, action: "read" }),
      );
      assert.equal(read.state, "open");
      await assert.rejects(
        call(
          "attention_update",
          mut({
            id: e.id,
            expected_revision: 2,
            action: "snooze",
            snoozed_until: new Date(0).toISOString(),
          }),
        ),
        err("future_snooze_required"),
      );
      const resolved = await call(
        "attention_update",
        mut({
          id: e.id,
          expected_revision: 2,
          action: "resolve",
          reason: "Исправлено",
        }),
      );
      assert.equal(resolved.state, "resolved");
    },
  );
  const a = await call(
    "artifact_add",
    mut({ work_item_id: w.id, title: "План", kind: "text", content: "v1" }),
  );
  await t.test("immutable version and file bytes", async () => {
    await assert.rejects(
      db.pool.query(
        "UPDATE artifact_versions SET content='changed' WHERE id=$1",
        [a.version.id],
      ),
      /immutable/,
    );
    const bytes = Buffer.from("точный файл");
    const f = await call(
      "artifact_add",
      mut({
        work_item_id: w.id,
        title: "Файл",
        kind: "file",
        base64: bytes.toString("base64"),
      }),
    );
    assert.equal(
      (await call("artifact_get", { id: f.id })).base64,
      bytes.toString("base64"),
    );
    assert.equal(f.version.content_hash, bytesHash(bytes));
  });
  con = await call(
    "connector_register",
    mut({
      name: "Host bridge",
      origin: "platform",
      transport: "native",
      location: "native",
      metadata: {},
    }),
  );
  await call(
    "capability_observe",
    mut({
      connector_id: con.id,
      executor_id: "native",
      capability: "native.dispatch",
      configured: true,
      reachable: true,
      authenticated: true,
      allowed: true,
      actions: ["dispatch"],
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(),
    }),
  );
  const snapshot = () =>
    call(
      "context_prepare",
      mut({
        work_item_id: w.id,
        contract_revision: "1",
        requested_action: "execution",
        executor_id: "native",
        input_refs: [{ artifact_id: a.id, version_id: a.version.id }],
        skill_versions: [],
        requirements: [],
      }),
    );
  const launch = async () => {
    const s = await snapshot();
    const r = await call(
      "run_create",
      mut({
        snapshot_id: s.id,
        kind: "execution",
        executor_id: "native",
        trigger: "manual",
      }),
    );
    const claimant = id();
    const claimed = await call(
      "claim_run",
      mut({ id: r.id, expected_revision: 1, claimant_id: claimant }),
      model,
    );
    return {
      s,
      r: claimed,
      actor: {
        ...model,
        run_id: r.id,
        attempt_id: claimed.attempt_id,
        claimant_id: claimant,
      },
    };
  };
  const result = (r: any, s: any) =>
    mut({
      id: r.id,
      attempt_id: r.attempt_id,
      body: {
        text: "Результат",
        input_refs: s.body.input_refs,
        evidence_status: "EXECUTED",
        evidence: [{ check: "Проверка", outcome: "Сделано" }],
      },
    });
  await t.test(
    "unclaimed cancellation is terminal and a late claim cannot start",
    async () => {
      const s = await snapshot();
      const r = await call(
        "run_create",
        mut({
          snapshot_id: s.id,
          kind: "execution",
          executor_id: "native",
          trigger: "manual",
        }),
      );
      const cancelled = await call(
        "run_cancel",
        mut({ id: r.id, expected_revision: Number(r.revision) }),
      );
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.cancellation_requested_at);
      await assert.rejects(
        call(
          "claim_run",
          mut({
            id: r.id,
            expected_revision: Number(cancelled.revision),
            claimant_id: id(),
          }),
          model,
        ),
        err("run_not_claimable"),
      );
    },
  );
  await t.test("fixed snapshot, competing claim and scoped actor", async () => {
    const { s, r, actor } = await launch();
    await assert.rejects(
      db.pool.query("UPDATE context_snapshots SET body='{}' WHERE id=$1", [
        s.id,
      ]),
      /immutable/,
    );
    await assert.rejects(
      call(
        "claim_run",
        mut({ id: r.id, expected_revision: 1, claimant_id: id() }),
        model,
      ),
      err("claim_conflict"),
    );
    assert.equal((await call("context_get", { id: s.id }, actor)).id, s.id);
    await assert.rejects(
      call("workspace_get", {}, actor),
      err("execution_scope_denied"),
    );
    await call("save_run_result", result(r, s), actor);
    assert.equal((await call("work_item_get", { id: w.id })).status, "planned");
  });
  await t.test(
    "stale input produces candidate and never updates task",
    async () => {
      const { s, r, actor } = await launch();
      await call(
        "artifact_version_create",
        mut({ id: a.id, expected_revision: 2, content: "v2" }),
      );
      const rr = await call("save_run_result", result(r, s), actor);
      assert.equal(rr.result.stale_input, true);
      assert.equal(rr.result.applied, false);
    },
  );
  await t.test("persistent cancellation fences late success", async () => {
    const { s, r, actor } = await launch();
    const cancel = await call(
      "run_cancel",
      mut({ id: r.id, expected_revision: Number(r.revision) }),
    );
    await assert.rejects(
      call(
        "project_archive",
        mut({ id: p.id, expected_revision: 1, reason: "Архив" }),
      ),
      err("archive_requires_stop_and_pause"),
    );
    await call(
      "run_transition",
      mut({
        id: r.id,
        attempt_id: r.attempt_id,
        expected_revision: Number(cancel.revision),
        status: "unknown",
        reason: "Исход отмены неизвестен",
      }),
      actor,
    );
    const rr = await call("save_run_result", result(r, s), actor);
    assert.equal(rr.result.cancelled_run, true);
    assert.equal(rr.result.applied, false);
    assert.equal(rr.run.status, "unknown");
    await assert.rejects(
      db.pool.query(
        "UPDATE runs SET cancellation_requested_at=NULL WHERE id=$1",
        [r.id],
      ),
      /irreversible/,
    );
    const latest = await call("run_get", { id: r.id });
    await call(
      "run_transition",
      mut({
        id: r.id,
        attempt_id: r.attempt_id,
        expected_revision: Number(latest.revision),
        status: "cancelled",
        reason: "Исполнитель подтвердил остановку",
      }),
      actor,
    );
  });
  const selected: any[] = [];
  for (const name of ["loki", "run-roman-control-loop"]) {
    const f = {
      path: "SKILL.md",
      base64: Buffer.from("Test package " + name).toString("base64"),
      sha256: bytesHash(Buffer.from("Test package " + name)),
    };
    const v = await call(
      "skill_register",
      mut({
        name,
        origin: "owned",
        source_ref: "test-only",
        version: "test",
        requirements: [],
        triggers: [],
        files: [f],
        digest: hash([{ path: f.path, sha256: f.sha256 }]),
      }),
    );
    selected.push({ skill_id: v.id, version_id: v.version.id });
  }
  const config = {
    input_refs: [],
    skill_versions: selected,
    requirements: [],
    authorization_refs: [],
    model: "test-model",
    budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
  };
  const workerRun = async () => {
    const s = await call(
      "context_prepare",
      mut({
        work_item_id: w.id,
        contract_revision: "1",
        requested_action: "execution",
        executor_id: "worker",
        ...config,
      }),
    );
    return call(
      "run_create",
      mut({
        snapshot_id: s.id,
        kind: "execution",
        executor_id: "worker",
        trigger: "manual",
      }),
    );
  };
  await t.test(
    "worker recovery retrieves same session and stores evidence",
    async () => {
      let created = 0;
      let retrieved = 0;
      const adapter: AgentsAdapter = {
        async create() {
          created++;
          return { id: "sess_test" };
        },
        async retrieve() {
          retrieved++;
          return {
            id: "sess_test",
            state: "succeeded",
            result: {
              text: "Готово",
              evidence_status: "EXECUTED",
              evidence: [{ check: "Provider", outcome: "completed" }],
              limitations: [],
            },
          };
        },
        async cancel() {},
      };
      const r = await workerRun();
      const x = new Worker(service, owner, () => adapter);
      await x.poll();
      assert.equal(created, 1);
      await db.pool.query(
        "UPDATE runs SET lease_until=now()-interval '1 minute' WHERE id=$1",
        [r.id],
      );
      const y = new Worker(service, owner, () => adapter);
      await y.poll();
      assert.equal(created, 1);
      assert.equal(retrieved, 1);
      assert.equal((await call("run_get", { id: r.id })).status, "succeeded");
    },
  );
  await t.test("unknown create is never blindly repeated", async () => {
    let creates = 0;
    const r = await workerRun();
    const x = new Worker(service, owner, () => ({
      async create() {
        creates++;
        throw new Error("network lost");
      },
      async retrieve() {
        throw new Error("no id");
      },
      async cancel() {},
    }));
    await x.poll();
    await x.poll();
    assert.equal(creates, 1);
    assert.equal((await call("run_get", { id: r.id })).status, "unknown");
    await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1", [r.id]);
  });
  await t.test(
    "DST gap is skipped and overlap chooses first occurrence once",
    () => {
      const gap = nextSlot(
        { type: "daily", time: "02:30" },
        "Europe/Berlin",
        new Date("2026-03-28T23:00:00Z"),
      );
      assert.equal(gap.skipped_dst, true);
      const first = nextSlot(
        { type: "daily", time: "02:30" },
        "Europe/Berlin",
        new Date("2026-10-24T23:00:00Z"),
      );
      assert.equal(first.at.toISOString(), "2026-10-25T00:30:00.000Z");
      assert.equal(
        nextSlot(
          { type: "daily", time: "02:30" },
          "Europe/Berlin",
          first.at,
        ).at.toISOString(),
        "2026-10-26T01:30:00.000Z",
      );
    },
  );
  await t.test(
    "scheduler unique occurrence, instruction snapshot and overlap",
    async () => {
      const j = await call(
        "recurring_job_save",
        mut({
          work_item_id: w.id,
          instruction: "Только эта инструкция",
          schedule: {
            type: "interval",
            minutes: 1,
            anchor_at_utc: "2026-01-01T00:00:00Z",
          },
          timezone: "Europe/Moscow",
          executor_id: "worker",
          configuration: config,
        }),
      );
      await call(
        "recurring_job_activate",
        mut({ id: j.id, expected_revision: 1 }),
      );
      const when = new Date(Date.now() - 1000);
      await db.pool.query(
        "UPDATE recurring_jobs SET next_planned_at=$2 WHERE id=$1",
        [j.id, when],
      );
      const worker = new Worker(service, owner, () => {
        throw new Error("scheduler must not dispatch");
      });
      await Promise.all([
        worker.schedulerTick(when),
        worker.schedulerTick(when),
      ]);
      const rows = (
        await db.pool.query("SELECT * FROM occurrences WHERE job_id=$1", [j.id])
      ).rows;
      assert.equal(rows.length, 1);
      const r = await call("run_get", { id: rows[0].run_id });
      const s = await call("context_get", { id: r.snapshot_id });
      assert.equal(s.body.instruction, "Только эта инструкция");
      const next = new Date(
        (
          await db.pool.query(
            "SELECT next_planned_at FROM recurring_jobs WHERE id=$1",
            [j.id],
          )
        ).rows[0].next_planned_at,
      );
      await worker.schedulerTick(next);
      assert.equal(
        (
          await db.pool.query(
            "SELECT outcome FROM occurrences WHERE job_id=$1 ORDER BY planned_at_utc DESC",
            [j.id],
          )
        ).rows[0].outcome,
        "skipped_overlap",
      );
    },
  );
  await t.test("downtime records skips without backfilling work", async () => {
    const old = new Date(Date.now() - 180000);
    const j = await call(
      "recurring_job_save",
      mut({
        work_item_id: w.id,
        instruction: "Не догонять",
        schedule: {
          type: "interval",
          minutes: 1,
          anchor_at_utc: old.toISOString(),
        },
        timezone: "Europe/Moscow",
        executor_id: "worker",
        configuration: config,
      }),
    );
    await call(
      "recurring_job_activate",
      mut({ id: j.id, expected_revision: 1 }),
    );
    await db.pool.query(
      "UPDATE recurring_jobs SET next_planned_at=$2 WHERE id=$1",
      [j.id, old],
    );
    const worker = new Worker(service, owner, () => {
      throw new Error("no dispatch");
    });
    await worker.schedulerTick(new Date(), true);
    const rows = (
      await db.pool.query(
        "SELECT outcome,run_id FROM occurrences WHERE job_id=$1",
        [j.id],
      )
    ).rows;
    assert.ok(rows.length >= 3);
    assert.ok(
      rows.every((x) => x.outcome === "skipped_downtime" && x.run_id === null),
    );
  });
  await t.test(
    "export contains exact bytes/hash manifest and owner isolation",
    async () => {
      const backup = await call("workspace_export");
      assert.equal(backup.manifest.metadata_hash, hash(backup.data));
      assert.equal(Object.keys(backup.files).length, 1);
      const foreign = { ...ui, owner_id: id() };
      await service.init(foreign.owner_id);
      await assert.rejects(
        call("project_get", { id: p.id }, foreign),
        err("not_found"),
      );
    },
  );
  await h.close();
});

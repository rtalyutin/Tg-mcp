import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";
import { Worker } from "../src/worker.js";
import { id, hash } from "../src/db.js";
import { bytesHash } from "../src/storage.js";
import type { AgentSessionState } from "../src/adapter-contract.js";
test("human provider reply is durable, scoped and waits for a new root turn", async (t) => {
  const h = await harness({ readyTasks: true });
  t.after(() => h.close());
  const { call } = h;
  const p = await call("project_create", {
      operation_id: id(),
      title: "Reply test",
    }),
    w = await call("work_item_create", {
      operation_id: id(),
      project_id: p.id,
      title: "Readonly",
      goal: "Read input",
    });
  const skills = [];
  for (const name of ["loki", "run-roman-control-loop"]) {
    const bytes = Buffer.from("# " + name),
      f = {
        path: "SKILL.md",
        base64: bytes.toString("base64"),
        sha256: bytesHash(bytes),
      };
    const r = await call("skill_register", {
      operation_id: id(),
      name,
      origin: "owned",
      source_ref: "synthetic test",
      version: "1",
      requirements: [],
      triggers: [],
      files: [f],
      digest: hash([{ path: f.path, sha256: f.sha256 }]),
    });
    skills.push({ skill_id: r.id, version_id: r.version.id });
  }
  const s = await call("context_prepare", {
    operation_id: id(),
    work_item_id: w.id,
    contract_revision: "1",
    requested_action: "execution",
    executor_id: "worker",
    input_refs: [],
    skill_versions: skills,
    requirements: [],
    model: "test-model",
    budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
  });
  const r = await call("run_create", {
    operation_id: id(),
    snapshot_id: s.id,
    kind: "execution",
    executor_id: "worker",
    trigger: "manual",
  });
  let state: AgentSessionState = {
      id: "sess_reply",
      state: "waiting_user",
      reason: "PROVIDER_TURN_WAITING",
      turn_id: "turn_old",
    },
    responses = 0;
  let key = "";
  const worker = new Worker(h.service, h.owner, () => ({
    async create() {
      return { id: "sess_reply" };
    },
    async retrieve() {
      return state;
    },
    async cancel() {},
    async respond(_sid, answer, k) {
      assert.equal(answer, "Продолжай чтение");
      responses++;
      key = k;
    },
  }));
  await worker.poll();
  await worker.poll();
  let run = await call("run_get", { id: r.id });
  assert.equal(run.status, "waiting_user");
  await assert.rejects(
    call(
      "run_resume",
      {
        operation_id: id(),
        id: r.id,
        expected_revision: Number(run.revision),
        answer: "Продолжай чтение",
      },
      h.model,
    ),
    /human_ui_required/,
  );
  const op = {
    operation_id: id(),
    id: r.id,
    expected_revision: Number(run.revision),
    answer: "Продолжай чтение",
  };
  await call("run_resume", op);
  await call("run_resume", op);
  await worker.poll();
  assert.equal(responses, 1);
  assert.ok(key);
  state = {
    id: "sess_reply",
    state: "succeeded",
    turn_id: "turn_old",
    result: {
      text: "Old output",
      evidence_status: "EXECUTED",
      evidence: [],
      limitations: [],
    },
  };
  await worker.poll();
  assert.equal(responses, 1);
  assert.equal((await call("run_get", { id: r.id })).status, "running");
  state = {
    ...state,
    turn_id: "turn_new",
    result: { ...state.result!, text: "New output" },
  };
  await worker.poll();
  run = await call("run_get", { id: r.id });
  assert.equal(run.status, "succeeded");
  assert.equal(run.result.body.text, "New output");
  assert.equal(
    (await h.db.pool.query("SELECT status FROM provider_inputs")).rows[0]
      .status,
    "reconciled",
  );
});

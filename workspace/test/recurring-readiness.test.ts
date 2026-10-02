import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";
import { DomainError, hash, id } from "../src/db.js";
import { bytesHash } from "../src/storage.js";
import { readyAttributes } from "./task-attributes-fixtures.js";

test("recurring activation captures trusted current task metadata and rechecks readiness when resumed", async () => {
  const h = await harness();
  const operation = (body: any) => ({ operation_id: id(), ...body });
  try {
    const project = await h.call(
      "project_create",
      operation({ title: "TEST recurring readiness" }),
    );
    const task = await h.call(
      "work_item_create",
      operation({ project_id: project.id, title: "TEST recurring task" }),
    );
    const versions = [];
    for (const name of ["loki", "run-roman-control-loop"]) {
      const bytes = Buffer.from(
        "# " + name + "\nTEST: use only allowed tools.",
      );
      const file = {
        path: "SKILL.md",
        base64: bytes.toString("base64"),
        sha256: bytesHash(bytes),
      };
      const registered = await h.call(
        "skill_register",
        operation({
          name,
          origin: "owned",
          source_ref: "synthetic recurring readiness fixture",
          version: "TEST",
          requirements: [],
          triggers: [],
          files: [file],
          digest: hash([{ path: file.path, sha256: file.sha256 }]),
        }),
      );
      versions.push({
        skill_id: registered.id,
        version_id: registered.version.id,
      });
    }
    const job = await h.call(
      "recurring_job_save",
      operation({
        work_item_id: task.id,
        instruction: "TEST: read known inputs",
        schedule: { type: "daily", time: "13:00" },
        timezone: "Europe/Moscow",
        executor_id: "worker",
        configuration: {
          input_refs: [],
          skill_versions: versions,
          requirements: [],
          authorization_refs: [],
          model: "test-model",
          budget: { amount: 1, currency: "USD", mode: "soft", period: "run" },
        },
      }),
    );
    const incomplete = (e: unknown) =>
      e instanceof DomainError &&
      e.code === "preflight_blocked" &&
      (e.details.obstacles as string[]).some((obstacle) =>
        obstacle.startsWith("Не заполнены реквизиты задачи:"),
      );
    await assert.rejects(
      h.call(
        "recurring_job_activate",
        operation({ id: job.id, expected_revision: Number(job.revision) }),
      ),
      incomplete,
    );
    const ready = await h.call(
      "work_item_attributes_update",
      operation({
        id: task.id,
        expected_revision: Number(task.revision),
        attributes: readyAttributes,
        reason: "TEST: confirmed readiness",
      }),
    );
    const active = await h.call(
      "recurring_job_activate",
      operation({ id: job.id, expected_revision: Number(job.revision) }),
    );
    assert.equal(active.status, "active");
    const paused = await h.call(
      "recurring_job_pause",
      operation({ id: job.id, expected_revision: Number(active.revision) }),
    );
    await h.call(
      "work_item_attributes_update",
      operation({
        id: task.id,
        expected_revision: Number(ready.revision),
        attributes: { accountable: null },
        reason: "TEST: now incomplete draft",
      }),
    );
    await assert.rejects(
      h.call(
        "recurring_job_activate",
        operation({ id: job.id, expected_revision: Number(paused.revision) }),
      ),
      incomplete,
    );
    const current = (
      await h.call("recurring_jobs_list", { work_item_id: task.id })
    )[0];
    assert.equal(current.status, "paused");
    assert.equal(Number(current.revision), Number(paused.revision));
    assert.equal(
      (await h.db.pool.query("SELECT count(*)::int n FROM runs")).rows[0].n,
      0,
    );
    assert.equal(
      (await h.db.pool.query("SELECT count(*)::int n FROM context_snapshots"))
        .rows[0].n,
      0,
    );
  } finally {
    await h.close();
  }
});

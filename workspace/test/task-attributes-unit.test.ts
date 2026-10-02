import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../src/db.js";
import { schemas, humanOnly, reads } from "../src/contracts.js";
import {
  defaultTaskParameters,
  taskReadiness,
  validateTaskAttributes,
} from "../src/task-attributes.js";
import { readyAttributes } from "./task-attributes-fixtures.js";
const err = (code: string) => (e: any) =>
  e instanceof DomainError && e.code === code;

test("task readiness distinguishes incomplete draft, unknown deadline and explicit absence", () => {
  assert.equal(taskReadiness(defaultTaskParameters, {}).ready, false);
  assert.equal(
    taskReadiness(defaultTaskParameters, readyAttributes).ready,
    true,
  );
  assert.equal(
    taskReadiness(defaultTaskParameters, {
      ...readyAttributes,
      deadline_mode: "unknown",
    }).ready,
    false,
  );
  assert.equal(
    taskReadiness(defaultTaskParameters, {
      ...readyAttributes,
      dependency_mode: "unknown",
    }).ready,
    false,
  );
  const date = { ...readyAttributes, deadline_mode: "date" };
  const missing = taskReadiness(defaultTaskParameters, date).missing.map(
    (x) => x.code,
  );
  assert.deepEqual(missing, ["due_at", "due_timezone"]);
  assert.equal(
    taskReadiness(defaultTaskParameters, {
      ...date,
      due_at: "2026-10-09T20:30:00+03:00",
      due_timezone: "Europe/Moscow",
    }).ready,
    true,
  );
  assert.equal(
    taskReadiness(defaultTaskParameters, {
      ...readyAttributes,
      task_type: "development",
    }).ready,
    false,
  );
  assert.equal(
    taskReadiness(defaultTaskParameters, {
      ...readyAttributes,
      task_type: "development",
      spec_ref: "test://spec-v2",
      environment: "staging",
    }).ready,
    true,
  );
});
test("performed and independently accepted evidence are separate completion gates", () => {
  const performed = {
    ...readyAttributes,
    execution_state: "executed",
    result_refs: ["test://result"],
  };
  assert.equal(
    taskReadiness(defaultTaskParameters, performed, "completion").ready,
    false,
  );
  assert.equal(
    taskReadiness(
      defaultTaskParameters,
      { ...performed, verification_state: "not_checked" },
      "completion",
    ).ready,
    false,
  );
  assert.equal(
    taskReadiness(
      defaultTaskParameters,
      {
        ...performed,
        verification_state: "rejected",
        verified_by: "TEST: verifier",
        verification_evidence: ["test://check"],
      },
      "completion",
    ).ready,
    false,
  );
  assert.equal(
    taskReadiness(
      defaultTaskParameters,
      {
        ...performed,
        verification_state: "accepted",
        verified_by: "TEST: verifier",
        verification_evidence: ["test://check"],
      },
      "completion",
    ).ready,
    true,
  );
  assert.equal(
    taskReadiness(defaultTaskParameters, readyAttributes, "blocked").ready,
    false,
  );
  assert.equal(
    taskReadiness(
      defaultTaskParameters,
      {
        blocker_reason: "TEST: вход отсутствует",
        unblock_condition: "TEST: вход получен",
      },
      "blocked",
    ).ready,
    true,
  );
});
test("typed input rejects ambiguity, invalid local dates, timezone and mixed cardinality", () => {
  validateTaskAttributes(defaultTaskParameters, readyAttributes);
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        acceptance_criteria: "wrong",
      }),
    err("invalid_task_parameter_cardinality"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, { priority: "urgent-ish" }),
    err("invalid_task_parameter_value"),
  );
  assert.throws(
    () => validateTaskAttributes(defaultTaskParameters, { budget: "250000" }),
    err("invalid_task_parameter_value"),
  );
  assert.throws(
    () => validateTaskAttributes(defaultTaskParameters, { budget: -1 }),
    err("negative_task_parameter"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        due_at: "2026-10-09T20:30",
      }),
    err("invalid_task_parameter_value"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        due_at: "2026-02-30T20:30:00Z",
      }),
    err("invalid_task_parameter_value"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        due_timezone: "Moscow-ish",
      }),
    err("invalid_task_timezone"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        deadline_mode: "none",
        due_at: "2026-10-09T20:30:00Z",
      }),
    err("task_deadline_mode_conflict"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        dependency_mode: "none",
        depends_on: ["9c750173-47f2-4d0a-84d8-6094e8a3a87a"],
      }),
    err("task_dependency_mode_conflict"),
  );
  assert.throws(
    () =>
      validateTaskAttributes(defaultTaskParameters, {
        unconfigured_parameter: "x",
      }),
    err("unknown_task_parameter"),
  );
});
test("new operations keep metadata configuration human-only and attributes available to model", () => {
  assert.equal(humanOnly.has("task_parameter_define"), true);
  assert.equal(humanOnly.has("work_item_attributes_update"), false);
  assert.equal(reads.has("task_parameter_list"), true);
  assert.equal(reads.has("work_item_attributes_get"), true);
  assert.throws(() =>
    schemas.work_item_attributes_update.parse({
      operation_id: "9c750173-47f2-4d0a-84d8-6094e8a3a87a",
      id: "9c750173-47f2-4d0a-84d8-6094e8a3a87a",
      expected_revision: 1,
      attributes: {},
      reason: "TEST",
    }),
  );
});

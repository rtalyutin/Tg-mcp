import test from "node:test";
import assert from "node:assert/strict";
import {
  attributePatch,
  draftOf,
  parseInput,
  rebaseDraft,
  visibleDefinitions,
} from "../src/attributes.js";

const definitions = [
  {
    code: "deadline_mode",
    label: "Режим срока",
    data_type: "string",
    options: ["unknown", "date", "none"],
  },
  {
    code: "due_at",
    label: "Срок",
    data_type: "datetime",
    required_when_code: "deadline_mode",
    required_when_value: "date",
  },
  { code: "criteria", label: "Критерии", data_type: "string", multiple: true },
  { code: "budget", label: "Бюджет", data_type: "number" },
  {
    code: "currency",
    label: "Валюта",
    data_type: "string",
    required_when_code: "budget",
    required_when_value: "present",
  },
  {
    code: "test_profile",
    label: "Настроенный параметр",
    data_type: "string",
    type_profile: "research",
  },
];
test("unset, unknown and no deadline remain three different stored values; dates require an explicit offset", () => {
  assert.deepEqual(attributePatch(definitions, {}, draftOf(definitions)), {});
  assert.deepEqual(
    attributePatch(definitions, {}, { deadline_mode: "unknown" }),
    { deadline_mode: "unknown" },
  );
  assert.deepEqual(
    attributePatch(
      definitions,
      { deadline_mode: "date" },
      { deadline_mode: "none" },
    ),
    { deadline_mode: "none" },
  );
  assert.throws(
    () => parseInput(definitions[1], "2026-10-09T20:30:00"),
    /часовым поясом/,
  );
  assert.equal(
    parseInput(definitions[1], "2026-10-09T20:30:00+03:00"),
    "2026-10-09T20:30:00+03:00",
  );
});
test("metadata drives profile and conditional fields; zero and false count as present", () => {
  assert.ok(
    visibleDefinitions(definitions, { deadline_mode: "date" }).some(
      (d) => d.code === "due_at",
    ),
  );
  assert.ok(
    !visibleDefinitions(definitions, { deadline_mode: "none" }).some(
      (d) => d.code === "due_at",
    ),
  );
  for (const value of [0, 10, false])
    assert.ok(
      visibleDefinitions(definitions, { budget: value }).some(
        (d) => d.code === "currency",
      ),
    );
  for (const value of [null, undefined, "", " ", []])
    assert.ok(
      !visibleDefinitions(definitions, { budget: value }).some(
        (d) => d.code === "currency",
      ),
    );
  assert.ok(
    visibleDefinitions(definitions, { task_type: "research" }).some(
      (d) => d.code === "test_profile",
    ),
  );
  assert.ok(
    !visibleDefinitions(definitions, { task_type: "content" }).some(
      (d) => d.code === "test_profile",
    ),
  );
});
test("patch contains only explicit edits and list cardinality is preserved", () => {
  const base = { criteria: ["A", "B"], budget: 0, deadline_mode: "unknown" };
  const draft = draftOf(definitions, base);
  assert.deepEqual(attributePatch(definitions, base, draft), {});
  draft.criteria = "A\nC";
  draft.budget = "";
  assert.deepEqual(attributePatch(definitions, base, draft), {
    criteria: ["A", "C"],
    budget: null,
  });
});
test("a stale response retains user edits, merges untouched fields and identifies concurrent edits", () => {
  const base = { criteria: ["A"], budget: 10 };
  const draft = draftOf(definitions, base);
  draft.criteria = "Owner draft";
  const result = rebaseDraft(definitions, base, draft, {
    criteria: ["Concurrent change"],
    budget: 20,
  });
  assert.equal(result.draft.criteria, "Owner draft");
  assert.equal(result.draft.budget, "20");
  assert.deepEqual(
    result.conflicts.map((d) => d.code),
    ["criteria"],
  );
  assert.deepEqual(
    attributePatch(
      definitions,
      { criteria: ["Concurrent change"], budget: 20 },
      result.draft,
    ),
    { criteria: ["Owner draft"] },
  );
});

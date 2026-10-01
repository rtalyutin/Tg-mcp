import test from "node:test";
import assert from "node:assert/strict";
import { dateLabel, rootOf, rowStatus, unwrap } from "../src/model.js";
test("Moscow midnight, invalid dates and missing current task remain explicit", () => {
  assert.equal(
    dateLabel("2026-09-30T22:00:00Z", new Date("2026-10-01T04:00:00Z")),
    "Сегодня, 01:00",
  );
  assert.equal(
    dateLabel("2026-09-30T20:30:00Z", new Date("2026-10-01T04:00:00Z")),
    "Вчера, 23:30",
  );
  assert.equal(dateLabel("bad"), "Нет изменений");
  assert.equal(
    rowStatus(
      { id: "root", status: "active" },
      { attention: [], active_runs: [], projects: [] },
    ).label,
    "Задача не выбрана",
  );
});
test("a descendant event/run belongs to its root; unknown is never represented as done", () => {
  const root = { id: "root", status: "active" },
    child = { id: "child", parent_id: "root" };
  const data = {
    projects: [root, child],
    attention: [],
    active_runs: [{ project_id: "child", status: "unknown" }],
  };
  assert.equal(rootOf("child", data.projects), "root");
  assert.equal(rowStatus(root, data).label, "Состояние уточняется");
  data.attention = [{ project_id: "child", type: "decision_required" }];
  assert.equal(rowStatus(root, data).label, "Нужно решение");
});
test("MCP error envelope cannot hydrate successful UI", () => {
  assert.throws(
    () =>
      unwrap({
        isError: true,
        structuredContent: { error: { code: "unauthenticated" } },
      }),
    /unauthenticated/,
  );
  assert.throws(
    () => unwrap({ data: null, error: { code: "not_found" } }),
    /not_found/,
  );
  assert.throws(() => unwrap({ unknown: true }), /invalid_response/);
});

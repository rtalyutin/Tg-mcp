import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// Exercises the actual SQL/contract with a synthetic embedded PostgreSQL engine.
// This does not attest native locks, production data or browser behavior.
test("attention filtering covers descendants beyond the first 50 and paginates equal microsecond timestamps", async () => {
  const db = new PGlite();
  const { WorkspaceService } = await import(
    new URL("../workspace/dist/src/service.js", import.meta.url).href
  );
  const { schemas } = await import(
    new URL("../workspace/dist/src/contracts.js", import.meta.url).href
  );
  try {
    await db.exec(
      await readFile(
        new URL("../workspace/migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    const owner = randomUUID(),
      other = randomUUID(),
      a = randomUUID(),
      b = randomUUID(),
      child = randomUUID();
    await db.query(
      "INSERT INTO workspaces(owner_id,title) VALUES($1,'Synthetic'),($2,'Other')",
      [owner, other],
    );
    await db.query(
      "INSERT INTO projects(id,owner_id,title) VALUES($1,$3,'A'),($2,$3,'B')",
      [a, b, owner],
    );
    await db.query(
      "INSERT INTO projects(id,owner_id,parent_id,title) VALUES($1,$2,$3,'B child')",
      [child, owner, b],
    );
    await db.query(
      "INSERT INTO attention_events(id,owner_id,project_id,source,source_event_id,type,reason,created_at) SELECT md5(i::text)::uuid,$1,$2,'fixture',i::text,'result_ready','Synthetic',TIMESTAMPTZ '2026-10-01 09:00:00.123456+00' FROM generate_series(1,151) i",
      [owner, a],
    );
    const event = randomUUID();
    await db.query(
      "INSERT INTO attention_events(id,owner_id,project_id,source,source_event_id,type,reason,created_at) VALUES($1,$2,$3,'fixture','old','decision_required','Old B decision','2026-09-30T09:00:00Z')",
      [event, owner, child],
    );
    const service = new WorkspaceService(
      {},
      {},
      { worker_ready: false, capability_max_age_ms: 600000 },
    );
    const c = {
      query: (sql: string, params: unknown[]) => db.query(sql, params),
    };
    const actor = { owner_id: owner, channel: "ui", executor_id: "native" };
    const read = (name: string, input: unknown) =>
      service.dispatch(c, name, schemas[name].parse(input), actor);
    const entry = await read("workspace_get", {});
    assert.equal(entry.attention.length, 50);
    assert.equal(
      entry.projects.find((p: { id: string }) => p.id === child).open_attention,
      1,
    );
    assert.deepEqual(
      entry.projects.find((p: { id: string }) => p.id === child)
        .attention_types,
      ["decision_required"],
    );
    const exact = await read("attention_list", {
      project_id: b,
      state: "open",
    });
    assert.equal(exact.length, 0);
    const branch = await read("attention_list", {
      project_id: b,
      include_descendants: true,
      state: "open",
    });
    assert.deepEqual(
      branch.map((e: { id: string }) => e.id),
      [event],
    );
    const first = await read("attention_list", { state: "open", limit: 100 });
    const next = await read("attention_list", {
      state: "open",
      limit: 100,
      before_id: first.at(-1).id,
    });
    assert.equal(first.length, 100);
    assert.equal(next.length, 52);
    assert.equal(
      new Set([...first, ...next].map((e: { id: string }) => e.id)).size,
      152,
    );
    await assert.rejects(
      service.dispatch(
        c,
        "attention_list",
        schemas.attention_list.parse({ before_id: event }),
        { ...actor, owner_id: other },
      ),
      /not_found/,
    );
  } finally {
    await db.close();
  }
});

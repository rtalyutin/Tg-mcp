import test from "node:test";
import assert from "node:assert/strict";
import { restoreExport } from "../src/backup.js";
import { DomainError, hash, id } from "../src/db.js";
import { harness } from "./harness.js";

const constructorTables = new Set([
  "entities",
  "entity_parameters",
  "entity_parameter_options",
  "entity_parameter_values",
  "entity_attribute_imports",
]);
const code = (name: string) => (e: unknown) =>
  e instanceof DomainError && e.code === name;
test("legacy shared-workspace/1 restore preserves the original hash and permits only exact known schemas", async () => {
  const source = await harness(),
    target = await harness();
  try {
    const p = await source.call("project_create", {
      operation_id: id(),
      title: "TEST legacy export",
    });
    const w = await source.call("work_item_create", {
      operation_id: id(),
      project_id: p.id,
      title: "TEST old task",
      goal: "TEST original goal",
    });
    await source.call("artifact_add", {
      operation_id: id(),
      work_item_id: w.id,
      title: "TEST binary",
      kind: "file",
      base64: Buffer.from("legacy exact binary").toString("base64"),
    });
    const current = JSON.parse(
      JSON.stringify(await source.call("workspace_export")),
    );
    const legacy = {
      ...current,
      data: Object.fromEntries(
        Object.entries(current.data).filter(
          ([name]) => !constructorTables.has(name),
        ),
      ),
    };
    legacy.manifest = { ...current.manifest, metadata_hash: hash(legacy.data) };
    const original = JSON.stringify(legacy),
      originalHash = legacy.manifest.metadata_hash;
    const partial = { ...legacy, data: { ...legacy.data, entities: [] } };
    partial.manifest = {
      ...legacy.manifest,
      metadata_hash: hash(partial.data),
    };
    await assert.rejects(
      restoreExport(target.db, target.service.blobs, source.owner, partial),
      code("backup_tables_mismatch"),
    );
    const extra = { ...legacy, data: { ...legacy.data, unknown_table: [] } };
    extra.manifest = { ...legacy.manifest, metadata_hash: hash(extra.data) };
    await assert.rejects(
      restoreExport(target.db, target.service.blobs, source.owner, extra),
      code("backup_tables_mismatch"),
    );
    const badHash = {
      ...legacy,
      manifest: { ...legacy.manifest, metadata_hash: "0".repeat(64) },
    };
    await assert.rejects(
      restoreExport(target.db, target.service.blobs, source.owner, badHash),
      code("invalid_backup"),
    );
    // The target harness initializes empty-owner parameter definitions. Remove
    // only that synthetic initialization before exercising real empty DB restore.
    await target.db.tx(target.owner, async (c) => {
      await c.query("DELETE FROM entity_parameter_options");
      await c.query("DELETE FROM entity_parameters");
      await c.query("DELETE FROM workspaces");
    });
    await restoreExport(target.db, target.service.blobs, source.owner, legacy);
    assert.equal(JSON.stringify(legacy), original);
    assert.equal(hash(legacy.data), originalHash);
    const restored = (
      await target.service.execute("workspace_export", {}, source.ui)
    ).data;
    const restoredLegacy = Object.fromEntries(
      Object.entries(restored.data).filter(
        ([name]) => !constructorTables.has(name),
      ),
    );
    assert.equal(hash(restoredLegacy), originalHash);
    assert.equal(restored.data.entities.length, 0);
    await target.service.init(source.owner);
    const task = (
      await target.service.execute("work_item_get", { id: w.id }, source.ui)
    ).data;
    assert.equal(task.goal, "TEST original goal");
    assert.equal(task.status, "planned");
    assert.equal(task.readiness.ready, false);
    assert.ok(task.attribute_definitions.length > 0);
    assert.equal(
      (await target.db.pool.query("SELECT count(*)::int n FROM entities"))
        .rows[0].n,
      1,
    );
    const artifact = restored.data.artifact_versions[0];
    assert.equal(
      (await target.service.blobs.get(artifact.blob_key)).toString(),
      "legacy exact binary",
    );
  } finally {
    await source.close();
    await target.close();
  }
});

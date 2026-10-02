import { Database, DomainError, hash } from "./db.js";
import { bytesHash, type BlobStore } from "./storage.js";
const tables = [
  "workspaces",
  "projects",
  "work_items",
  "entities",
  "entity_parameters",
  "entity_parameter_options",
  "entity_parameter_values",
  "entity_attribute_imports",
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
const constructorTables = new Set([
  "entities",
  "entity_parameters",
  "entity_parameter_options",
  "entity_parameter_values",
  "entity_attribute_imports",
]);
const legacyTables = tables.filter((table) => !constructorTables.has(table));
/** Offline administrator operation: only an empty migrated DB and the configured owner. */
export async function restoreExport(
  db: Database,
  blobs: BlobStore,
  owner: string,
  backup: any,
) {
  if (
    backup?.format !== "shared-workspace/1" ||
    !backup.data ||
    !backup.files ||
    !backup.manifest ||
    hash(backup.data) !== backup.manifest.metadata_hash
  )
    throw new DomainError("invalid_backup");
  const providedTables = Object.keys(backup.data).sort().join(",");
  const legacy = providedTables === [...legacyTables].sort().join(",");
  if (!legacy && providedTables !== [...tables].sort().join(","))
    throw new DomainError("backup_tables_mismatch");
  // Validate the original signed/hash-covered payload above. Normalization is
  // local only: never rewrite an older export or its integrity manifest.
  const data = legacy
    ? {
        ...backup.data,
        ...Object.fromEntries(
          [...constructorTables].map((table) => [table, []]),
        ),
      }
    : backup.data;
  if (
    backup.data.workspaces.length !== 1 ||
    backup.data.workspaces[0].owner_id !== owner
  )
    throw new DomainError("backup_owner_mismatch");
  if (
    !Array.isArray(backup.manifest.files) ||
    Object.keys(backup.files).length !== backup.manifest.files.length
  )
    throw new DomainError("backup_file_manifest_mismatch");
  const seen = new Set<string>();
  for (const f of backup.manifest.files) {
    if (
      seen.has(f.key) ||
      !f.key.startsWith(owner + "/") ||
      typeof backup.files[f.key] !== "string"
    )
      throw new DomainError("backup_file_manifest_mismatch");
    seen.add(f.key);
    const bytes = Buffer.from(backup.files[f.key], "base64");
    if (bytesHash(bytes) !== f.sha256 || f.key !== owner + "/" + f.sha256)
      throw new DomainError("backup_file_hash_mismatch");
  }
  return db.tx(owner, async (c) => {
    for (const table of tables) {
      if ((await c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)
        throw new DomainError("restore_requires_empty_database", 409);
    }
    for (const v of data.artifact_versions)
      if (v.blob_key && !seen.has(v.blob_key))
        throw new DomainError("backup_blob_missing");
    for (const f of backup.manifest.files) {
      const bytes = Buffer.from(backup.files[f.key], "base64");
      await blobs.put(f.key, bytes);
      if (bytesHash(await blobs.get(f.key)) !== f.sha256)
        throw new DomainError("restore_blob_verification_failed");
    }
    for (const table of tables) {
      if (!Array.isArray(data[table]))
        throw new DomainError("invalid_backup_rows");
      const columns = new Map(
        (
          await c.query(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
            [table],
          )
        ).rows.map((x) => [x.column_name, x.data_type] as const),
      );
      for (const row of data[table]) {
        if (row.owner_id !== owner)
          throw new DomainError("backup_owner_mismatch");
        const keys = Object.keys(row);
        if (!keys.length || keys.some((k) => !columns.has(k)))
          throw new DomainError("backup_columns_mismatch");
        const values = keys.map((k) =>
          row[k] !== null &&
          typeof row[k] === "object" &&
          columns.get(k) !== "ARRAY"
            ? JSON.stringify(row[k])
            : row[k],
        );
        await c.query(
          `INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
          values,
        );
      }
    }
    await c.query(
      "SELECT setval(pg_get_serial_sequence('audit_events','id'),COALESCE((SELECT max(id) FROM audit_events),1),(SELECT count(*)>0 FROM audit_events))",
    );
    return { restored: true, owner_id: owner };
  });
}

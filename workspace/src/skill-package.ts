import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hash } from "./db.js";
import { bytesHash } from "./storage.js";
import { schemas } from "./contracts.js";

/** A complete byte-preserving package, never a synthesized SKILL.md summary. */
export async function packOwnedSkill(
  directory: string,
  metadata: {
    name: string;
    version: string;
    source_ref: string;
    requirements?: {
      connector_id: string;
      capability: string;
      action: string;
    }[];
    triggers?: string[];
  },
) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Skill directory required");
  const files: { path: string; base64: string; sha256: string }[] = [];
  let bytes = 0;
  async function walk(dir: string, relative = "") {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (
        [".git", "node_modules"].includes(entry.name) ||
        /^\.env(?:\.|$)/.test(entry.name)
      )
        throw new Error(
          "Remove repository/dependency/credential files before packaging",
        );
      if (entry.name.includes("\\") || /[\x00-\x1f]/.test(entry.name))
        throw new Error("Unsafe skill path");
      const file = join(dir, entry.name),
        path = relative ? relative + "/" + entry.name : entry.name;
      const stat = await lstat(file);
      if (stat.isSymbolicLink())
        throw new Error("Skill symlinks are forbidden");
      if (stat.isDirectory()) {
        await walk(file, path);
        continue;
      }
      if (
        !stat.isFile() ||
        files.length >= 500 ||
        bytes + stat.size > 8 * 1024 * 1024
      )
        throw new Error("Skill package limit: 500 files / 8 MiB");
      const data = await readFile(file);
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) throw new Error("Skill package size limit");
      files.push({
        path,
        base64: data.toString("base64"),
        sha256: bytesHash(data),
      });
    }
  }
  await walk(root);
  if (!files.some((x) => x.path === "SKILL.md"))
    throw new Error("SKILL.md required");
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = hash(files.map(({ path, sha256 }) => ({ path, sha256 })));
  const { operation_id: _, ...body } = schemas.skill_register.parse({
    operation_id: "00000000-0000-4000-8000-000000000000",
    origin: "owned",
    ...metadata,
    requirements: metadata.requirements ?? [],
    triggers: metadata.triggers ?? [],
    files,
    digest,
  });
  return body;
}

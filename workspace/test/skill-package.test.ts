import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packOwnedSkill } from "../src/skill-package.js";
import { harness } from "./harness.js";
import { id, DomainError } from "../src/db.js";
const exec = promisify(execFile);
test("complete skill package: bytes, CLI and immutable import", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workspace-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "owned");
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "assets"));
  const originals: Record<string, Buffer> = {
    "SKILL.md": Buffer.from("---\nname: synthetic\n---\n# Exact\r\n"),
    "references/contract.md": Buffer.from("Русский текст\n"),
    "scripts/task.py": Buffer.from("print('fixture')\n"),
    "assets/bytes.bin": Buffer.from([0, 1, 255, 128]),
  };
  for (const [path, bytes] of Object.entries(originals))
    await writeFile(join(root, path), bytes);
  const metadata = {
    name: "synthetic",
    version: "1",
    source_ref: "owned synthetic fixture",
  };
  const body = await packOwnedSkill(root, metadata);
  await t.test(
    "entire directory bytes preserved and deterministic",
    async () => {
      assert.equal(body.files.length, 4);
      for (const f of body.files)
        assert.deepEqual(Buffer.from(f.base64, "base64"), originals[f.path]);
      assert.deepEqual(await packOwnedSkill(root, metadata), body);
    },
  );
  await t.test(
    "CLI writes exclusive private package without DB or installation",
    async () => {
      const output = join(dir, "package.json");
      await exec(process.execPath, [
        "--import",
        "tsx",
        "scripts/pack-skill.ts",
        "--directory",
        root,
        "--name",
        metadata.name,
        "--version",
        metadata.version,
        "--source-ref",
        metadata.source_ref,
        "--output",
        output,
      ]);
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")), body);
      await assert.rejects(
        exec(process.execPath, [
          "--import",
          "tsx",
          "scripts/pack-skill.ts",
          "--directory",
          root,
          "--name",
          metadata.name,
          "--version",
          metadata.version,
          "--source-ref",
          metadata.source_ref,
          "--output",
          output,
        ]),
        /EEXIST/,
      );
    },
  );
  await t.test(
    "symlink and credential files are rejected, never silently omitted",
    async () => {
      const link = join(root, "linked");
      await symlink(join(root, "SKILL.md"), link);
      await assert.rejects(packOwnedSkill(root, metadata), /symlinks/);
      await rm(link);
      await writeFile(join(root, ".env"), "SYNTHETIC=secret");
      await assert.rejects(packOwnedSkill(root, metadata), /credential files/);
      await rm(join(root, ".env"));
    },
  );
  const h = await harness();
  t.after(() => h.close());
  await t.test(
    "registration replay and new immutable version retain original bytes",
    async () => {
      const input = { operation_id: id(), ...body };
      const first = await h.call("skill_register", input);
      assert.equal(
        (await h.call("skill_register", input)).version.id,
        first.version.id,
      );
      await writeFile(join(root, "references/contract.md"), "changed");
      const next = await h.call("skill_register", {
        operation_id: id(),
        ...(await packOwnedSkill(root, { ...metadata, version: "2" })),
        id: first.id,
        expected_revision: Number(first.skill.revision),
      });
      assert.notEqual(next.version.id, first.version.id);
      const old = await h.call("skill_package_read", {
        id: first.id,
        version_id: first.version.id,
      });
      assert.deepEqual(old.manifest, body.files);
      assert.equal(old.digest, body.digest);
    },
  );
  await t.test(
    "malformed base64 and control-character paths rejected by server",
    async () => {
      await assert.rejects(
        h.call("skill_register", {
          operation_id: id(),
          ...body,
          files: body.files.map((f) => ({ ...f, base64: f.base64 + "!" })),
        }),
        (e) => e instanceof DomainError && e.code === "invalid_package_base64",
      );
      await assert.rejects(
        h.call("skill_register", {
          operation_id: id(),
          ...body,
          files: body.files.map((f) => ({ ...f, path: f.path + "\n" })),
        }),
        (e) =>
          e instanceof DomainError &&
          e.code === "unsafe_or_duplicate_package_path",
      );
    },
  );
});

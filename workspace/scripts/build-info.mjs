import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
const root = resolve("..");
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile()) files.push(child);
  }
}
await walk(resolve("src"));
await walk(resolve("migrations"));
await walk(resolve(root, "src"));
await walk(resolve("ui/src"));
await walk(resolve("ui/scripts"));
files.push(
  resolve("package.json"),
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve("scripts/build-info.mjs"),
  resolve("ui/package.json"),
  resolve("tsconfig.json"),
  resolve(root, "tsconfig.json"),
  resolve(root, "tsconfig.build.json"),
);
const digest = createHash("sha256");
for (const path of files.sort()) {
  digest.update(relative(root, path));
  digest.update("\0");
  digest.update(await readFile(path));
  digest.update("\0");
}
const build = { version: "1.1.0", source_digest: digest.digest("hex") };
await writeFile("dist/build-info.json", JSON.stringify(build) + "\n");
console.log(
  `WORKSPACE_BUILD version=${build.version} source_digest=${build.source_digest}`,
);

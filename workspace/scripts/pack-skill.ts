import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { packOwnedSkill } from "../src/skill-package.js";
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    "source-ref": { type: "string" },
    output: { type: "string" },
    metadata: { type: "string" },
  },
});
if (
  !values.directory ||
  !values.name ||
  !values.version ||
  !values["source-ref"] ||
  !values.output
)
  throw new Error(
    "Required: --directory --name --version --source-ref --output; optional --metadata JSON with requirements/triggers",
  );
const metadata = values.metadata
  ? JSON.parse(await readFile(values.metadata, "utf8"))
  : {};
if (
  Object.keys(metadata).some((x) => !["requirements", "triggers"].includes(x))
)
  throw new Error("Metadata accepts requirements/triggers only");
const body = await packOwnedSkill(values.directory, {
  ...metadata,
  name: values.name,
  version: values.version,
  source_ref: values["source-ref"],
});
await writeFile(values.output, JSON.stringify(body, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    digest: body.digest,
    files: body.files.length,
    status: "packaged; not installed",
    output: values.output,
  }),
);

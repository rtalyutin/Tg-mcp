import { parseArgs } from "node:util";
import { ExternalMcpGateway } from "../src/external-mcp.js";
const { values } = parseArgs({
  options: { config: { type: "string" }, connector: { type: "string" } },
});
if (!values.config || !values.connector)
  throw new Error("Required: --config --connector");
console.log(
  JSON.stringify(
    await ExternalMcpGateway.fromFile(values.config).probe(values.connector),
    null,
    2,
  ),
);

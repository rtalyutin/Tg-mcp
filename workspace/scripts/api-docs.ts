import { writeFile } from "node:fs/promises";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { schemas, reads, humanOnly } from "../src/contracts.js";
const paths: Record<string, unknown> = {};
for (const [name, schema] of Object.entries(schemas))
  paths["/api/operations/" + name] = {
    post: {
      operationId: name,
      summary: name,
      tags: [name.split("_")[0]],
      "x-read-only": reads.has(name as any),
      "x-human-only": humanOnly.has(name as any),
      security: [{ ownerBearer: [] }, { humanCookie: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: toJsonSchemaCompat(schema, {
              pipeStrategy: "input",
              strictUnions: true,
            }),
          },
        },
      },
      responses: {
        "200": {
          description:
            "Committed result; mutation includes operation receipt. claim_run includes a separate execution_token.",
        },
        "400": { description: "Invalid input" },
        "401": { description: "Authentication required" },
        "403": { description: "Channel or scope denied" },
        "409": { description: "Revision/operation/state conflict" },
      },
    },
  };
const document = {
  openapi: "3.1.0",
  info: { title: "Совместная работа Backend", version: "1.0.1" },
  paths,
  components: {
    securitySchemes: {
      ownerBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      humanCookie: { type: "apiKey", in: "cookie", name: "workspace_ui" },
    },
  },
};
await writeFile("docs/openapi.json", JSON.stringify(document, null, 2) + "\n");
console.log("OpenAPI generated from operation schemas");

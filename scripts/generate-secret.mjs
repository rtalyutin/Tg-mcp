import { randomBytes } from 'node:crypto';
// Run privately. Paste ONLY into Timeweb MCP_PATH_SECRET; never commit the result.
console.log(randomBytes(32).toString('hex'));

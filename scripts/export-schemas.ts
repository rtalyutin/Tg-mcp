import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { publishInputSchema, attemptInputSchema, publishResultSchema } from '../src/publisher.ts';

// Build-time artifacts only; the running publisher never imports fs.
mkdirSync(new URL('../schemas/', import.meta.url), { recursive: true });
for (const [name, schema] of Object.entries({ 'publish-input': publishInputSchema, 'attempt-input': attemptInputSchema, 'publish-result': publishResultSchema })) {
  writeFileSync(new URL(`../schemas/${name}.json`, import.meta.url), JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}

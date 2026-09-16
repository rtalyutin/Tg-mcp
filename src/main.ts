import { startLocalProbe } from './server.ts';

if (process.env.NODE_ENV === 'production' || (process.env.HOST && process.env.HOST !== '127.0.0.1')) {
  throw new Error('Local probe only: production OAuth and remote binding are not implemented');
}
if (process.env.PUBLISH_ENABLED && process.env.PUBLISH_ENABLED !== 'false') {
  throw new Error('This build cannot enable publishing');
}
const probe = await startLocalProbe(process.env.LOCAL_PROBE_TOKEN ?? '', Number(process.env.PORT ?? 3000));
console.log(`Local read-only probe: ${probe.url}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (!stopping) { stopping = true; void probe.close(); }
});

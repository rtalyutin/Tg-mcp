import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';

// Actual compiled production entrypoint. Empty environment includes NO app variables.
// Connections go to 127.0.0.1; Host is synthetic HTTP routing, not external DNS/network.
function launch(env = {}, args = []) {
  const child = spawn(process.execPath, ['dist/production-main.js', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = once(child, 'close'); const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  return { child, closed, output: () => ({ stdout, stderr }), dispose: () => clearTimeout(timer) };
}
async function ready(run) {
  for (let i = 0; i < 100; i++) {
    const out = run.output(); if (out.stdout.includes('PUBLISHER_STARTED')) return;
    assert.equal(run.child.exitCode, null, `startup exited: ${out.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('startup deadline');
}
function http(path, body, host = 'rtalyutin-tg-mcp-fb9b.twc1.net') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 8080, path, method: body ? 'POST' : 'GET', agent: false,
      headers: { host, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-forwarded-proto': 'https' } }, res => {
      let raw = ''; res.on('data', b => { raw += b; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('HTTP deadline'))); req.end(body);
  });
}
const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
for (const signal of ['SIGTERM', 'SIGINT']) {
  const run = launch({});
  try {
    await ready(run);
    assert.deepEqual(await http('/healthz', undefined, 'internal:8080'), { status: 200, body: { status: 'ok' } });
    const listing = await http('/mcp', rpc('tools/list')); assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.result.tools.map(t => t.name), ['get_publisher_status']);
    assert.deepEqual(listing.body.result.tools[0].securitySchemes, [{ type: 'noauth' }]);
    const status = await http('/mcp', rpc('tools/call', { name: 'get_publisher_status', arguments: {} }));
    assert.equal(status.status, 200); assert.equal(status.body.result.structuredContent.publish_enabled, false);
    assert.equal(status.body.result.structuredContent.telegram_ready, false);
    run.child.kill(signal); assert.deepEqual(await run.closed, [0, null]);
    assert.deepEqual(run.output(), { stdout: 'PUBLISHER_STARTED profile=readonly publish_enabled=false auth=public\n', stderr: '' });
    console.log(`PASS empty-env built production: port8080, public readonly MCP, internal health, ${signal} exit0`);
  } finally { run.child.kill('SIGKILL'); run.dispose(); }
}
for (const env of [{ MCP_AUTH_MODE: 'oauth' }, { MCP_AUTH_MODE: 'secret_path' }, { OAUTH_ISSUER: '' }, { MCP_PATH_SECRET: '' }]) {
  const run = launch(env);
  try {
    assert.deepEqual(await run.closed, [1, null]); const out = run.output(); assert.equal(out.stdout, ''); assert.match(out.stderr, /^CONFIG_INVALID:/);
  } finally { run.child.kill('SIGKILL'); run.dispose(); }
}
console.log('PASS built incomplete auth: four explicit/partial settings fail before startup, no anonymous fallback');
const checked = launch({}, ['--check-config']);
try {
  assert.deepEqual(await checked.closed, [0, null]); assert.deepEqual(checked.output(), { stdout: 'CONFIG_VALID\n', stderr: '' });
  console.log('PASS empty-env built --check-config: no credentials or network required');
} finally { checked.child.kill('SIGKILL'); checked.dispose(); }
console.log('4/4 built public production groups PASS');

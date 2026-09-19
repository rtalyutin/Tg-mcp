import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';

// Actual compiled production entrypoint with isolated environment, local HTTP only.
const pathSecret = '390abcd8'.repeat(8); // Synthetic fixture, never deploy.
const base = { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '0.0.0.0',
  MCP_AUTH_MODE: 'secret_path', MCP_PROFILE: 'readonly', PUBLISH_ENABLED: 'false',
  MCP_PUBLIC_ORIGIN: 'https://publisher.example', MCP_PATH_SECRET: pathSecret };
async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const a = s.address(); assert.ok(a && typeof a !== 'string');
  await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); return a.port;
}
function launch(env, args = []) {
  const child = spawn(process.execPath, ['dist/production-main.js', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
  return { child, closed, output: () => ({ stdout, stderr }), dispose: () => clearTimeout(timer) };
}
function http(port, path, method = 'GET', host = 'publisher.example', body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { Host: host, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, res => {
      let raw = ''; res.on('data', b => { raw += b; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('probe deadline'))); req.end(body);
  });
}
async function ready(run) {
  for (let i = 0; i < 100; i++) {
    const output = run.output(); if (output.stdout.includes('PUBLISHER_STARTED')) return;
    assert.equal(run.child.exitCode, null, `startup exited: ${output.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Startup deadline');
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  const port = await freePort(); const run = launch({ ...base, PORT: String(port) });
  try {
    await ready(run);
    assert.deepEqual(await http(port, '/healthz', 'GET', `internal:${port}`), { status: 200, body: { status: 'ok' } });
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_publisher_status', arguments: {} } });
    const result = await http(port, `/mcp/${pathSecret}`, 'POST', 'publisher.example', rpc);
    assert.equal(result.status, 200); assert.equal(result.body.result.structuredContent.publish_enabled, false);
    assert.equal(result.body.result.structuredContent.telegram_ready, false);
    run.child.kill(signal); assert.deepEqual(await run.closed, [0, null]);
    const output = run.output(); assert.equal(output.stderr, ''); assert.ok(!JSON.stringify(output).includes(pathSecret));
    assert.match(output.stdout, /profile=readonly publish_enabled=false auth=secret_path/);
    console.log(`PASS built minimal readonly /healthz internal Host + MCP status + ${signal}, no OAuth/Telegram configuration or secret logs`);
  } finally { run.child.kill('SIGKILL'); run.dispose(); }
}
for (const [name, env, expected] of [
  ['missing secret', { ...base, MCP_PATH_SECRET: undefined }, /Missing setting: MCP_PATH_SECRET/],
  ['HTTP public origin', { ...base, MCP_PUBLIC_ORIGIN: 'http://publisher.example' }, /MCP_PUBLIC_ORIGIN must be an HTTPS origin/],
]) {
  const run = launch(env);
  try {
    assert.deepEqual(await run.closed, [1, null]); const output = run.output(); assert.equal(output.stdout, '');
    assert.match(output.stderr, expected); assert.ok(!JSON.stringify(output).includes(pathSecret));
    console.log(`PASS built ${name}: fails before startup with controlled field message, no secret logs`);
  } finally { run.child.kill('SIGKILL'); run.dispose(); }
}
const valid = launch(base, ['--check-config']);
try {
  assert.deepEqual(await valid.closed, [0, null]); assert.deepEqual(valid.output(), { stdout: 'CONFIG_VALID\n', stderr: '' });
  console.log('PASS built --check-config: validates minimal env without network/startup');
} finally { valid.child.kill('SIGKILL'); valid.dispose(); }
console.log('5/5 built secret production checks PASS');

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { safeStartupCode } from '../src/startup-diagnostics.ts';

test('startup diagnostics preserves SQLSTATE and follows wrapped transport errors', () => {
  assert.equal(safeStartupCode({code:'28P01'}), ' code=28P01');
  assert.equal(safeStartupCode(new Error('wrapped', {cause:Object.assign(new Error('private'), {code:'ECONNREFUSED'})})), ' code=ECONNREFUSED');
  const aggregate = new AggregateError([Object.assign(new Error('private'), {code:'ECONNRESET'})]);
  assert.equal(safeStartupCode(new Error('wrapped', {cause:aggregate})), ' code=ECONNRESET');
});

test('startup diagnostics distinguishes fixed driver failures and TLS certificate errors', () => {
  assert.equal(safeStartupCode(new Error('Connection terminated due to connection timeout')), ' code=DB_CONNECTION_TIMEOUT');
  assert.equal(safeStartupCode(new Error('The server does not support SSL connections')), ' code=DB_SSL_UNSUPPORTED');
  assert.equal(safeStartupCode(new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string')), ' code=DB_PASSWORD_MISSING');
  assert.equal(safeStartupCode({code:'ERR_TLS_CERT_ALTNAME_INVALID'}), ' code=ERR_TLS_CERT_ALTNAME_INVALID');
});

test('startup diagnostics never prints arbitrary codes, credentials, messages, or stacks', () => {
  const secret = 'synthetic-password-never-log';
  const url = `postgresql://synthetic:${secret}@127.0.0.1/unused`;
  for (const error of [
    {code:url,message:url,stack:url}, new Error(url), url, undefined,
    {code:`ERR_SSL_${secret}`,cause:new Error(url)},
    new Error(`Connection terminated due to connection timeout ${url}`),
  ]) assert.equal(safeStartupCode(error), ' code=STARTUP_UNKNOWN');
  assert.equal(safeStartupCode({message:url,stack:url,cause:{code:'28P01',message:url}}), ' code=28P01');
});

test('startup diagnostics bounds cyclic causes and does not evaluate getters', () => {
  const cycle:{cause?:unknown} = {}; cycle.cause = cycle;
  assert.equal(safeStartupCode(cycle), ' code=STARTUP_UNKNOWN');
  let calls = 0;
  const hostile = Object.defineProperties({}, {
    code:{get(){ calls++; throw new Error('private'); }},
    message:{get(){ calls++; throw new Error('private'); }},
    cause:{get(){ calls++; throw new Error('private'); }},
  });
  assert.equal(safeStartupCode(hostile), ' code=STARTUP_UNKNOWN');
  assert.equal(calls, 0);
  let deep:unknown = {code:'28P01'};
  for (let i=0;i<10;i++) deep = {cause:deep};
  assert.equal(safeStartupCode(deep), ' code=STARTUP_UNKNOWN');
});

test('production exposes liveness before a stalled database, closes routes, and exits safely on timeout', {timeout:15000}, async () => {
  const sockets = new Set<import('node:net').Socket>();
  let connected!: () => void;
  const databaseConnected = new Promise<void>(resolve => { connected = resolve; });
  const server = createServer(socket => {connected(); sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const reservation = createServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const httpAddress = reservation.address(); assert.ok(httpAddress && typeof httpAddress !== 'string');
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const password = 'synthetic-password-never-log';
  const child = spawn(process.execPath, ['src/production-main.ts'], {
    cwd:new URL('..',import.meta.url), timeout:12000,
    env:{PATH:process.env.PATH,OUTREACH_ENABLED:'true',MCP_PUBLIC_ORIGIN:'https://example.test',PORT:String(httpAddress.port),
      DATABASE_URL:`postgresql://synthetic:${password}@127.0.0.1:${address.port}/unused`},
  });
  let output=''; child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
  const exited = new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  const request = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${httpAddress.port}${path}`, {method, signal:AbortSignal.timeout(1000)});
  try {
    await Promise.race([databaseConnected, exited.then(()=>{throw new Error('Exited before database connection');})]);
    const health = await request('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {status:'ok'});
    const head = await request('/healthz', 'HEAD');
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    for (const path of ['/healthz?check=1', '/mcp?login=synthetic-login-never-log', '/']) {
      const response = await request(path);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {code:'SERVICE_UNAVAILABLE'});
    }
    assert.equal(await exited, 1);
    assert.match(output, new RegExp(`OUTREACH_HTTP_LISTENING port=${httpAddress.port}`));
    assert.match(output, /OUTREACH_DB_CONNECT_FAILED code=DB_CONNECTION_TIMEOUT/);
    assert.doesNotMatch(output, /postgresql:|synthetic-password-never-log|synthetic-login-never-log/);
    await assert.rejects(request('/healthz'));
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

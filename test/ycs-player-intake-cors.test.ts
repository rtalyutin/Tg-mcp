import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const { configureIntakeCors, mergeIntakeCors, INTAKE_CORS_ORIGIN, INTAKE_CORS_HEADERS } = await import(new URL('../player-intake/setup-cors.mjs', import.meta.url).href);
const original = [{ ID: 'existing-tournament-read', AllowedOrigins: ['https://old.example'], AllowedMethods: ['GET'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 },
  { ID: 'existing-captains', AllowedOrigins: [INTAKE_CORS_ORIGIN], AllowedMethods: ['GET'], AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'] }];
class FakeCors {
  rules = structuredClone(original); calls: Array<{ name: string; input: Record<string, unknown> }> = []; failRead = false; corruptRead = false; changeBeforeWrite = false; loseWriteResponse = false; mismatchReadback = false;
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    this.calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetBucketCorsCommand') {
      if (this.failRead) throw Object.assign(Error('private denied'), { name: 'AccessDenied' });
      if (this.corruptRead) return {};
      if (this.changeBeforeWrite && this.calls.length === 2) this.rules.push({ ...original[0]!, ID: 'concurrent-rule' });
      return { CORSRules: structuredClone(this.rules) };
    }
    assert.equal(command.constructor.name, 'PutBucketCorsCommand');
    this.rules = structuredClone((command.input.CORSConfiguration as { CORSRules: typeof original }).CORSRules);
    if (this.mismatchReadback) this.rules.pop(); if (this.loseWriteResponse) throw Error('lost response after write'); return {};
  }
}
test('CORS explicit merge preserves every old rule, grants only exact origin/method/headers and verifies readback', async () => {
  const s3 = new FakeCors(); const result = await configureIntakeCors({ s3, apply: true }); assert.equal(result.status, 'verified');
  assert.deepEqual(s3.rules.slice(0, 2), original); assert.deepEqual(s3.rules.at(-1)?.AllowedOrigins, [INTAKE_CORS_ORIGIN]); assert.deepEqual(s3.rules.at(-1)?.AllowedMethods, ['PUT', 'GET', 'HEAD']); assert.deepEqual(s3.rules.at(-1)?.AllowedHeaders, INTAKE_CORS_HEADERS);
  assert.deepEqual(s3.calls.map(call => call.name), ['GetBucketCorsCommand', 'GetBucketCorsCommand', 'PutBucketCorsCommand', 'GetBucketCorsCommand']);
  assert.equal((await configureIntakeCors({ s3, apply: true })).status, 'unchanged'); assert.equal(s3.calls.filter(call => call.name === 'PutBucketCorsCommand').length, 1);
});
test('read denial/corruption/concurrent edits never reset bucket CORS; no apply means no write', async () => {
  for (const fault of ['failRead', 'corruptRead', 'changeBeforeWrite'] as const) {
    const s3 = new FakeCors(); s3[fault] = true; await assert.rejects(() => configureIntakeCors({ s3, apply: true })); assert.equal(s3.calls.some(call => call.name === 'PutBucketCorsCommand'), false);
  }
  const dryRun = new FakeCors(); assert.equal((await configureIntakeCors({ s3: dryRun })).status, 'prepared'); assert.equal(dryRun.calls.length, 1);
  assert.throws(() => mergeIntakeCors(original, '*')); assert.throws(() => mergeIntakeCors(original, 'http://foreign.example'));
});
test('a lost write ACK is resolved by exact readback; mismatched readback never reports verified', async () => {
  const lost = new FakeCors(); lost.loseWriteResponse = true; assert.equal((await configureIntakeCors({ s3: lost, apply: true })).status, 'verified');
  const mismatch = new FakeCors(); mismatch.mismatchReadback = true; await assert.rejects(() => configureIntakeCors({ s3: mismatch, apply: true }), /CORS_READBACK_MISMATCH/);
});
test('script import/startup has no implicit bucket operation and reports no secret', () => {
  const result = spawnSync(process.execPath, [new URL('../player-intake/setup-cors.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0); assert.match(result.stdout, /No action performed/); assert.equal(result.stderr, '');
});

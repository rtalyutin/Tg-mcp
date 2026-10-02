import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const base = { PATH:process.env.PATH, NODE_ENV:'production',
  MCP_PUBLIC_ORIGIN:'https://api.example.test', DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1/unused',
  OUTREACH_ENABLED:'true', OWNSITE_ENABLED:'true', DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID:'14a4d6e9-63b0-44ea-9f45-a6237692aef1' };
test('portfolio config checks are side-effect free and reject incomplete runtime profiles',()=>{
  const run = (patch:Record<string,string|undefined>) => spawnSync(process.execPath,['src/production-main.ts','--check-config'],{
    cwd:new URL('..',import.meta.url),env:{...base,...patch},encoding:'utf8',timeout:5000
  });
  const valid = run({});assert.equal(valid.status,0);assert.match(valid.stdout,/OUTREACH_CONFIG_VALID/);
  for (const config of [{OWNSITE_ENABLED:'1'}, {OUTREACH_ENABLED:'false'}, {DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID:undefined}, {OWNSITE_MCP_CREDENTIAL_ID:'not-a-uuid'}]) {
    const result = run(config);assert.equal(result.status,1);
    assert.match(result.stderr,/CONFIG_INVALID/);assert.doesNotMatch(result.stderr,/postgresql:|synthetic:/);
  }
  assert.equal(run({OWNSITE_ENABLED:'false',DASHBOARD_SNAPSHOT_MCP_CREDENTIAL_ID:undefined}).status,0);
});

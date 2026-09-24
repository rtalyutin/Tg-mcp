import test from 'node:test';
import assert from 'node:assert/strict';
import {CODEX_SOURCE_KINDS,probeCodexSource} from '../src/codex-source-probe.mjs';

test('probe enumerates active and archived threads twice and reads each thread',async()=>{
  const calls=[];
  const request=async(method,params)=>{
    calls.push({method,params});
    if (method==='thread/list') {
      const ids=params.archived?['archived-1']:params.cursor?['active-2']:['active-1'];
      return {data:ids.map(id=>({id})),nextCursor:params.archived||params.cursor?null:'page-2'};
    }
    return {thread:{id:params.threadId,turns:[{id:'turn-1'}]}};
  };
  const result=await probeCodexSource(request);
  assert.equal(result.status,'read_only_probe_passed');
  assert.deepEqual([result.activeThreads,result.archivedThreads,result.threadsRead,result.turnsRead],[2,1,3,3]);
  assert.equal(calls.filter(x=>x.method==='thread/list').length,6);
  assert.equal(calls.filter(x=>x.method==='thread/read').length,3);
  assert.ok(calls.filter(x=>x.method==='thread/list').every(x=>
    x.params.sourceKinds.length===CODEX_SOURCE_KINDS.length && x.params.sortKey==='created_at'));
  assert.ok(!JSON.stringify(result).includes('active-1'));
});

test('probe fails closed on changing enumeration',async()=>{
  let pass=0;
  const request=async(method,params)=>{
    if (method==='thread/list') return {data:params.archived?[]:[{id:++pass===1?'before':'after'}],nextCursor:null};
    throw new Error('unexpected read');
  };
  await assert.rejects(probeCodexSource(request),/CODEX_SOURCE_CHANGED_DURING_PROBE/);
});

test('probe fails closed on stalled cursor and incomplete read',async()=>{
  const stalled=async()=>({data:[],nextCursor:'same'});
  await assert.rejects(probeCodexSource(stalled),/CODEX_CURSOR_STALLED/);
  const incomplete=async(method,params)=>method==='thread/list'
    ?{data:params.archived?[]:[{id:'one'}],nextCursor:null}
    :{thread:{id:'one'}};
  await assert.rejects(probeCodexSource(incomplete),/CODEX_THREAD_READ_INCOMPLETE/);
});

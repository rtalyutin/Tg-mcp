import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ui=process.env.LOADING_QA_TARGET??fileURLToPath(new URL('..',import.meta.url));
const { createWorkspaceSync }=await import(new URL('file://'+resolve(ui,'src/sync.js')));
const result=await build({entryPoints:[resolve(ui,'src/transport.js')],bundle:true,write:false,format:'cjs',platform:'browser',nodePaths:[resolve(ui,'node_modules'),resolve(ui,'../../node_modules'),...(process.env.LOADING_QA_NODE_MODULES?[process.env.LOADING_QA_NODE_MODULES]:[])]});
const code=result.outputFiles[0].text, traces=[], rawHarnesses=[];
const fingerprint=createHash('sha256').update(code).digest('hex');

function virtualClock(events) {
 let now=0,seq=0;const timers=new Map();
 const schedule=(fn,delay)=>{const id=++seq;timers.set(id,{fn,at:now+delay});events.push({at:now,event:'schedule',id,delay});return id;};
 const cancel=id=>timers.delete(id);
 const drain=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
 const advance=async target=>{await drain();while(true){const next=[...timers.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;const[id,t]=next;now=t.at;timers.delete(id);events.push({at:now,event:'timer',id});t.fn();await drain();}now=target;await drain();};
 return {schedule,cancel,drain,advance,timers,get now(){return now;}};
}
function harness(options={}) {
 const events=[],time=virtualClock(events),listeners=new Set(),rpc=[],initial=[],errors=[],http=[];
 rawHarnesses.push({id:rawHarnesses.length+1,events,initial,errors});
 let connected='pending',transport;
 const parent={postMessage(request){rpc.push({at:time.now,request});events.push({at:time.now,event:'rpc',method:request.method,name:request.params?.name});const reply=result=>emit({jsonrpc:'2.0',id:request.id,result});
   if(request.method==='ui/initialize'&&!options.noConnect)reply({protocolVersion:request.params.protocolVersion,hostInfo:{name:'controlled-sdk-host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{displayMode:options.displayMode??'fullscreen',availableDisplayModes:['fullscreen']}});
   if(request.method==='tools/call')options.onRead?.({request,reply,time});
 }};
 function emit(data){events.push({at:time.now,event:'host_message',method:data.method,id:data.id});for(const fn of listeners)fn({source:parent,data});}
 const window={addEventListener:(kind,fn)=>{if(kind==='message')listeners.add(fn);},removeEventListener:(_kind,fn)=>listeners.delete(fn)};window.parent=options.web?window:parent;
 const fetch=(url,init)=>{http.push({at:time.now,url,init});events.push({at:time.now,event:'http',url});if(url==='/workspace/api/session')return Promise.resolve({ok:true,status:200,json:async()=>({csrf_token:'fixture-csrf'})});return options.onFetch?.({url,init,time})??Promise.resolve({ok:true,status:200,json:async()=>({data:{snapshot:'http-fresh'},server_time:'2026-10-03T08:30:00Z'})});};
 const context={exports:{},module:{exports:{}},window,fetch,setTimeout:time.schedule,clearTimeout:time.cancel,console:{debug(){},warn(){},error(){}},AbortController,URL,TextEncoder,TextDecoder,DOMException,queueMicrotask};context.exports=context.module.exports;
 vm.runInNewContext(code,context,{filename:'exact-transport+actual-sdk'});
 const pending=context.module.exports.connectTransport({onInitial:v=>{initial.push({at:time.now,v});options.onInitial?.(v);},onFailure:e=>errors.push({at:time.now,code:e.code,message:e.message})});
 pending.then(v=>{transport=v;connected='ready';events.push({at:time.now,event:'ready'});},e=>{connected='failed';errors.push({at:time.now,code:e.code,message:e.message});events.push({at:time.now,event:'connect_error'});});
 return {events,time,rpc,http,initial,errors,pending,emit,get connected(){return connected;},get transport(){return transport;}};
}
function syncHarness(h,options={}) {
 const data=[],errors=[],busy=[];
 const sync=createWorkspaceSync({read:()=>h.transport.read('workspace_get'),onData:v=>{data.push({at:h.time.now,v});h.events.push({at:h.time.now,event:'data'});},onError:e=>{errors.push({at:h.time.now,message:e.message});h.events.push({at:h.time.now,event:'sync_error'});},onBusy:v=>busy.push(v),isActive:()=>true,schedule:h.time.schedule,cancel:h.time.cancel,...options});
 return {sync,data,errors,busy};
}
async function finish(id,h,observation){h.transport?.close();await h.time.drain();traces.push({id,observation,trace:h.events});}
const fixtureResult=snapshot=>({content:[],structuredContent:{data:{snapshot},server_time:'2026-10-03T08:30:00Z'}});

test('a missing display-mode reply does not block transport or workspace reads',async()=>{
 const h=harness({displayMode:'inline',onRead:({reply})=>reply(fixtureResult('fresh'))});await h.time.drain();assert.equal(h.connected,'ready');
 const data=await h.transport.read('workspace_get');assert.equal(data.data.snapshot,'fresh');assert.equal(h.time.now,0);
 h.emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:fixtureResult('initial')});await h.time.drain();assert.equal(h.initial[0].at,0);
 await h.time.advance(3000);assert.equal(h.connected,'ready');await finish('C01-display-not-blocking',h,{readyAt:0,readAt:0,optionalDisplayAckMissing:true});
});
test('missing host opener falls back to a read after 3 seconds',async()=>{
 const h=harness({onRead:({reply})=>reply(fixtureResult('explicit'))});await h.time.drain();const c=syncHarness(h,{waitForInitial:true});c.sync.start();await h.time.advance(2999);assert.equal(c.data.length,0);await h.time.advance(3000);assert.equal(c.data.length,1);assert.equal(c.data[0].at,3000);assert.equal(h.rpc.filter(r=>r.request.method==='tools/call').length,1);
 c.sync.receive({data:{snapshot:'late-old-opener'}});assert.equal(c.data.at(-1).v.data.snapshot,'explicit');assert.equal(c.data.length,1);c.sync.stop();await finish('C02-opener-fallback-late-result',h,{firstDataAt:3000,lateOldOpenerIgnored:true,readCount:1});
});
test('opener arriving before fallback avoids an extra read; inactive opener resumes safely',async()=>{
 const h=harness({onRead:({reply})=>reply(fixtureResult('refresh'))});await h.time.drain();let active=true;const c=syncHarness(h,{waitForInitial:true,isActive:()=>active});c.sync.start();await h.time.advance(2000);c.sync.receive({data:{snapshot:'opener'}});await h.time.advance(3000);assert.equal(h.rpc.filter(r=>r.request.method==='tools/call').length,0);
 active=false;c.sync.activityChanged();await h.time.advance(30000);assert.equal(h.rpc.filter(r=>r.request.method==='tools/call').length,0);active=true;await c.sync.activityChanged();assert.equal(c.data.at(-1).v.data.snapshot,'refresh');
 c.sync.stop();await finish('C03-opener-early-inactive',h,{duplicateInitialRead:false,noInactivePoll:true,immediateReturnRefresh:true});
});
test('missing initialization and read replies have a 20 second deadline',async()=>{
 const a=harness({noConnect:true});await a.time.advance(19999);assert.equal(a.connected,'pending');await a.time.advance(20000);assert.equal(a.connected,'failed');assert.equal(a.errors[0].code,-32001);await finish('C04-connect-deadline',a,{failureAt:20000,code:-32001});
 const h=harness();await h.time.drain();let state='pending',error;h.transport.read('workspace_get').then(()=>state='ok',e=>{state='failed';error=e;});await h.time.advance(19999);assert.equal(state,'pending');await h.time.advance(20000);assert.equal(state,'failed');assert.equal(error.code,-32001);await finish('C05-read-deadline',h,{failureAt:20000,code:-32001});
});
test('progress cannot extend a read deadline; a slow valid reply is accepted',async()=>{
 let token;const h=harness({onRead:({request})=>{token=request.params._meta.progressToken;}});await h.time.drain();let state='pending';h.transport.read('workspace_get').catch(()=>state='failed');await h.time.drain();assert.notEqual(token,undefined);await h.time.advance(15000);h.emit({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:token,progress:1}});await h.time.advance(20000);assert.equal(state,'failed');await finish('C06-progress-bounded',h,{progressAt:15000,deadlineAt:20000});
 const s=harness({onRead:({time,reply})=>time.schedule(()=>reply(fixtureResult('slow-valid')),18000)});await s.time.drain();let value;s.transport.read('work_item_get',{id:'fixture'}).then(v=>value=v);await s.time.advance(18000);assert.equal(value.data.snapshot,'slow-valid');await finish('C07-slow-valid',s,{resultAt:18000});
});
test('two transient failures retry after 5 and 10 seconds and recover',async()=>{
 let n=0;const h=harness();await h.time.drain();const c=syncHarness(h,{read:async()=>{h.events.push({at:h.time.now,event:'test_read',n:++n});if(n<=2)throw Error('fixture-transient');return {data:{snapshot:'updated'}};}});c.sync.receive({data:{snapshot:'old'}});await h.time.advance(15000);assert.equal(c.data.length,1);await h.time.advance(20000);assert.equal(c.data.length,1);await h.time.advance(30000);assert.equal(c.data.at(-1).at,30000);assert.equal(c.data.at(-1).v.data.snapshot,'updated');c.sync.stop();await finish('C08-short-retry',h,{readTimes:[15000,20000,30000],oldSnapshotRetained:true});
});
test('long failures retain backoff capped at 120 seconds; disposal stops polling',async()=>{
 const h=harness();await h.time.drain();const c=syncHarness(h,{read:async()=>{throw Error('fixture-down');}});c.sync.receive({data:{snapshot:'old'}});let at=15000;const gaps=[];for(let i=0;i<7;i++){await h.time.advance(at);const timer=[...h.time.timers.values()][0];gaps.push(timer.at-at);at=timer.at;}assert.deepEqual(gaps,[5000,10000,20000,40000,80000,120000,120000]);assert.equal(c.data.length,1);c.sync.stop();assert.equal(h.time.timers.size,0);await finish('C09-backoff-disposal',h,{retryGaps:gaps,oldSnapshotRetained:true,disposedTimers:0});
});
test('post-change refresh waits for a fresh second read but not a 60 second timeout',async()=>{
 let n=0;const h=harness({onRead:({reply})=>{if(++n===2)reply(fixtureResult('after-change'));}});await h.time.drain();const c=syncHarness(h);c.sync.receive({data:{snapshot:'before'}});const first=c.sync.refresh();assert.equal(c.sync.refresh(),first);await h.time.drain();const after=c.sync.refresh({afterCurrent:true});assert.equal(c.sync.refresh({afterCurrent:true}),after);await h.time.advance(19999);assert.equal(n,1);await h.time.advance(20000);assert.equal(n,2);assert.equal(c.data.at(-1).v.data.snapshot,'after-change');assert.equal(c.data.at(-1).at,20000);c.sync.stop();await finish('C10-post-change-queued',h,{readTimes:[0,20000],freshAfterCurrent:true,noOverlap:true});
});
test('mutation through read and project creation retain the original SDK command deadline',async()=>{
 const h=harness();await h.time.drain();let mutation='pending',creation='pending';h.transport.read('work_item_attributes_update',{id:'fixture',operation_id:'fixture-id',expected_revision:3,attributes:{next_action:'fixture'}}).catch(()=>mutation='failed');h.transport.create({title:'fixture',operation_id:'fixture-id-2'}).catch(()=>creation='failed');await h.time.advance(20000);assert.equal(mutation,'pending');assert.equal(creation,'pending');await h.time.advance(59999);assert.equal(mutation,'pending');assert.equal(creation,'pending');await h.time.advance(60000);assert.equal(mutation,'failed');assert.equal(creation,'failed');const calls=h.rpc.filter(r=>r.request.method==='tools/call');assert.equal(calls[0].request.params.arguments.operation_id,'fixture-id');assert.equal(calls[1].request.params.arguments.operation_id,'fixture-id-2');await finish('C11-command-semantics',h,{commandTimeout:60000,readsTimeoutNotAppliedToCommands:true,operationIdsPreserved:true});
});
test('HTTP read aborts after 20 seconds and sends credentials and CSRF; commands do not abort',async()=>{
 const waitForAbort=({init})=>new Promise((_ok,fail)=>init.signal?.addEventListener('abort',()=>fail(new DOMException('Aborted','AbortError'))));const h=harness({web:true,onFetch:waitForAbort});await h.time.drain();let state='pending',error;h.transport.read('work_item_get',{id:'fixture'}).catch(e=>{state='failed';error=e;});await h.time.advance(20000);assert.equal(state,'failed');assert.equal(error.message,'loading_timeout');const req=h.http[1];assert.equal(req.init.credentials,'same-origin');assert.equal(req.init.cache,'no-store');assert.equal(req.init.headers['x-csrf-token'],'fixture-csrf');assert.equal(req.init.signal.aborted,true);
 let command='pending';h.transport.read('work_item_attributes_update',{operation_id:'fixture-op'}).catch(()=>command='failed');await h.time.advance(60000);assert.equal(command,'pending');assert.equal(h.http[2].init.signal,undefined);assert.equal(h.http[2].init.headers['x-csrf-token'],'fixture-csrf');await finish('C12-http-boundaries',h,{readFailureAt:20000,csrfAndCredentialsPreserved:true,noCommandAbort:true});
});
test.after(async()=>{if(process.env.LOADING_QA_EVIDENCE)await writeFile(process.env.LOADING_QA_EVIDENCE,JSON.stringify({fingerprint,scope:'actual SDK bundled exact transport + controller; virtual clock; controlled postMessage/fetch',traces,rawHarnesses},null,2));});

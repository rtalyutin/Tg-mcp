import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {probeCodexSource} from './codex-source-probe.mjs';

// Run on the user's machine with Codex installed; no dashboard writes occur.
const child=spawn('codex',['app-server'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
let nextId=1;
const pending=new Map();
const lines=createInterface({input:child.stdout});
const rejectAll=(error=new Error('CODEX_APP_SERVER_CLOSED'))=>{
  for (const entry of pending.values()) {clearTimeout(entry.timer);entry.reject(error);}
  pending.clear();
};
child.on('error',error=>rejectAll(new Error(error?.code==='ENOENT'?'CODEX_CLI_NOT_FOUND':'CODEX_APP_SERVER_CLOSED')));
child.on('exit',()=>rejectAll());
lines.on('line',line=>{
  let message;
  try {message=JSON.parse(line);} catch {rejectAll();return;}
  if (message?.id===undefined) return;
  const entry=pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(`CODEX_RPC_ERROR_${message.error.code??'UNKNOWN'}`));
  else entry.resolve(message.result);
});
function request(method,params) {
  return new Promise((resolve,reject)=>{
    const id=nextId++;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CODEX_RPC_TIMEOUT'));},30000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(`${JSON.stringify({id,method,params})}\n`,error=>{
      if (error && pending.has(id)) {clearTimeout(timer);pending.delete(id);reject(new Error('CODEX_RPC_WRITE_FAILED'));}
    });
  });
}
try {
  await request('initialize',{clientInfo:{name:'roman_dashboard_source_probe',title:'Roman Dashboard Source Probe',version:'0.1.0'}});
  child.stdin.write(`${JSON.stringify({method:'initialized',params:{}})}\n`);
  const result=await probeCodexSource(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error?error.message:'CODEX_PROBE_FAILED'}\n`);
  process.exitCode=1;
} finally {
  rejectAll();
  child.kill();
  lines.close();
}

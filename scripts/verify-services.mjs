import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const root=resolve(process.env.TRAVEL_TEST_ROOT || new URL('..',import.meta.url).pathname),directory=mkdtempSync(join(tmpdir(),'travel-two-services-'));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const [publicPort,internalPort,healthPort]=await Promise.all([port(),port(),port()]);
const env={PATH:process.env.PATH,HOME:process.env.HOME,TRAVEL_ENV_FILE:join(directory,'absent.env'),DATA_DIR:join(directory,'app'),AGENT_DATA_DIR:join(directory,'agent'),HOST:'127.0.0.1',PORT:String(publicPort),INTERNAL_PORT:String(internalPort),APP_INTERNAL_URL:`http://127.0.0.1:${internalPort}`,AGENT_HEALTH_PORT:String(healthPort),TRAVEL_SERVICE_TOKEN:'isolated-startup-secret-'.repeat(3),ZHIPU_API_KEY:'startup-fixture-never-call-a-model',BROWSER_ENABLED:'0'};
const children=[],logs=[];let stopping=false;
try{
 for(const entry of ['dist/server/service/server/main.js','scripts/start-agent.mjs']){
  const child=spawn(process.execPath,[join(root,entry)],{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',s=>logs.push(s.toString()));child.stderr.on('data',s=>logs.push(s.toString()));
 }
 for(let i=0;i<150;i++){
  if(children.some(c=>c.exitCode!==null))throw Error(logs.join(''));
  try{if((await fetch(`http://127.0.0.1:${healthPort}/health`)).ok)break;}catch{}
  if(i===149)throw Error('Worker readiness timed out: '+logs.join(''));
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok((await fetch(`http://127.0.0.1:${publicPort}/api/health`)).ok);
 const status=await (await fetch(`http://127.0.0.1:${internalPort}/internal/agent/v1/status`,{headers:{authorization:`Bearer ${env.TRAVEL_SERVICE_TOKEN}`}})).json();
 assert.equal(status.available,true);assert.equal(status.workers.length,1);
 console.log('PASS: production app + real Harness worker boot independently, register capabilities, and expose healthy status. No research/model request submitted.');
}finally{
 stopping=true;
 await Promise.all(children.map(async child=>{if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),7000);await exited;clearTimeout(timer);}));
 rmSync(directory,{recursive:true,force:true});
}

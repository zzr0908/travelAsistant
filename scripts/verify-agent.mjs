// Deterministic development acceptance. No provider or model API is called.
import { createApp } from '../dist/server/service/server/app.js';
import { nodeFields } from '../dist/server/shared/model.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import assert from 'node:assert/strict';
const driver={kind:'test',async run(i){i.beforeModel(10);await delay(60000,undefined,{signal:i.signal});},async close(){}};
const f=await createApp({agent:{driver}});
const user=f.auth.create({username:'perf',name:'Performance fixture',password:'testing-password'},true),peer=f.auth.create({username:'peer',name:'Peer fixture',password:'testing-password'});
const command=(kind,payload,wid)=>f.plans.execute(user.id,{requestId:randomUUID(),kind,payload,...wid?{workspaceId:wid,version:f.plans.get(wid).version}:{}});
const wid=command('create',{kind:'trip',node:nodeFields.parse({title:'50节点性能验收'})}).workspaceId,root=f.plans.get(wid).data.rootId;
for(let i=1;i<50;i++)command('add',{parentId:root,node:nodeFields.parse({title:'节点'+i})},wid);
f.db.prepare("INSERT INTO members VALUES(?,?,'editor')").run(wid,peer.id);
await f.app.listen({host:'127.0.0.1',port:0});const base='http://127.0.0.1:'+f.app.server.address().port;
const headers={'content-type':'application/json','x-travel-app':'1',cookie:`travel_session=${f.auth.session(user)}`},peerHeaders={...headers,cookie:`travel_session=${f.auth.session(peer)}`};
const samples={submit:[],manual:[],cancelAck:[],cancelComplete:[],eventDelivery:[]};
const req=async(url,body,h=headers)=>{const start=performance.now(),r=await fetch(base+url,{method:body?'POST':'GET',headers:h,...body?{body:JSON.stringify(body)}:{}}),json=await r.json();assert.ok(r.ok,JSON.stringify(json));return{value:json,ms:performance.now()-start};};
const submit=async h=>req('/api/agent/runs',{requestId:randomUUID(),workspaceId:wid,nodeId:root,prompt:'控制延迟验收'},h);
const peerRun=(await submit(peerHeaders)).value;let current=(await submit(headers)).value;
try{
 for(let n=0;n<10;n++){
  const before=performance.now(),cancel=await req(`/api/agent/runs/${current.id}/cancel`,{});samples.cancelAck.push(cancel.ms);await f.agent.wait(current.id);samples.cancelComplete.push(performance.now()-before);
  const next=await submit(headers);samples.submit.push(next.ms);current=next.value;
  assert.equal(f.agent.row(peerRun.id).state,'running');assert.equal(f.agent.row(current.id).state,'running');
  for(let j=0;j<3;j++){
   const start=performance.now(),w=(await req('/api/workspaces/'+wid)).value;const {id,parentId,order,...node}=w.data.nodes[root];
   await req('/api/commands',{requestId:randomUUID(),kind:'edit',workspaceId:wid,version:w.version,payload:{nodeId:root,node:{...node,notes:`手动修改${n}-${j}`}}});
   samples.manual.push(performance.now()-start);
  }
 }
 const controller=new AbortController(),r=await fetch(base+`/api/agent/runs/${current.id}/events?after=-1`,{headers,signal:controller.signal}),reader=r.body.getReader();
 const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: run.status/);
 const start=performance.now();f.agent.event(current.id,'run.status',{state:'running',message:'持久阶段传送验收'});
 let seen='';while(!seen.includes('持久阶段传送验收')){const chunk=await reader.read();seen+=new TextDecoder().decode(chunk.value);}
 samples.eventDelivery.push(performance.now()-start);controller.abort();await reader.cancel().catch(()=>{});
 const summary=Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,{count:v.length,p95:[...v].sort((a,b)=>a-b)[Math.ceil(v.length*.95)-1],max:Math.max(...v)}]));
 assert.ok(summary.submit.p95<=1000);assert.ok(summary.manual.p95<=1000);assert.ok(summary.cancelAck.max<=1000);assert.ok(summary.cancelComplete.max<=10000);assert.ok(summary.eventDelivery.max<=2000);
 mkdirSync('docs/qa/agent-integration',{recursive:true});writeFileSync('docs/qa/agent-integration/performance.json',JSON.stringify({method:'Controlled delay driver + actual local HTTP/SSE; no live model',acceptanceIds:['AP14','AP15','AP16','AP26'],timestamp:new Date().toISOString(),environment:{node:process.version,platform:platform(),release:release(),cpu:cpus()[0].model},nodes:50,activeRuns:2,samples,summary,status:'passed'},null,2)+'\n');console.log(summary);
}finally{await f.app.close();}

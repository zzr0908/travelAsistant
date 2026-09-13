import { createApp } from '../dist/server/service/server/app.js';
import { acquireLock } from '../dist/server/storage/runtime-lock.js';
import { browserRequest } from '../dist/server/agent/browser/model.js';
import { backupDatabase, restoreDatabase, inspectBackup } from '../dist/server/storage/maintenance.js';
import { spawn } from 'node:child_process';import{once}from'node:events';import{randomUUID,createHash}from'node:crypto';import{mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import Database from'better-sqlite3';import assert from'node:assert/strict';
const [mode,phase,directory]=process.argv.slice(2);
if(mode==='--child'){
 const release=acquireLock(directory);let f;
 const driver={kind:'test',async close(){},async run(i){
  if(phase==='query'){
   const original=JSON.parse(readFileSync(join(directory,'source.json'))),input=browserRequest.parse({action:'read',url:original.data.url,requestId:randomUUID()}),q=f.browser.store.begin(owner.id,input);original.queryId=q.id;original.context={conditions:{}};f.browser.store.finish(owner.id,original);f.db.prepare('INSERT INTO agent_browser_queries VALUES(?,?,?)').run(q.id,i.id,owner.id);
   process.send({phase,runId:i.id,userId:owner.id,queryId:q.id,textHash:original.data.textHash});
  }else{
   await i.tools.find(t=>t.name==='publish_result').execute({answer:'受控崩溃验收草案',proposal:{title:'恢复验收',operations:[{kind:'new_workspace',id:'root',node:{title:'恢复验收'}},{kind:'add_node',id:'day',parentId:'root',node:{title:'未定一天'}}]}},i.signal);
   if(phase==='staged')process.send({phase,runId:i.id,userId:owner.id});
  }
  if(phase!=='applied')await new Promise(()=>{});
 }};
 f=await createApp({database:join(directory,'travel.db'),agent:{driver}});const owner=f.auth.create({username:'crash',name:'Crash fixture',password:'testing-password'},true);const run=f.agent.submit(owner.id,{requestId:randomUUID(),prompt:'受控中断，非真实模型请求'});
 if(phase==='applied'){await f.agent.wait(run.id);const p=f.agent.view(run.id,owner.id).proposal,input={requestId:randomUUID(),revision:p.revision,digest:p.digest,baseVersion:p.baseVersion};const result=f.agent.proposals.apply(p.id,owner.id,input);process.send({phase,runId:run.id,userId:owner.id,proposalId:p.id,input,result});}
 setInterval(()=>{},1000);
}else{
 const root=mkdtempSync(join(tmpdir(),'travel-agent-crash-')),report=[];const text='Controlled offline recovery fixture; no travel facts are asserted.';
 const source={schemaVersion:1,queryId:randomUUID(),capability:'page_read',providerId:'chrome-devtools-mcp',status:'ok',data:{pageId:randomUUID(),snapshotId:randomUUID(),sourceId:'fixture',sourceType:'test',url:'https://example.org/recovery-fixture',title:'Offline fixture',language:'en',contentKind:'page',text,textHash:createHash('sha256').update(text).digest('hex'),totalTextChars:text.length,truncated:false,textRange:{start:0,end:text.length,nextOffset:null},publishedAt:null,modifiedAt:null,experiencedAt:null,author:null,canonicalUrl:null,license:null,links:[],comments:[],media:[],controls:[],counts:{commentsDetected:0,commentsSaved:0,commentsTotal:null,imagesDetected:0,mediaSaved:0,linksDetected:0,linksSaved:0,controlsDetected:0},viewport:{scrollY:0,height:800,documentHeight:800},evidenceId:null,verification:'unverified'},evidenceIds:[],artifact:null,context:{conditions:{}},missing:[],limitations:['Controlled fixture, not a live browser/model'],retrievedAt:new Date().toISOString(),durationMs:0,usage:{toolCalls:0,browserRequests:null,cost:null},message:'Offline recovery fixture'};
 try{for(const phase of ['query','staged','applied']){
  const dir=join(root,phase);mkdirSync(dir);writeFileSync(join(dir,'source.json'),JSON.stringify(source));const child=spawn(process.execPath,[import.meta.filename,'--child',phase,dir],{stdio:['ignore','ignore','inherit','ipc']});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('child exited before crash boundary: '+code);})]);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const release=acquireLock(dir);let calls=0;const f=await createApp({database:join(dir,'travel.db'),agent:{driver:{kind:'test',async run(){calls++;},async close(){}}}});
  try{
   const run=f.agent.view(message.runId,message.userId);assert.equal(calls,0);
   if(phase==='applied'){assert.equal(run.state,'completed');const first=f.agent.proposals.apply(message.proposalId,message.userId,message.input),second=f.agent.proposals.apply(message.proposalId,message.userId,{...message.input,requestId:randomUUID()});assert.deepEqual(first,message.result);assert.deepEqual(second,first);assert.equal(f.plans.list(message.userId).length,1);assert.equal(f.plans.get(first.workspaceId).version,1);}
   else{assert.equal(run.state,'interrupted');assert.equal(run.proposal,null);if(phase==='query')assert.equal(f.browser.store.get(message.userId,message.queryId).result.data.textHash,message.textHash);else assert.ok(run.output);}
   assert.ok(f.agent.events(run.id,message.userId).every((e,i)=>e.seq===i));inspectBackup(join(dir,'travel.db'));
   const backup=join(root,phase+'.db');await backupDatabase(join(dir,'travel.db'),backup);await restoreDatabase(backup,join(root,'restored-'+phase));
   report.push({phase,status:'passed',modelCallsAfterRestart:calls,checks:['SIGKILL at committed boundary','dead owner lock reclaimed','prior state preserved','no automatic model dispatch','backup restores independent database',...(phase==='applied'?['same and new requestId return original change; no duplicate adoption']:[])]});
  }finally{await f.app.close();release();}
 }
 mkdirSync('docs/qa/agent-integration',{recursive:true});writeFileSync('docs/qa/agent-integration/crash-recovery.json',JSON.stringify({timestamp:new Date().toISOString(),method:'Controlled driver child process with real SQLite + SIGKILL; controlled offline source fixture; no live model',acceptanceIds:['AP09','AP23','AP24'],results:report,status:'passed'},null,2)+'\n');console.log(report);
 }finally{rmSync(root,{recursive:true,force:true});}
}

import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{harnessImport}from'../config/harness/travel/modules.mjs';import*as Resources from'../config/harness/travel/resources.mjs';import Persistence from'../config/harness/travel/persistence.mjs';
import{AgentService}from'../dist/server/agent/service.js';import{inspectBackup}from'../dist/server/storage/maintenance.js';
const {Context}=await harnessImport('@deepseek-ai/cordis'),{default:SessionStore,SessionId}=await harnessImport('@deepseek-ai/dsh-session');
const directory=mkdtempSync(join(tmpdir(),'travel-harness-store-'));process.env.DATA_DIR=directory;
const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(Resources);await ctx.plugin(Persistence);
const res=Resources.getResources(),p=ctx.sessionPersistence;
const u=res.auth.create({username:'fixture',name:'Fixture',password:'testing-password'},true),agent=new AgentService(res.db,res.plans,res.browser,{driver:{kind:'test',async run(i){await i.tools.find(t=>t.name==='publish_result').execute({answer:'持久化测试'},i.signal);},async close(){}}});
const makeRun=async()=>{const run=agent.submit(u.id,{requestId:randomUUID(),prompt:'只测持久化，无模型请求'});await agent.wait(run.id);return run;};
try{
 const run=await makeRun(),session=ctx.sessions.create(SessionId(run.id)),writer=await p.create(session.header);
 await assert.rejects(p.open(session.id,'write'),/owned|owner|ownership/i);
 const reader=await p.open(session.id,'read');await assert.rejects(reader.append([]),/read handle/i);
 session.append('turn/start',{turn:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}});await ctx.sessions.flush(session);
 assert.deepEqual((await reader.read()).map(e=>e.seq),[0,1]);await writer.close();await reader.close();
 const reopened=await p.open(session.id,'write');assert.equal((await reopened.read()).length,2);await assert.rejects(reopened.append([{type:'turn/start',seq:7,time:Date.now(),data:{turn:2}}]),/seq mismatch/);await reopened.close();
 assert.equal(inspectBackup(join(directory,'travel.db')).users,1);
 const originalHeader=res.db.prepare('SELECT header FROM harness_sessions WHERE id=?').get(run.id).header;
 res.db.prepare('UPDATE harness_sessions SET header=? WHERE id=?').run(JSON.stringify({...JSON.parse(originalHeader),version:99}),run.id);
 assert.throws(()=>inspectBackup(join(directory,'travel.db')),/格式/);
 res.db.prepare('UPDATE harness_sessions SET header=? WHERE id=?').run(originalHeader,run.id);
 const bad=await makeRun(),s2=ctx.sessions.create(SessionId(bad.id)),w2=await p.create(s2.header);
 res.db.exec("CREATE TRIGGER fail_harness_write BEFORE INSERT ON harness_events BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;");s2.append('turn/start',{turn:1});await Promise.resolve();
 await assert.rejects(ctx.sessions.flush(s2),/injected storage failure/);assert.equal((res.db.prepare('SELECT count(*) n FROM harness_events WHERE session_id=?').get(bad.id)).n,0);
 res.db.exec('DROP TRIGGER fail_harness_write');await assert.rejects(w2.close(),/injected storage failure/);
 const report={timestamp:new Date().toISOString(),method:'Actual built Cordis + Session v2 + SQLite provider; no network/model',harnessRevision:'d347e703908d0406b7a7ef80e3a0e594d86b2215',acceptanceIds:['AP20','AP23','AP24'],checks:['live events durable before flush returns','single writer','read handle refuses writes','reopen exact contiguous log','bad append sequence and future session format rejected','actual upstream payload validation on backup','failed live insert retained through flush and close'],status:'passed'};
 mkdirSync('docs/qa/agent-integration',{recursive:true});writeFileSync('docs/qa/agent-integration/persistence.json',JSON.stringify(report,null,2)+'\n');console.log(report);
}finally{await agent.close();await ctx.fiber.dispose();rmSync(directory,{recursive:true,force:true});}

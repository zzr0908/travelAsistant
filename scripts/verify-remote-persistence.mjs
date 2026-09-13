import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harnessImport } from '../config/harness/travel/modules.mjs';
import * as Resources from '../config/harness/worker/resources.mjs';
import Persistence from '../config/harness/worker/persistence.mjs';
import { createApp } from '../dist/server/service/server/app.js';
import { AppClient } from '../dist/server/agent/runtime/client.js';
const token='isolated-harness-regression-'.repeat(3);
const f=await createApp({execution:{token},agent:{}});await f.execution.listen('127.0.0.1',0);
const client=new AppClient(`http://127.0.0.1:${f.execution.app.server.address().port}`,token);
await client.request('/internal/agent/v1/register',{instanceId:client.instanceId,protocol:1,version:'regression',capabilities:['research','release']});
const {Context}=await harnessImport('@deepseek-ai/cordis'),{default:SessionStore,SessionId}=await harnessImport('@deepseek-ai/dsh-session');
const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(Resources);await ctx.plugin(Persistence);
const user=f.auth.create({username:'fixture',name:'Fixture',password:'testing-password'},true);
// A real coordinator run supplies the ownership record and queued remote job.
const run=f.agent.submit(user.id,{requestId:randomUUID(),prompt:'只验证 Harness 日志，不请求模型'});
let task;for(let i=0;i<100&&!task;i++){({task}=await client.request('/internal/agent/v1/claim',{instanceId:client.instanceId,kinds:['research']}));if(!task)await new Promise(r=>setTimeout(r,20));}
assert.ok(task);Resources.resources.worker={sessionCall:(_id,method,value)=>client.call(task,method,value)};
try{
 const session=ctx.sessions.create(SessionId(run.id)),writer=await ctx.sessionPersistence.create(session.header);
 session.append('turn/start',{turn:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}});
 await ctx.sessions.flush(session);
 assert.deepEqual((await writer.read()).map(e=>e.seq),[0,1]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harness_events').get().n,2);
 await assert.rejects(ctx.sessionPersistence.open(session.id,'write'),/owned|owner|ownership/i);
 await writer.close();const reopened=await ctx.sessionPersistence.open(session.id,'write');assert.equal((await reopened.read()).length,2);await reopened.close();
 const before=f.db.prepare('SELECT count(*) n FROM harness_events').get().n;
 await assert.rejects(client.call(task,'session.append',{events:[{seq:2,time:Date.now(),type:'assistant/message',data:{garbage:true}}]}));
 assert.equal(f.db.prepare('SELECT count(*) n FROM harness_events').get().n,before);
 console.log('PASS: pinned Cordis/Session v2 → HTTP persistence → SQLite; flush, reopen, ownership and invalid event rejection; zero model calls.');
}finally{await ctx.fiber.dispose();await f.app.close();}

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/service/server/app.js';
import { ExecutionBroker } from '../src/execution/broker.js';
import { openDatabase } from '../src/storage/database.js';
import { nodeFields } from '../src/shared/model.js';
const token='regression-secret-'.repeat(4);
async function eventually(check:()=>boolean) {for(let i=0;i<150;i++){if(check())return;await delay(20);}assert.fail('condition timed out');}
test('two processes: remote research, atomic adoption/undo, worker crash leaves app usable',async t=>{
 const f=await createApp({execution:{token,leaseMs:450}});await f.execution!.listen('127.0.0.1',0);
 t.after(()=>f.app.close());const port=(f.execution!.app.server.address() as any).port;
 const worker=fork(new URL('./fixtures/execution-worker.ts',import.meta.url),{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,APP_INTERNAL_URL:`http://127.0.0.1:${port}`,TRAVEL_SERVICE_TOKEN:token},stdio:['ignore','pipe','pipe','ipc']});
 let log='';worker.stderr!.on('data',s=>log+=s);t.after(()=>worker.kill('SIGKILL'));
 await Promise.race([once(worker,'message'),once(worker,'exit').then(()=>assert.fail(log))]);
 const user=f.auth.create({username:'owner',name:'owner',password:'testing-password'},true);
 const run=f.agent.submit(user.id,{requestId:randomUUID(),prompt:'新建旅行草案'});await f.agent.wait(run.id);
 const view=f.agent.view(run.id,user.id);assert.equal(view.state,'completed',JSON.stringify(view));
 assert.equal(f.plans.list(user.id).length,0);
 const p=view.proposal!,body={requestId:randomUUID(),revision:p.revision,digest:p.digest,baseVersion:p.baseVersion};
 const applied=f.agent.proposals.apply(p.id,user.id,body);assert.deepEqual(f.agent.proposals.apply(p.id,user.id,body),applied);
 f.plans.execute(user.id,{requestId:randomUUID(),kind:'undo',payload:{changeId:applied.changeId}});assert.equal(f.plans.list(user.id).length,0);
 const killed=f.agent.submit(user.id,{requestId:randomUUID(),prompt:'WAIT_FOR_KILL'});
 await eventually(()=>!!f.db.prepare("SELECT 1 FROM execution_jobs WHERE kind='research' AND state='running'").get());
 worker.kill('SIGKILL');await once(worker,'exit');await f.agent.wait(killed.id);
 assert.ok(['failed','interrupted','partial'].includes(f.agent.view(killed.id,user.id).state));
 assert.equal((f.db.prepare('SELECT count(*) n FROM execution_jobs WHERE kind=\'research\'').get() as any).n,2);
 const created=f.plans.execute(user.id,{requestId:randomUUID(),kind:'create',payload:{kind:'trip',node:nodeFields.parse({title:'Agent 离线仍可编辑'})}});
 assert.equal(f.plans.get(created.workspaceId).data.nodes[f.plans.get(created.workspaceId).data.rootId].title,'Agent 离线仍可编辑');
});
test('internal protocol: auth, cookie refusal, protocol version, receipts, cancellation and stale lease',async t=>{
 const db=openDatabase(':memory:'),broker=new ExecutionBroker(db,token,300);t.after(async()=>{await broker.close();db.close();});
 const headers={authorization:`Bearer ${token}`};const post=(path:string,payload:any,extra={})=>broker.app.inject({method:'POST',url:`/internal/agent/v1${path}`,headers:{...headers,...extra},payload});
 const instanceId=randomUUID();
 assert.equal((await post('/register',{instanceId,protocol:2,version:'x',capabilities:['research']})).statusCode,400);
 assert.equal((await post('/register',{instanceId,protocol:1,version:'x',capabilities:['research']},{cookie:'x'})).statusCode,403);
 assert.equal((await post('/register',{instanceId,protocol:1,version:'x',capabilities:['research']},{authorization:'bad'})).statusCode,401);
 await post('/register',{instanceId,protocol:1,version:'x',capabilities:['research']});
 let calls=0;const controller=new AbortController();const job=broker.submit('research',{}, {signal:controller.signal,call:()=>++calls});const rejected=assert.rejects(job.promise,/取消/);
 const {task}= (await post('/claim',{instanceId,kinds:['research']})).json();const body={instanceId,lease:task.lease,operationId:randomUUID(),method:'beforeModel',value:20};
 assert.equal((await post(`/jobs/${job.id}/call`,body)).statusCode,200);assert.equal((await post(`/jobs/${job.id}/call`,body)).statusCode,200);assert.equal(calls,1);
 assert.equal((await post(`/jobs/${job.id}/call`,{...body,value:21})).statusCode,409);
 controller.abort();await rejected;
 assert.equal((await post(`/jobs/${job.id}/call`,{...body,operationId:randomUUID()})).statusCode,409);
 assert.equal((await post(`/jobs/${job.id}/complete`,{instanceId,lease:task.lease,result:{}})).statusCode,409);
 assert.equal(calls,1);
});

test('remote browser and binary image processing keep durable assets in app',async t=>{
 const {AgentWorker}=await import('../src/agent/runtime/worker.js');const {FakeChrome}=await import('./fixtures/fake-chrome.js');const {default:sharp}=await import('sharp');
 const f=await createApp({execution:{token}});await f.execution!.listen('127.0.0.1',0);const port=(f.execution!.app.server.address() as any).port;
 const worker=new AgentWorker(`http://127.0.0.1:${port}`,token,{directory:".cache/two-service-dev/fake-browser",enabled:true,settleMs:0,backendFactory:()=>new FakeChrome()});
 t.after(async()=>{await worker.close();await f.app.close();});await worker.start();
 const user=f.auth.create({username:'owner',name:'owner',password:'testing-password'},true);
 const read=await f.browser.execute(user.id,{action:'read',url:'https://en.wikipedia.org/wiki/Uffizi',requestId:randomUUID()});
 assert.equal(read.status,'partial',JSON.stringify(read));assert.ok(read.missing.includes('remaining_comments'));assert.equal(f.browser.store.get(user.id,read.queryId).result!.data!.text,'Museum description');
 const screenshot=await f.browser.execute(user.id,{action:'screenshot',pageId:read.data!.pageId,requestId:randomUUID()});
 assert.ok(screenshot.artifact,JSON.stringify(screenshot));assert.deepEqual(f.browser.store.artifact(user.id,screenshot.artifact.id).bytes,Buffer.from([0xff,0xd8,0xff,0xd9]));
 const original=await sharp({create:{width:640,height:480,channels:3,background:'#336699'}}).png().toBuffer();
 const {jobId,result}=await f.execution!.submit('image',{process:true},{blobs:{original}}).promise;
 const [bytes,thumbnail]=f.execution!.consumeBlobs(jobId,['image','thumbnail']);
 assert.equal(result.width,640);assert.equal((await sharp(bytes).metadata()).format,'webp');assert.ok(thumbnail.length>0);
 assert.equal((f.db.prepare('SELECT count(*) n FROM execution_blobs').get() as any).n,0);
 await f.browser.releaseLease(user.id);
});

test('card model extraction is independent of Agent and refuses incomplete or oversized responses',async()=>{
 const {cardExtractor}=await import('../src/cards/model.js');let request:any;
 const extractor=cardExtractor({key:'fixture',fetch:async(_url,options)=>{request=JSON.parse(options!.body as string);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"cards":[]}'}}]});}})!;
 assert.deepEqual(await extractor('原始材料',{},new AbortController().signal),{cards:[]});assert.equal(request.messages[1].content,'原始材料');
 const incomplete=cardExtractor({key:'fixture',fetch:async()=>Response.json({choices:[{finish_reason:'length'}]})})!;
 await assert.rejects(incomplete('材料',{},new AbortController().signal),/未完整/);
 const oversized=cardExtractor({key:'fixture',fetch:async()=>new Response(' '.repeat(512001))})!;
 await assert.rejects(oversized('材料',{},new AbortController().signal),/过大/);
});

test('v7 migrates to v8 without changing business rows; restored pending jobs never replay',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const {executionTables}=await import('../src/storage/execution.js');const {default:Database}=await import('better-sqlite3');
 const dir=mkdtempSync(join(tmpdir(),'travel-v8-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'travel.db');
 const original=openDatabase(file);const tables=(original.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as any[]).map(r=>r.name).filter(n=>!executionTables.includes(n));
 const saved=Object.fromEntries(tables.map(n=>[n,original.prepare(`SELECT * FROM ${n}`).all()]));original.pragma('foreign_keys=OFF');for(const name of [...executionTables].reverse())original.exec(`DROP TABLE ${name}`);original.pragma('user_version=7');original.close();
 const migrated=openDatabase(file);assert.equal(migrated.pragma('user_version',{simple:true}),8);for(const name of tables)assert.deepEqual(migrated.prepare(`SELECT * FROM ${name}`).all(),saved[name]);
 const id=randomUUID(),now=Date.now();migrated.prepare("INSERT INTO execution_jobs(id,kind,payload,state,deadline,created) VALUES(?,'research','{}','queued',?,?)").run(id,now+100000,now);migrated.close();
 const db=openDatabase(file),broker=new ExecutionBroker(db,token);assert.equal((db.prepare('SELECT state FROM execution_jobs WHERE id=?').get(id) as any).state,'interrupted');
 await broker.close();db.close();
});

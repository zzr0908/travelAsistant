import { executionTables } from '../src/storage/execution.js';
import type {MapTransportOptions} from '../src/maps/transport.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/service/server/app.js';
import { AgentService, type AgentDriver, type DriverInput, type AgentLimits } from '../src/agent/service.js';
import { instant, sourceQuote } from '../src/agent/proposals.js';
import { nodeFields, emptyDates, type Workspace } from '../src/shared/model.js';
import { type ProposalView, agentOperation } from '../src/shared/agent.js';
import { inspectBackup, backupDatabase, restoreDatabase } from '../src/storage/maintenance.js';
import { openDatabase } from '../src/storage/database.js';
import { mediaTables } from '../src/storage/media-backup.js';
import { mapTables, inspectMapBackup } from '../src/storage/map-backup.js';
import { agentTables, inspectAgentBackup } from '../src/storage/agent-backup.js';

class Driver implements AgentDriver {
  kind = 'test' as const; calls: DriverInput[] = []; releases: string[] = [];
  constructor(public work: (input: DriverInput) => Promise<void> = async i => { i.beforeModel(20); await publish(i, draft()); }) {}
  async run(input: DriverInput) { this.calls.push(input); await this.work(input); }
  async release(id: string) { this.releases.push(id); }
  async close() {}
}
const publish = (i: DriverInput, body: unknown) => i.tools.find(t => t.name === 'publish_result')!.execute(body, i.signal);
const draft = () => ({ answer: '日期未定的佛罗伦萨两日建议；开放信息待核对。', proposal: { title: '两日草案', operations: [
  { kind: 'new_workspace', id: 'root', node: { title: '佛罗伦萨两日' } },
  { kind: 'add_node', id: 'day1', parentId: 'root', node: { title: '第一日：美术馆与河边', notes: '留出午餐时间' } },
  { kind: 'add_node', id: 'day2', parentId: 'root', node: { title: '第二日：花园与留白' } },
  { kind: 'preparation', id: 'prep', title: '确认开放', nodeIds: ['day1'], steps: [{id:'step',text:'日期确定后核对官网'}] },
] } });
const output = (operations: unknown[]) => ({ answer: '已按当前范围提出修改。', proposal: { title: '修改建议', operations } });
const applyInput = (p: ProposalView, requestId = randomUUID()) => ({ requestId, revision: p.revision, digest: p.digest, baseVersion: p.baseVersion });
const fields = (w: Workspace, id: string) => { const {id:_i,parentId:_p,order:_o,...f}=w.data.nodes[id]; return f; };
async function fixture(t: TestContext, work?: (input: DriverInput) => Promise<void>, limits?: Partial<AgentLimits>, database = ':memory:', maps?:MapTransportOptions) {
  const driver = new Driver(work), f = await createApp({ database, maps, agent: { driver, limits } });
  t.after(() => f.app.close());
  const user = f.auth.create({ username: 'owner', name: '组织者', password: 'testing-password' }, true);
  const headers = { cookie: `travel_session=${f.auth.session(user)}`, 'x-travel-app': '1', host: 'localhost' };
  const command = (kind: string, payload: Record<string, unknown>, wid?: string, uid = user.id) => f.plans.execute(uid, { requestId: randomUUID(), kind, payload, ...(wid ? { workspaceId:wid, version:f.plans.get(wid).version } : {}) });
  const create = () => command('create', { kind:'trip',node:nodeFields.parse({title:'意大利',notes:'不能丢的笔记',preference:'慢慢游览'}) }).workspaceId;
  const submit = (extra: Record<string, unknown> = {}, uid = user.id) => f.agent.submit(uid, { requestId: randomUUID(), prompt:'帮我规划', ...extra });
  const complete = async (extra: Record<string, unknown> = {}, uid = user.id) => { const r=submit(extra,uid); await f.agent.wait(r.id); return f.agent.view(r.id,uid); };
  return {...f,driver,user,headers,command,create,submit,complete};
}

test('AP01/08/09/10: draft leaves plans untouched; one atomic adoption, dedup and whole undo', async t => {
 const f=await fixture(t), requestId=randomUUID();
 const first=f.submit({requestId}); assert.equal(f.submit({requestId}).id,first.id);
 assert.throws(()=>f.submit({requestId,prompt:'不同任务'}),/同一请求/);
 await f.agent.wait(first.id); const r=f.agent.view(first.id,f.user.id), p=r.proposal!;
 assert.equal(r.state,'completed'); assert.equal(f.plans.list(f.user.id).length,0); assert.equal(p.diffs.length,4);
 assert.equal(f.db.prepare('SELECT count(*) n FROM changes').get() && (f.db.prepare('SELECT count(*) n FROM changes').get() as {n:number}).n,0);
 const input=applyInput(p), result=f.agent.proposals.apply(p.id,f.user.id,input);
 assert.deepEqual(f.agent.proposals.apply(p.id,f.user.id,input),result);
 assert.deepEqual(f.agent.proposals.apply(p.id,f.user.id,applyInput(p)),result);
 assert.throws(()=>f.agent.proposals.apply(p.id,f.user.id,{...input,digest:'0'.repeat(64)}),/同一请求/);
 const w=f.plans.get(result.workspaceId); assert.equal(w.version,1); assert.equal(Object.keys(w.data.nodes).length,3); assert.equal(f.plans.history(w.id,f.user.id).length,1);
 assert.ok(Object.values(w.data.nodes).every(n=>n.dates.mode==='unset'));
 f.command('undo',{changeId:result.changeId}); assert.equal(f.plans.list(f.user.id).length,0);
 assert.equal(f.agent.proposals.view(p.id,f.user.id).status,'undone');
 assert.deepEqual(f.agent.proposals.apply(p.id,f.user.id,applyInput(p)),result); assert.equal(f.plans.list(f.user.id).length,0);
 inspectAgentBackup(f.db);
});

test('AP08: simulated failure after workspace save rolls back all adoption records', async t=>{
 const f=await fixture(t),r=await f.complete(),p=r.proposal!,original=f.plans.save.bind(f.plans);
 f.plans.save=w=>{original(w);throw new Error('injected persistence failure');};
 assert.throws(()=>f.agent.proposals.apply(p.id,f.user.id,applyInput(p)),/injected/);
 for(const table of ['workspaces','members','changes','agent_apply_requests','agent_published_claims']) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0,table);
 assert.equal(f.agent.proposals.view(p.id,f.user.id).status,'ready'); f.plans.save=original;
 assert.ok(f.agent.proposals.apply(p.id,f.user.id,applyInput(p)).changeId);
});

test('AP02/03/07: patches preserve omitted data; scope, fixed nodes, graph and coordinates guarded',async t=>{
 const f=await fixture(t),wid=f.create(); let w=f.plans.get(wid); const root=w.data.rootId;
 f.command('add',{parentId:root,node:nodeFields.parse({title:'佛罗伦萨'})},wid);
 f.command('add',{parentId:root,node:nodeFields.parse({title:'罗马'})},wid);
 w=f.plans.get(wid); const flor=Object.values(w.data.nodes).find(n=>n.title==='佛罗伦萨')!.id,rome=Object.values(w.data.nodes).find(n=>n.title==='罗马')!.id;
 f.command('add',{parentId:flor,node:nodeFields.parse({title:'固定预约',fixed:true,dates:{...emptyDates(),mode:'fixed',start:'2026-10-03',end:'2026-10-03',startTime:'09:00',endTime:'11:00'}})},wid);
 w=f.plans.get(wid);const fixed=Object.values(w.data.nodes).find(n=>n.fixed)!.id;
 const prep=(ops:unknown[],nodeId=root)=>f.agent.proposals.prepare(f.user.id,{workspaceId:wid,nodeId},output(ops),w);
 const checked=prep([{kind:'update_node',nodeId:root,changes:{title:'新版意大利'}}]);
 assert.deepEqual(checked.proposal!.workspace.data.nodes[root],{...w.data.nodes[root],title:'新版意大利'});
 assert.deepEqual(agentOperation.parse({kind:'update_node',nodeId:root,changes:{title:'x'}}),{kind:'update_node',nodeId:root,changes:{title:'x'}});
 assert.throws(()=>prep([{kind:'update_node',nodeId:rome,changes:{title:'范围外'}}],flor),/范围/);
 assert.throws(()=>prep([{kind:'update_node',nodeId:fixed,changes:{notes:'改写'}}]),/固定/);
 assert.throws(()=>prep([{kind:'move_node',nodeId:flor,parentId:rome}]),/固定/);
 assert.throws(()=>prep([{kind:'move_node',nodeId:flor,parentId:fixed}]),/内部|循环|自己|后代/);
 assert.throws(()=>prep([{kind:'reorder_children',parentId:root,nodeIds:[flor,flor]}]),/重复|遗漏/);
 assert.throws(()=>prep([{kind:'update_node',nodeId:flor,changes:{location:{name:'x',address:'',lat:43,lng:11}}}]),/坐标/);
 assert.throws(()=>prep([{kind:'update_node',nodeId:root,changes:{dates:{...emptyDates(),mode:'fixed',start:'2026-10-04',end:'2026-10-05'}}}]),/冲突/);
 assert.throws(()=>prep([{kind:'progress',nodeId:flor}]),/Invalid/);
 assert.throws(()=>prep([{kind:'update_node',nodeId:root,changes:{progress:{}}}]),/Unrecognized/);
});

test('AP07: cross-midnight/time-zone conflicts, adjacent hours and DST ambiguity',async t=>{
 const f=await fixture(t),wid=f.create(); const w=f.plans.get(wid),scope={workspaceId:wid,nodeId:w.data.rootId};
 const timed=(id:string,start:string,end:string,st:string,et:string,timezone='Europe/Rome')=>({kind:'add_node',id,parentId:w.data.rootId,node:{title:id,dates:{...emptyDates(),mode:'fixed',start,end,startTime:st,endTime:et,timezone}}});
 assert.throws(()=>f.agent.proposals.prepare(f.user.id,scope,output([timed('a','2026-10-03','2026-10-04','23:00','01:00'),timed('b','2026-10-04','2026-10-04','00:30','02:00')]),w),/冲突/);
 assert.throws(()=>f.agent.proposals.prepare(f.user.id,scope,output([timed('a','2026-10-03','2026-10-03','09:00','11:00'),timed('b','2026-10-03','2026-10-03','15:30','17:00','Asia/Shanghai')]),w),/冲突/);
 assert.ok(f.agent.proposals.prepare(f.user.id,scope,output([timed('a','2026-10-03','2026-10-03','09:00','11:00'),timed('b','2026-10-03','2026-10-03','11:00','12:00')]),w).proposal);
 assert.throws(()=>instant('2026-03-29','02:30','Europe/Rome'),/不存在/);
 assert.throws(()=>instant('2026-10-25','02:30','Europe/Rome'),/歧义/);
});

test('AP13: shared preparation content and old steps/progress survive append/association',async t=>{
 const f=await fixture(t),wid=f.create(); let w=f.plans.get(wid);const root=w.data.rootId;
 f.command('add',{parentId:root,node:nodeFields.parse({title:'子行程'})},wid);w=f.plans.get(wid);const child=Object.values(w.data.nodes).find(n=>n.parentId===root)!.id;
 const sid=randomUUID();f.command('prep',{preparation:{title:'订票',note:'已有说明',nodeIds:[root],steps:[{id:sid,text:'核对日期'}]}},wid);w=f.plans.get(wid);const pid=Object.keys(w.data.preparations)[0];
 const prep=(op:unknown,nodeId=root)=>f.agent.proposals.prepare(f.user.id,{workspaceId:wid,nodeId},output([op]),w);
 const op={kind:'preparation',id:pid,title:'订票',note:'已有说明',nodeIds:[child],steps:[{id:sid,text:'核对日期'}]};
 const linked=prep(op,child).proposal!;assert.deepEqual(linked.workspace.data.preparations[pid].nodeIds,[root,child]);
 assert.throws(()=>prep({...op,title:'擅改共用内容'},child),/范围/);
 assert.throws(()=>prep({...op,steps:[{id:'new',text:'删除原步骤'}]}),/已有准备步骤/);
 const appended=prep({...op,steps:[...op.steps,{id:'new',text:'出发前再次核对'}]}).proposal!;
 assert.equal(appended.workspace.data.preparations[pid].steps.length,2);assert.deepEqual(appended.workspace.data.progress,w.data.progress);
});

test('AP17/19: reader may research; private routes reject others; stale versions require regeneration',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);const c=await i.tools[0].execute({},i.signal) as {scopeNodeId:string};await publish(i,output([{kind:'update_node',nodeId:c.scopeNodeId,changes:{description:'AI说明 '+i.id}}]));});
 const wid=f.create(),root=f.plans.get(wid).data.rootId;
 const reader=f.auth.create({username:'reader',name:'只读',password:'testing-password'}),editor=f.auth.create({username:'editor',name:'编辑',password:'testing-password'});
 for(const [u,role] of [[reader,'reader'],[editor,'editor']] as const)f.db.prepare('INSERT INTO members VALUES(?,?,?)').run(wid,u.id,role);
 const r=await f.complete({workspaceId:wid,nodeId:root},reader.id);assert.equal(r.state,'completed');assert.equal(r.proposal!.canApply,false);
 assert.throws(()=>f.agent.proposals.apply(r.proposal!.id,reader.id,applyInput(r.proposal!)),/只读/);
 for(const url of [`/api/agent/runs/${r.id}`,`/api/agent/runs/${r.id}/events?format=json`,`/api/agent/sessions/${r.sessionId}`])assert.ok([403,404].includes((await f.app.inject({url,headers:f.headers})).statusCode));
 assert.equal((await f.app.inject({url:`/api/agent/runs/${r.id}`})).statusCode,401);
 const er=await f.complete({workspaceId:wid,nodeId:root},editor.id);inspectAgentBackup(f.db);
 f.agent.proposals.apply(er.proposal!.id,editor.id,applyInput(er.proposal!));assert.equal(f.plans.get(wid).ownerId,f.user.id);inspectAgentBackup(f.db);
 const r2=await f.complete({workspaceId:wid,nodeId:root});
 const w=f.plans.get(wid);f.command('edit',{nodeId:root,node:{...fields(w,root),notes:'另一窗口的新笔记'}},wid);
 assert.equal(f.agent.view(r2.id,f.user.id).proposal!.status,'stale');assert.throws(()=>f.agent.proposals.apply(r2.proposal!.id,f.user.id,applyInput(r2.proposal!)),/过期|更新/);
 assert.equal(f.plans.get(wid).data.nodes[root].notes,'另一窗口的新笔记');
});

test('AP04/16: queued question persists, answer is idempotent and events replay once',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,i.prompt.includes('我的答复：')?{answer:'按答复继续。'}:{answer:'需要明确目标。',question:{text:'主要想安排哪座城市？',options:['佛罗伦萨','罗马'],required:true}});});
 const r=await f.complete();assert.equal(r.state,'needs_input');assert.equal(f.agent.history(r.sessionId,f.user.id)[0].output!.question!.text,'主要想安排哪座城市？');
 assert.throws(()=>f.agent.answer(r.id,f.user.id,{requestId:randomUUID(),answer:''}),/必要问题/);
 const a=f.agent.answer(r.id,f.user.id,{requestId:randomUUID(),answer:'佛罗伦萨'});assert.equal(f.agent.answer(r.id,f.user.id,{requestId:randomUUID(),answer:'佛罗伦萨'}).id,a.id);
 assert.throws(()=>f.agent.answer(r.id,f.user.id,{requestId:randomUUID(),answer:'罗马'}),/已经答复/);
 await f.agent.wait(a.id);assert.equal(f.agent.history(r.sessionId,f.user.id).length,2);
 const ev=f.agent.events(r.id,f.user.id);assert.deepEqual(ev.map(e=>e.seq),ev.map((_,i)=>i));assert.deepEqual(f.agent.events(r.id,f.user.id,ev.at(-1)!.seq),[]);
});

test('AP15: cancel persists before cleanup; stops dispatch and keeps new input independent',async t=>{
 let attempted=false,cleaned=false;const f=await fixture(t,async i=>{i.beforeModel(1);try{await delay(3000,undefined,{signal:i.signal});}finally{attempted=true;assert.throws(()=>i.beforeModel(1));await delay(25);cleaned=true;}});
 const r=f.submit();await delay(5);const stopped=f.agent.cancel(r.id,f.user.id);assert.equal(stopped.state,'cancelling');assert.equal(f.agent.row(r.id).cancel_requested,1);assert.equal(cleaned,false);
 await f.agent.wait(r.id);assert.equal(attempted,true);assert.equal(cleaned,true);assert.equal(f.agent.view(r.id,f.user.id).state,'cancelled');assert.equal(f.agent.view(r.id,f.user.id).usage.modelRequests,1);assert.equal(f.driver.releases.length,1);
 assert.equal(f.plans.list(f.user.id).length,0);
});

test('AP14/20/21: queue caps, queue expiry, time limit, one repair and unknown usage',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);await delay(1000,undefined,{signal:i.signal});},{concurrency:1,queueSize:1,queueMs:30,runMs:100});
 const u2=f.auth.create({username:'user2',name:'2',password:'testing-password'}),u3=f.auth.create({username:'user3',name:'3',password:'testing-password'});
 const a=f.submit(),b=f.submit({},u2.id);assert.equal(b.state,'queued');assert.throws(()=>f.submit({},u3.id),/队列/);assert.throws(()=>f.submit(),/正在进行/);
 await f.agent.wait(a.id);await f.agent.wait(b.id);assert.match(f.agent.view(a.id,f.user.id).message,/time_limit/);assert.match(f.agent.view(b.id,u2.id).message,/queue_timeout/);assert.equal(f.agent.view(b.id,u2.id).usage.modelRequests,0);
 const repair=await fixture(t,async i=>{i.beforeModel(1);i.usage({model:'glm-5.3-flash'});i.text('非结构化回答');});const r=await repair.complete();assert.equal(r.state,'partial');assert.equal(r.proposal,null);assert.equal(repair.driver.calls.length,2);assert.equal(r.usage.tokens,null);
});

test('AP21: request budget is enforced before outbound requests including repair',async t=>{
 const f=await fixture(t,async i=>{for(let n=0;n<10;n++)i.beforeModel(1);},{modelRequests:2});const r=await f.complete();assert.equal(r.state,'failed');assert.equal(r.usage.modelRequests,2);assert.match(r.message,/budget_limit/);
});

test('AP17: removed membership blocks subsequent model and tool dispatch',async t=>{
 let unblock!:()=>void;const gate=new Promise<void>(r=>unblock=r);const f=await fixture(t,async i=>{i.beforeModel(1);await gate;i.beforeModel(1);await publish(i,{answer:'不应出现'});});
 const wid=f.create(),r=f.submit({workspaceId:wid});await delay(1);f.db.prepare('DELETE FROM members WHERE workspace_id=?').run(wid);unblock();await f.agent.wait(r.id);
 assert.equal(f.agent.row(r.id).state,'failed');assert.equal(JSON.parse(f.agent.row(r.id).usage).modelRequests,1);assert.throws(()=>f.agent.view(r.id,f.user.id),/权限/);
});

test('AP24: v3 backup/restore, v2 migration and corrupt evidence leave current database intact',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'travel-agent-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=await fixture(t,undefined,undefined,join(dir,'travel.db')),r=await f.complete();f.agent.proposals.apply(r.proposal!.id,f.user.id,applyInput(r.proposal!));inspectBackup(join(dir,'travel.db'));
 const backup=join(dir,'saved.db');await backupDatabase(join(dir,'travel.db'),backup);await restoreDatabase(backup,join(dir,'restored'));const restored=openDatabase(join(dir,'restored/travel.db'));assert.equal((restored.prepare('SELECT count(*) n FROM agent_runs').get() as {n:number}).n,1);restored.close();
 f.db.prepare("UPDATE agent_proposals SET digest=?").run('0'.repeat(64));assert.throws(()=>inspectBackup(join(dir,'travel.db')),/哈希/);
 const legacy=openDatabase(join(dir,'legacy.db'));legacy.pragma('foreign_keys=OFF');for(const name of [...agentTables, ...mediaTables, ...mapTables, ...executionTables, 'card_drafts'].reverse())legacy.exec(`DROP TABLE ${name}`);legacy.pragma('user_version=2');legacy.close();await restoreDatabase(join(dir,'legacy.db'),join(dir,'migrated'));const m=openDatabase(join(dir,'migrated/travel.db'));assert.equal(m.pragma('user_version',{simple:true}),8);m.close();
});

test('AP23: restart marks orphaned active runs interrupted without replay',async t=>{
 const f=await fixture(t),r=await f.complete();f.db.prepare("UPDATE agent_runs SET state='running' WHERE id=?").run(r.id);
 const driver=new Driver(),restarted=new AgentService(f.db,f.plans,f.browser,{driver});assert.equal(restarted.view(r.id,f.user.id).state,'interrupted');assert.equal(driver.calls.length,0);await restarted.close();
});

test('AP15: cancelling after staging result cannot publish an adoptable proposal',async t=>{
 let staged!:()=>void;const ready=new Promise<void>(r=>staged=r);const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,draft());staged();await delay(2000,undefined,{signal:i.signal});});const r=f.submit();await ready;f.agent.cancel(r.id,f.user.id);await f.agent.wait(r.id);const v=f.agent.view(r.id,f.user.id);assert.equal(v.state,'cancelled');assert.equal(v.proposal,null);assert.ok(v.output);assert.equal(f.plans.list(f.user.id).length,0);
});

test('AP05/20: comparison cannot silently select a candidate; unavailable models preserve manual planning',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,{answer:'请选择节奏。',candidates:[{id:'art',title:'艺术为主',description:'两个美术馆，步行较少',tradeoffs:'室内时间更多'},{id:'walk',title:'散步为主',description:'一馆与河边留白',tradeoffs:'艺术覆盖较少'}]});});const r=await f.complete();assert.equal(r.output!.candidates.length,2);assert.equal(r.proposal,null);assert.equal(f.plans.list(f.user.id).length,0);
 assert.throws(()=>f.agent.proposals.prepare(f.user.id,{workspaceId:null,nodeId:null},{...draft(),candidates:r.output!.candidates},null),/选择/);
 const fallback=await createApp();t.after(()=>fallback.app.close());const u=fallback.auth.create({username:'manual',name:'Manual',password:'testing-password'},true);assert.equal(fallback.agent.capability().available,false);assert.throws(()=>fallback.agent.submit(u.id,{requestId:randomUUID(),prompt:'保留我的输入'}),/模型不可用/);const result=fallback.plans.execute(u.id,{requestId:randomUUID(),kind:'create',payload:{kind:'standalone',node:nodeFields.parse({title:'仍可手动规划'})}});assert.equal(fallback.plans.list(u.id).length,1);fallback.plans.execute(u.id,{requestId:randomUUID(),kind:'undo',payload:{changeId:result.changeId}});assert.equal(fallback.plans.list(u.id).length,0);
});

test('AP11: whitespace normalization stores the exact source span and never changes words',()=>{
 assert.equal(sourceQuote('前文\nNominative ticket, personal and\u00a0non-transferable.\n后文','Nominative ticket, personal and non-transferable.'),'Nominative ticket, personal and\u00a0non-transferable.');
 assert.equal(sourceQuote('Entrance reservation\n\nTicket purchased prior to entry','Entrance reservation\\n\\nTicket purchased prior to entry'),'Entrance reservation\n\nTicket purchased prior to entry');
 assert.equal(sourceQuote('Reservation is optional.','Reservation is mandatory.'),null);
});

test('AP03/05: range/duration dates and candidate context survive follow-up',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,{answer:'已读取上下文。'});});
 for(const dates of [{...emptyDates(),mode:'window',start:'2026-10-01',end:'2026-10-07'},{...emptyDates(),mode:'duration',minDays:5,maxDays:7}]){
  const wid=f.command('create',{kind:'standalone',node:nodeFields.parse({title:'灵活计划',dates,preference:'艺术'})}).workspaceId;const r=await f.complete({workspaceId:wid});const projection=JSON.parse(f.agent.row(r.id).context).projection;assert.deepEqual(projection.nodes[0].dates,dates);assert.equal(projection.nodes[0].preference,'艺术');assert.equal(f.plans.get(wid).version,1);
 }
});

test('AP14: default scheduler admits two running plus four queued, queued cancellation makes no call',async t=>{
 const f=await fixture(t,async i=>{i.beforeModel(1);await delay(2000,undefined,{signal:i.signal});});
 const users=[f.user,...Array.from({length:6},(_,i)=>f.auth.create({username:'queue'+i,name:'Queue '+i,password:'testing-password'}))];
 const runs=users.slice(0,6).map(u=>f.submit({},u.id));assert.deepEqual(runs.map(r=>r.state),['running','running','queued','queued','queued','queued']);assert.throws(()=>f.submit({},users[6].id),/队列/);
 f.agent.cancel(runs[2].id,users[2].id);assert.equal(f.agent.view(runs[2].id,users[2].id).state,'cancelled');assert.equal(f.agent.view(runs[2].id,users[2].id).usage.modelRequests,0);
 await f.agent.close();assert.ok(runs.every(r=>!['running','queued','cancelling'].includes(f.agent.row(r.id).state)));
});

test('AP04/17: full private API matrix rejects other users and unsigned callers',async t=>{
 const f=await fixture(t),r=await f.complete(),p=r.proposal!;
 const peer=f.auth.create({username:'intruder',name:'Other user',password:'testing-password'}),peerHeaders={...f.headers,cookie:`travel_session=${f.auth.session(peer)}`};
 const cases:[string,string,unknown?][]=[['GET',`/api/agent/runs/${r.id}`],['GET',`/api/agent/sessions/${r.sessionId}`],['GET',`/api/agent/runs/${r.id}/events?format=json`],['POST',`/api/agent/runs/${r.id}/cancel`,{}],['POST',`/api/agent/questions/${r.id}/answer`,{requestId:randomUUID(),answer:'伪造答复'}],['POST',`/api/agent/proposals/${p.id}/apply`,applyInput(p)],['POST',`/api/agent/proposals/${p.id}/reject`,{}]];
 for(const [method,url,payload]of cases)for(const headers of [peerHeaders,{'x-travel-app':'1'}]){const response=await f.app.inject({method:method as 'GET'|'POST',url,headers,...payload?{payload}: {}});assert.ok([401,403,404].includes(response.statusCode),`${method} ${url}: ${response.statusCode}`);}
 assert.equal((await f.app.inject({url:'/api/agent/sessions',headers:peerHeaders})).json().sessions.length,0);assert.equal(f.agent.proposals.view(p.id,f.user.id).status,'ready');
});

test('AP20: failed staging aborts even if a driver swallows tool errors; no phantom proposal or repair', async t => {
  for (const target of ['output', 'event']) {
    const f = await fixture(t, async i => {
      i.beforeModel(1);
      await assert.rejects(publish(i, draft()), /injected staging failure/);
      assert.equal(i.hasResult(), false);
      assert.throws(() => i.beforeModel(1));
    });
    f.db.exec(target === 'output'
      ? "CREATE TRIGGER fail_stage BEFORE UPDATE OF output ON agent_runs BEGIN SELECT RAISE(ABORT,'injected staging failure'); END;"
      : "CREATE TRIGGER fail_stage BEFORE INSERT ON agent_events WHEN NEW.type='result.staged' BEGIN SELECT RAISE(ABORT,'injected staging failure'); END;");
    const r = await f.complete();
    assert.equal(r.state, 'failed'); assert.match(r.message, /结果保存失败/);
    assert.equal(r.output, null); assert.equal(r.proposal, null);
    assert.equal(f.driver.calls.length, 1); assert.equal(r.usage.modelRequests, 1);
    assert.equal(f.plans.list(f.user.id).length, 0);
    assert.equal(f.agent.events(r.id, f.user.id).filter(e => e.type === 'result.staged').length, 0);
  }
});

test('AP20: provider authentication failure preserves prompt and manual planning without repair', async t => {
  const f = await fixture(t, async i => { i.beforeModel(1); throw new Error('401 Unauthorized'); });
  const r = await f.complete({prompt:'仍需保留的输入'});
  assert.equal(r.state, 'failed'); assert.equal(r.prompt, '仍需保留的输入');
  assert.equal(r.proposal, null); assert.equal(f.driver.calls.length, 1);
  const wid=f.create(); assert.equal(f.plans.view(wid,f.user.id).data.nodes[f.plans.get(wid).data.rootId].title,'意大利');
});

test('AP04/24: a pending required question survives database reopen with zero model dispatch', async t => {
  const dir=mkdtempSync(join(tmpdir(),'agent-question-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=await createApp({database:join(dir,'travel.db'),agent:{driver:new Driver(async i=>{i.beforeModel(1);await publish(i,{answer:'需要选择目标',question:{text:'选择哪个同名目标？',options:['甲','乙'],required:true}});})}});
  const user=first.auth.create({username:'question',name:'Question',password:'testing-password'},true),r=first.agent.submit(user.id,{requestId:randomUUID(),prompt:'安排同名目标'});await first.agent.wait(r.id);await first.app.close();
  const driver=new Driver(),next=await createApp({database:join(dir,'travel.db'),agent:{driver}});t.after(()=>next.app.close());
  assert.equal(next.agent.view(r.id,user.id).state,'needs_input');assert.equal(next.agent.view(r.id,user.id).output!.question!.required,true);assert.equal(driver.calls.length,0);
  assert.throws(()=>next.agent.answer(r.id,user.id,{requestId:randomUUID(),answer:''}),/必要问题/);
});

test('AP24: future versions and missing references are rejected before replacing a valid target', async t => {
  const dir=mkdtempSync(join(tmpdir(),'agent-corruption-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=await fixture(t,undefined,undefined,join(dir,'source.db'));await f.complete();
  const saved=join(dir,'saved.db');await backupDatabase(join(dir,'source.db'),saved);const target=join(dir,'restored');await restoreDatabase(saved,target);
  const bad=openDatabase(saved);bad.pragma('user_version=99');bad.close();await assert.rejects(restoreDatabase(saved,target),/版本/);
  const missing=join(dir,'missing.db');await backupDatabase(join(dir,'source.db'),missing);const broken=openDatabase(missing);broken.pragma('foreign_keys=OFF');broken.prepare('UPDATE agent_runs SET session_id=?').run(randomUUID());broken.close();await assert.rejects(restoreDatabase(missing,target),/关联/);
  assert.equal(inspectBackup(join(target,'travel.db')).users,1);
});

test('research can be saved as an independent editable note without adopting its proposal',async t=>{
 const {researchNote}=await import('../src/shared/research-note.js');
 let researchRoot='';
 const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,{answer:'沿河散步攻略\n\n营业时间尚待核对。',claims:[{id:'check',text:'开放时间需要核对',status:'unknown'}],proposal:{title:'新增安排',operations:[{kind:'add_node',id:'walk',parentId:researchRoot,node:{title:'尚未采用的散步'}}]}});});
 const wid=f.create(),root=f.plans.get(wid).data.rootId,before=f.plans.get(wid).data;
 researchRoot=root;
 const run=await f.complete({workspaceId:wid,nodeId:root});
 assert.ok(run.output);assert.ok(run.proposal);
 const note=researchNote(run);assert.deepEqual(note.nodeIds,[]);
 assert.ok(note.body.includes('待核对：开放时间需要核对'));
 assert.ok(note.body.includes('营业时间尚待核对。'));
 const saved=f.command('note',{note:{...note,title:'我的攻略笔记'}},wid);
 assert.deepEqual(f.plans.get(wid).data.nodes,before.nodes);
 assert.notEqual(f.agent.view(run.id,f.user.id).proposal?.status,'applied');
 assert.equal(f.agent.view(run.id,f.user.id).proposal?.changeId,null);
 assert.equal(Object.values(f.plans.get(wid).data.notebook!)[0].title,'我的攻略笔记');
 f.command('undo',{changeId:saved.changeId});assert.deepEqual(f.plans.get(wid).data,before);
});

test('place research keeps a validated target when the model omits spatial output and saves it independently',async t=>{
 const {researchNote}=await import('../src/shared/research-note.js');
 const f=await fixture(t,async i=>{i.beforeModel(1);await publish(i,{answer:'看点仍待来源核对。'});},undefined,':memory:',{apiKey:'synthetic',fetch:async()=>new Response(JSON.stringify({features:[{properties:{place_id:'target',name:'Research Museum',formatted:'Florence, Italy',country_code:'it',result_type:'amenity',categories:['entertainment.museum'],rank:{confidence:1}},geometry:{type:'Point',coordinates:[11.25,43.76]}}]}),{headers:{'Content-Type':'application/json'}})});
 const wid=f.create(),root=f.plans.get(wid).data.rootId;
 const place=(await f.maps.query(f.user.id,{action:'search',text:'Research Museum',workspaceId:wid,requestId:randomUUID()})).assets[0];
 const before=JSON.stringify(f.plans.get(wid).data.nodes);
 const run=await f.complete({workspaceId:wid,nodeId:root,researchPlaceIds:[place.id],prompt:'核对看点'});
 assert.equal(run.state,'completed');assert.deepEqual(run.output?.spatial,[]);
 assert.deepEqual(run.researchPlaceIds,[place.id]);assert.ok(f.driver.calls[0].prompt.includes(place.id));
 const note=researchNote(run);assert.deepEqual(note.spatialIds,[place.id]);assert.ok(note.title.startsWith(place.name));
 f.command('note',{note},wid);assert.equal(JSON.stringify(f.plans.get(wid).data.nodes),before);
 const follow=await f.complete({workspaceId:wid,nodeId:root,sessionId:run.sessionId,parentRunId:run.id,prompt:'继续核对'});
 assert.deepEqual(follow.researchPlaceIds,[place.id]);
 const stranger=f.auth.create({username:'stranger',name:'其他人',password:'testing-password'});
 assert.throws(()=>f.submit({researchPlaceIds:[place.id]},stranger.id),/私人|权限|无权/);
 const context=JSON.parse((f.db.prepare('SELECT context FROM agent_runs WHERE id=?').get(run.id) as {context:string}).context);
 assert.deepEqual(context.researchPlaceIds,[place.id]);
 inspectMapBackup(f.db);
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify({...context,researchPlaceIds:[randomUUID()]}),run.id);
 assert.throws(()=>inspectMapBackup(f.db),/目标|摘要/);
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(context),run.id);
});

test('interrupted research reuses bounded original page text across later rounds and rejects tampered backup excerpts',async t=>{
 const {browserRequest,browserResult}=await import('../src/agent/browser/model.js');
 const {digest}=await import('../src/agent/browser/store.js');
 let fail=true;
 const f=await fixture(t,async i=>{i.beforeModel(1);if(fail)throw new Error('synthetic interruption');await publish(i,{answer:'已有资料已整理。'});});
 const wid=f.create(),nodeId=f.plans.get(wid).data.rootId;
 const first=await f.complete({workspaceId:wid,nodeId});assert.equal(first.state,'failed');
 for(let n=0;n<8;n++){
  const url=`https://www.museogalileo.it/en/test-${n}`,text=`Original page ${n}: `+'x'.repeat(3500);
  const input=browserRequest.parse({action:'read',url,requestId:randomUUID()});
  const query=f.browser.store.begin(f.user.id,input);
  f.browser.store.finish(f.user.id,browserResult.parse({schemaVersion:1,queryId:query.id,capability:'read',providerId:'chrome-devtools-mcp',status:'partial',context:input.context,evidenceIds:[],artifact:null,missing:['media_interpretation'],limitations:['Only rendered text'],retrievedAt:'2026-09-09T00:00:00Z',durationMs:1,usage:{toolCalls:1,browserRequests:null,cost:null},message:'Saved fixture',data:{pageId:randomUUID(),snapshotId:randomUUID(),sourceId:'official',sourceType:'website',url,title:`Page ${n}`,language:'en',contentKind:'page',text,textHash:digest(text),totalTextChars:text.length,truncated:false,textRange:{start:0,end:text.length,nextOffset:null},publishedAt:null,modifiedAt:null,experiencedAt:null,author:null,canonicalUrl:url,license:null,links:[],comments:[],media:[],controls:[],counts:{commentsDetected:0,commentsSaved:0,commentsTotal:null,imagesDetected:0,mediaSaved:0,linksDetected:0,linksSaved:0,controlsDetected:0},viewport:{scrollY:0,height:600,documentHeight:600},evidenceId:null,verification:'unverified'}}));
  f.db.prepare('INSERT INTO agent_browser_queries(query_id,run_id,owner_id) VALUES(?,?,?)').run(query.id,first.id,f.user.id);
 }
 fail=false;
 const second=await f.complete({workspaceId:wid,nodeId,sessionId:first.sessionId});
 const third=await f.complete({workspaceId:wid,nodeId,sessionId:first.sessionId});
 const readContext=(id:string)=>JSON.parse((f.db.prepare('SELECT context FROM agent_runs WHERE id=?').get(id) as {context:string}).context);
 for(const run of [second,third]){
  assert.match(run.message,/此前保存的网页摘录/);assert.match(run.message,/行程未改变/);assert.doesNotMatch(run.message,/未查阅网页/);
  const context=readContext(run.id),retained=context.previousRuns.find((r:any)=>r.retainedResearch)?.retainedResearch;
  assert.equal(retained.sourceRunId,first.id);assert.equal(retained.pages.length,6);
  assert.ok(retained.pages.every((p:any)=>p.text.length===3000&&p.truncated&&p.limitations[0]==='Only rendered text'));
  assert.ok(f.driver.calls.find(call=>call.id===run.id)?.prompt.includes('Original page 7:'));
 }
 inspectMapBackup(f.db);
 const original=readContext(third.id),changed=structuredClone(original);
 changed.previousRuns.find((r:any)=>r.retainedResearch).retainedResearch.pages[0].text='fabricated';
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(changed),third.id);
 assert.throws(()=>inspectMapBackup(f.db),/保留正文/);
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(original),third.id);
 const wrongSource=structuredClone(original);
 wrongSource.previousRuns.find((r:any)=>r.retainedResearch).retainedResearch.sourceRunId=second.id;
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(wrongSource),third.id);
 assert.throws(()=>inspectMapBackup(f.db),/保留正文/);
 f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(original),third.id);
 const separate=await f.complete({workspaceId:wid,nodeId});
 assert.deepEqual(readContext(separate.id).previousRuns,[]);
});

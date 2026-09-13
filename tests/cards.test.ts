import {samplePdf} from './fixtures/cards/sample-pdf.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/service/server/app.js';
import {blankCard,parseCard,cardInstant,fixedCardDates,cardsContext,type Card} from '../src/shared/cards.js';
import {nodeFields,emptyDates} from '../src/shared/model.js';
import {pdfText,type CardExtractor} from '../src/cards/import.js';
import {inspectBackup,restoreDatabase} from '../src/storage/maintenance.js';
import {openDatabase} from '../src/storage/database.js';
import {Plans} from '../src/service/domain/plans.js';

const card=(type:Card['type']='reservation'):Card=>({...blankCard(type),id:randomUUID(),reviewState:'reviewed',source:{label:'手工填写',hash:null,evidence:{}},bindings:[]});
function reservation():Card {const c=card();if(c.type==='reservation'){c.title='定时预约';c.facts.place='乌菲齐';c.facts.start={date:'2026-10-03',time:'10:30',timezone:'Europe/Rome'};}return c;}
async function fixture(t:TestContext,extractCards?:CardExtractor) {
 const f=await createApp({agent:{driver:{kind:'test',extractCards,async run(){},async close(){}}}});t.after(()=>f.app.close());
 const user=f.auth.create({username:'owner',name:'组织者',password:'testing-password'},true);
 const other=f.auth.create({username:'other',name:'同行者',password:'testing-password'});
 const run=(kind:string,payload:Record<string,unknown>,id?:string,version?:number,requestId=randomUUID(),who=user.id)=>f.plans.execute(who,{kind,payload,requestId,...(id?{workspaceId:id,version:version??f.plans.get(id).version}:{})});
 const wid=run('create',{kind:'trip',node:{title:'旅行'}}).workspaceId;
 const root=f.plans.get(wid).data.rootId;
 const headers={cookie:`travel_session=${f.auth.session(user)}`,'x-travel-app':'1'};
 return {...f,user,other,run,wid,root,headers};
}
test('cards: timezone conversion and unknown values preserve material precision',async t=>{
 const f=await fixture(t),c=card('transport');if(c.type!=='transport')throw Error();
 c.facts.departure={date:'2026-10-02',time:'22:30',timezone:'America/New_York'};
 c.facts.arrival={date:'2026-10-03',time:'12:45',timezone:'Europe/Rome'};
 const result=fixedCardDates(c);assert.equal(result.end,'2026-10-03');assert.equal(result.endTime,'06:45');assert.equal(result.timezone,'America/New_York');
 f.run('cards',{entries:[{card:c,createUnder:f.root}]},f.wid);
 assert.deepEqual(f.plans.get(f.wid).data.cards![c.id].facts,c.facts);
 const unknown=reservation();if(unknown.type!=='reservation')throw Error();unknown.facts.start.timezone=null;
 const version=f.plans.get(f.wid).version;
 assert.throws(()=>f.run('cards',{entries:[{card:unknown,createUnder:f.root}]},f.wid),/时区/);
 assert.equal(f.plans.get(f.wid).version,version);
 f.run('cards',{entries:[{card:unknown}]},f.wid);assert.equal((f.plans.get(f.wid).data.cards![unknown.id] as typeof unknown).facts.start.timezone,null);
 assert.throws(()=>cardInstant({date:'2026-10-25',time:'02:30',timezone:'Europe/Rome'}),/歧义/);
 assert.throws(()=>parseCard({...unknown,unexpected:true}));
});
test('cards: fixed facts cannot drift; partial Agent edits preserve cards and other fields',async t=>{
 const f=await fixture(t),c=reservation();f.run('cards',{entries:[{card:c,createUnder:f.root}]},f.wid);
 let w=f.plans.get(f.wid);const fixed=w.data.cards![c.id].bindings[0].nodeId;
 const operations=(ops:unknown[])=>({answer:'格式夹具',proposal:{title:'修改',operations:ops}});
 assert.throws(()=>f.agent.proposals.prepare(f.user.id,{workspaceId:f.wid,nodeId:f.root},operations([{kind:'update_node',nodeId:fixed,changes:{dates:{...w.data.nodes[fixed].dates,startTime:'11:00'}}}]),w),/卡片|固定/);
 const bad=structuredClone(w.data.nodes[fixed]);bad.dates.startTime='11:00';const {id,parentId,order,...fields}=bad;
 assert.throws(()=>f.run('edit',{nodeId:id,node:fields,confirmFixed:true},f.wid),/卡片/);
 f.run('add',{parentId:f.root,node:nodeFields.parse({title:'可调整安排',notes:'保留备注',description:'原介绍'})},f.wid);
 w=f.plans.get(f.wid);const n=Object.values(w.data.nodes).find(n=>n.title==='可调整安排')!;
 const p=f.agent.proposals.prepare(f.user.id,{workspaceId:f.wid,nodeId:f.root},operations([{kind:'update_node',nodeId:n.id,changes:{description:'新介绍'}}]),w).proposal!;
 assert.equal(p.workspace.data.nodes[n.id].notes,'保留备注');assert.deepEqual(p.workspace.data.cards,w.data.cards);
 const timed=structuredClone(w);timed.data.nodes[n.id].dates={...emptyDates(),mode:'fixed',start:'2026-10-04',end:'2026-10-04',startTime:'09:00',endTime:'10:00',timezone:'Asia/Shanghai'};
 const partial=f.agent.proposals.prepare(f.user.id,{workspaceId:f.wid,nodeId:f.root},operations([{kind:'update_node',nodeId:n.id,changes:{dates:{startTime:'09:15'},location:{name:'公园'}}}]),timed).proposal!;
 assert.deepEqual(partial.workspace.data.nodes[n.id].dates,{...timed.data.nodes[n.id].dates,startTime:'09:15'});assert.equal(partial.workspace.data.nodes[n.id].location.address,timed.data.nodes[n.id].location.address);
 const hotel=card('lodging');if(hotel.type!=='lodging')throw Error();hotel.facts.checkIn='2026-10-01';hotel.facts.checkOut='2026-10-05';hotel.bindings=[{nodeId:f.root,mode:'reference'}];
 f.run('cards',{entries:[{card:hotel}]},f.wid);w=f.plans.get(f.wid);
 assert.doesNotThrow(()=>f.agent.proposals.prepare(f.user.id,{workspaceId:f.wid,nodeId:f.root},operations([{kind:'update_node',nodeId:n.id,changes:{description:'白天活动照常'}}]),w));
 const invalid=reservation();invalid.bindings=[{nodeId:'missing',mode:'reference'}];assert.throws(()=>f.run('cards',{entries:[{card:invalid}]},f.wid),/不存在/);
 assert.equal(cardsContext(w.data,n.id).length,1,'only ancestor hotel reference enters unrelated child context');
 f.run('add',{parentId:f.root,node:{title:'错误日期',dates:{...emptyDates(),mode:'fixed',start:'2026-10-04',end:'2026-10-04'}}},f.wid);
 const target=Object.values(f.plans.get(f.wid).data.nodes).find(n=>n.title==='错误日期')!;
 assert.throws(()=>f.run('move',{nodeId:fixed,parentId:target.id},f.wid),/上级日期/);
});
test('cards: permissions, duplicate requests, stale versions and atomic synchronization/undo',async t=>{
 const f=await fixture(t),c=reservation(),requestId=randomUUID(),v=f.plans.get(f.wid).version;
 const payload={entries:[{card:c,createUnder:f.root}]};
 const result=f.run('cards',payload,f.wid,v,requestId);
 assert.deepEqual(f.run('cards',payload,f.wid,v,requestId),result);
 assert.equal(Object.keys(f.plans.get(f.wid).data.nodes).length,2);
 assert.throws(()=>f.run('cards',payload,f.wid,v),/已有更新/);
 assert.throws(()=>f.run('cards',payload,f.wid,undefined,randomUUID(),f.other.id),/权限/);
 let w=f.plans.get(f.wid),updated=structuredClone(w.data.cards![c.id]);if(updated.type!=='reservation')throw Error();updated.facts.start.time='11:00';
 const change=f.run('cards',{entries:[{card:updated}]},f.wid);w=f.plans.get(f.wid);
 assert.equal(w.data.nodes[updated.bindings[0].nodeId].dates.startTime,'11:00');
 f.run('undo',{changeId:change.changeId});w=f.plans.get(f.wid);
 assert.equal(w.data.nodes[updated.bindings[0].nodeId].dates.startTime,'10:30');
 assert.equal((w.data.cards![c.id] as typeof updated).facts.start.time,'10:30');
 const dup={...reservation(),source:{label:'订单',hash:'a'.repeat(64),evidence:{}}};f.run('cards',{entries:[{card:dup}]},f.wid);
 assert.throws(()=>f.run('cards',{entries:[{card:{...dup,id:randomUUID()}}]},f.wid),/已导入/);
});
test('cards: legacy data, merge, removal and backup retain references and history bytes',async t=>{
 const f=await fixture(t);assert.equal(f.plans.get(f.wid).data.cards,undefined);
 const source=f.run('create',{kind:'standalone',node:{title:'独立安排'}}).workspaceId,root=f.plans.get(source).data.rootId;
 const c=reservation();f.run('cards',{entries:[{card:c,createUnder:root}]},source);
 const history=f.db.prepare('SELECT before_data,request_body FROM changes').all();
 const merge=f.run('merge',{targetId:f.wid,targetVersion:f.plans.get(f.wid).version,parentId:f.root},source);
 const w=f.plans.get(f.wid);assert.ok(w.data.cards![c.id]);assert.ok(w.data.nodes[w.data.cards![c.id].bindings[0].nodeId]);
 const dir=mkdtempSync(join(tmpdir(),'cards-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'backup.db');await f.db.backup(path);assert.doesNotThrow(()=>inspectBackup(path));
 await restoreDatabase(path,join(dir,'restored'));const restored=openDatabase(join(dir,'restored/travel.db'));assert.deepEqual(new Plans(restored).get(f.wid).data,w.data);restored.close();
 assert.deepEqual(f.db.prepare('SELECT before_data,request_body FROM changes LIMIT ?').all(history.length),history);
 f.run('undo',{changeId:merge.changeId});assert.equal(f.plans.get(f.wid).data.cards,undefined);assert.ok(f.plans.get(source).data.cards![c.id]);
 const n=f.plans.get(source).data.cards![c.id].bindings[0].nodeId;
 f.run('removePlan',{nodeId:n,confirmFixed:true},source);assert.deepEqual(f.plans.get(source).data.cards![c.id].bindings,[]);
});
test('cards: PDF parsing and rejected inputs need no model calls',async()=>{
 assert.match(await pdfText(samplePdf(['Flight AZ611','Departure 2026-10-02 22:30 America/New_York','Arrival 2026-10-03 12:45 Europe/Rome'])),/America\/New_York/);
 await assert.rejects(pdfText(samplePdf([])),/没有可提取/);
 await assert.rejects(pdfText(new Uint8Array(5*1024*1024+1)),/5MB/);
});
test('cards: private resumable draft, duplicate extraction and confirmation are bounded',async t=>{
 let calls=0;
 const f=await fixture(t,async text=>{calls++;const {id,reviewState,source,bindings,...content}=reservation();return {cards:[{content,evidence:{'facts.start':text}}]};});
 const payload={requestId:randomUUID(),workspaceId:f.wid,label:'预约文字',text:'2026-10-03 10:30 Europe/Rome 乌菲齐预约'};
 const start=await f.app.inject({method:'POST',url:'/api/card-drafts',headers:f.headers,payload});assert.equal(start.statusCode,200);
 const id=start.json().id;
 let draft=f.cards.view(f.user.id,id);for(let i=0;i<20&&draft.state==='running';i++){await new Promise(r=>setTimeout(r,5));draft=f.cards.view(f.user.id,id);}
 assert.equal(draft.state,'ready');assert.equal(draft.cards[0].reviewState,'pending');assert.equal(f.plans.get(f.wid).data.cards,undefined);
 assert.throws(()=>f.cards.view(f.other.id,id),/不存在/);
 await f.app.inject({method:'POST',url:'/api/card-drafts',headers:f.headers,payload});assert.equal(calls,1);
 const c={...draft.cards[0],reviewState:'reviewed' as const};f.cards.update(f.user.id,id,{cards:[c]});assert.equal(f.cards.list(f.user.id,f.wid)[0].cards[0].reviewState,'reviewed');
 const result=f.run('cards',{entries:[{card:c,createUnder:f.root}],draftId:id},f.wid);assert.equal(f.cards.view(f.user.id,id).state,'saved');
 f.run('undo',{changeId:result.changeId});assert.equal(f.plans.get(f.wid).data.cards,undefined);
});

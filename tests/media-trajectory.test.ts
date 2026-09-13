import { executionTables } from '../src/storage/execution.js';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createApp} from '../src/service/server/app.js';
import {MediaStore, imageIdentity, imageExclusion, downloadImage} from '../src/agent/media.js';
import {Trajectory,redact} from '../src/agent/trajectory.js';
import {browserRequest,type BrowserResult,type PageData} from '../src/agent/browser/model.js';
import {digest} from '../src/agent/browser/store.js';
import {nodeFields,emptyDates} from '../src/shared/model.js';
import {inspectBackup,restoreDatabase} from '../src/storage/maintenance.js';
import {openDatabase} from '../src/storage/database.js';
import type { MapTransportOptions } from '../src/maps/transport.js';

async function fixture(t: TestContext, mediaDownload?: typeof downloadImage, maps?: MapTransportOptions) {
  const f=await createApp({maps,agent:{mediaDownload,driver:{kind:'test',async close(){},async run(i){i.beforeModel(10);i.request?.({messages:[{role:'user',content:i.prompt}],config:{maxTokens:i.maxTokens},apiKey:'secret-key-example'});await i.tools.find(t=>t.name==='publish_result')!.execute({answer:'受控验收记录：未查阅网页。'},i.signal);}}}});
  t.after(()=>f.app.close());
  const owner=f.auth.create({username:'owner',name:'组织者',password:'testing-password'},true),peer=f.auth.create({username:'peer',name:'同行',password:'testing-password'}),stranger=f.auth.create({username:'stranger',name:'无权用户',password:'testing-password'});
  const headers=(user=owner)=>({cookie:`travel_session=${f.auth.session(user)}`,'x-travel-app':'1',host:'localhost'});
  const r=f.agent.submit(owner.id,{requestId:randomUUID(),prompt:'图片与轨迹受控测试'});await f.agent.wait(r.id);
  const query=(refs: {url:string;alt?:string;caption?:string}[])=>{
    const input=browserRequest.parse({action:'read',requestId:randomUUID(),url:'https://www.uffizi.it/en/the-uffizi'}),started=f.browser.store.begin(owner.id,input);
    const text='Official page fixture with images.';
    const page: PageData={pageId:randomUUID(),snapshotId:randomUUID(),sourceId:'official',sourceType:'official',url:input.action==='read'?input.url:'',title:'受控来源图片',language:'en',contentKind:'page',text,textHash:digest(text),totalTextChars:text.length,truncated:false,textRange:{start:0,end:text.length,nextOffset:null},publishedAt:null,modifiedAt:null,experiencedAt:null,author:null,canonicalUrl:null,license:null,links:[],comments:[],media:refs.map(x=>({kind:'image',url:x.url,alt:x.alt || '',caption:x.caption || '',status:'reference_only'})),controls:[],counts:{commentsDetected:0,commentsSaved:0,commentsTotal:null,imagesDetected:refs.length,mediaSaved:refs.length,linksDetected:0,linksSaved:0,controlsDetected:0},viewport:{scrollY:0,height:800,documentHeight:800},evidenceId:randomUUID(),verification:'unverified'};
    const result:BrowserResult={schemaVersion:1,queryId:started.id,capability:'browser.read',providerId:'chrome-devtools-mcp',status:'ok',data:page,evidenceIds:[],artifact:null,context:input.context,missing:[],limitations:[],retrievedAt:new Date().toISOString(),durationMs:30,usage:{toolCalls:1,browserRequests:null,cost:null},message:'受控页面'};
    f.browser.store.finish(owner.id,result);f.db.prepare('INSERT INTO agent_browser_queries VALUES(?,?,?)').run(started.id,r.id,owner.id);return started.id;
  };
  const command=(kind:string,payload:Record<string,unknown>,workspaceId?:string,user=owner)=>f.plans.execute(user.id,{kind,payload,requestId:randomUUID(),...(workspaceId?{workspaceId,version:f.plans.get(workspaceId).version}:{})});
  return {...f,owner,peer,stranger,headers,run:r.id,query,command};
}
const picture=(width:number,height:number,color='#447799')=>sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();

test('MA14/19: retained research images are available to the same private discussion after a stopped run',async t=>{
  const f=await fixture(t,async()=>picture(900,600));
  await f.agent.media.gather(f.query([{url:'https://www.uffizi.it/retained.jpg',alt:'受控已保存图片'}]),f.run,f.owner.id);
  const image=f.agent.media.run(f.run)[0];
  // This isolated fixture represents an acquired picture followed by a stopped model run.
  f.db.prepare("UPDATE agent_runs SET state='failed',output=NULL WHERE id=?").run(f.run);
  const previous=f.agent.view(f.run,f.owner.id);
  const next=f.agent.submit(f.owner.id,{requestId:randomUUID(),sessionId:previous.sessionId,prompt:'继续复用已经保存的图片'});await f.agent.wait(next.id);
  const context=JSON.parse((f.db.prepare('SELECT context FROM agent_runs WHERE id=?').get(next.id) as {context:string}).context);
  assert.equal(context.previousRuns.at(-1).retainedResearch.media[0].id,image.id);
  assert.equal(f.agent.view(next.id,f.owner.id).usage.browserQueries,0);
  assert.throws(()=>f.agent.submit(f.peer.id,{requestId:randomUUID(),sessionId:previous.sessionId,prompt:'尝试复用私人图片'}),/会话与本次规划范围/);
});

test('MA05/11: map-linked media keeps occurrences and candidate ownership, and shared history cannot revive detached images',async t=>{
  const f=await fixture(t,async url=>picture(900,600,url.includes('second')?'#ccaa55':'#447799'),{apiKey:'fake-map-key',fetch:async()=>new Response(JSON.stringify({features:[{properties:{place_id:'fixture-museum',name:'受控博物馆',category:'entertainment.museum',country_code:'it'},geometry:{type:'Point',coordinates:[11.25,43.77]}}]}),{headers:{'content-type':'application/json'}})});
  await f.agent.media.gather(f.query([{url:'https://www.uffizi.it/first.jpg'},{url:'https://www.uffizi.it/second.jpg'}]),f.run,f.owner.id);
  const [image,other]=f.agent.media.run(f.run),wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'图文地图受控计划'})}).workspaceId,root=f.plans.get(wid).data.rootId;
  for(const title of ['第一次参观','稍后返回'])f.command('add',{parentId:root,node:nodeFields.parse({title,description:title+'的说明'})},wid);
  const [a,b]=Object.values(f.plans.get(wid).data.nodes).filter(n=>n.id!==root);
  const place=(await f.maps.query(f.owner.id,{action:'search',text:'受控博物馆',requestId:randomUUID()})).assets[0];
  f.command('media',{nodeId:a.id,mediaIds:[image.id,other.id]},wid);f.command('media',{nodeId:b.id,mediaIds:[image.id]},wid);
  const bindings=(mediaIds:string[])=>[{assetId:place.id,primary:true,optional:false,nodeIds:[],mediaIds}];
  for(const n of [a,b])f.command('spatial',{nodeId:n.id,bindings:bindings([image.id])},wid);
  const before=f.plans.get(wid);
  assert.equal(before.data.spatial![a.id][0].assetId,before.data.spatial![b.id][0].assetId);
  assert.throws(()=>f.command('spatial',{nodeId:b.id,bindings:bindings([other.id])},wid),/同一计划/);
  const compare={answer:'受控比较',candidates:[{id:'a',title:'甲',description:'甲',tradeoffs:'甲'},{id:'b',title:'乙',description:'乙',tradeoffs:'乙'}],media:[{mediaId:image.id,candidateId:'a'},{mediaId:other.id,candidateId:'b'}]};
  for(const nodeId of [undefined,a.id])assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:wid,nodeId:root},{...compare,spatial:[{assetId:place.id,nodeId,candidateId:'a',mediaIds:[other.id]}]},before),/同一回答、候选或计划/);
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
  const sharedGallery=await f.app.inject({url:`/api/workspaces/${wid}/media?nodeId=${a.id}`,headers:f.headers(f.peer)});
  assert.equal(sharedGallery.statusCode,200);assert.equal(sharedGallery.json().mapNames[place.id],'受控博物馆 · 地点');
  assert.equal((await f.app.inject({url:`/api/workspaces/${wid}/media?nodeId=${a.id}`,headers:f.headers(f.stranger)})).statusCode,403);
  const unknownNode=await f.app.inject({url:`/api/workspaces/${wid}/media?nodeId=${randomUUID()}`,headers:f.headers(f.peer)});
  assert.deepEqual(unknownNode.json().mapNames,{});assert.deepEqual(unknownNode.json().media,[]);
  const run=f.agent.submit(f.peer.id,{workspaceId:wid,nodeId:root,prompt:'读取已有图文对应',requestId:randomUUID()});await f.agent.wait(run.id);
  const prepared=f.agent.proposals.prepare(f.peer.id,{workspaceId:wid,nodeId:root},{answer:'共享图片引用的受控回放',spatial:[{assetId:place.id,nodeId:a.id,mediaIds:[image.id]},{assetId:place.id,nodeId:b.id,mediaIds:[image.id]}]},before);
  // Controlled saved output exercises history presentation without a new model.
  f.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(JSON.stringify(prepared),run.id);
  const view=f.agent.view(run.id,f.peer.id);
  assert.equal(view.media.length,1);assert.equal(view.media[0].id,image.id);assert.equal(view.media[0].accessWorkspaceId,wid);
  assert.match(view.output!.spatial[0].title!,/第一次参观/);assert.match(view.output!.spatial[1].title!,/稍后返回/);
  assert.equal(view.output!.spatial[0].description,'第一次参观的说明');
  assert.deepEqual(f.plans.get(wid),before,'reading associations must not write the plan');
  for(const n of [a,b])f.command('media',{nodeId:n.id,mediaIds:[]},wid);
  const after=f.agent.view(run.id,f.peer.id);assert.equal(after.media.length,0);
  assert.equal(after.output!.spatial[0].mediaIds[0],image.id,'historical reference survives, without current image access');
  assert.throws(()=>f.agent.media.allowed(image.id,f.peer.id,wid),/尚未公开/);
});

test('RM01/04/06: bounded acquisition filters mixed assets, same-source variants, exact duplicates, corruption and low resolution',async t=>{
  const f=await fixture(t), calls:string[]=[],wide=await picture(1200,800),portrait=await picture(600,1000,'#ac7f41');
  const store=new MediaStore(f.db,async url=>{calls.push(url);if(url.includes('404'))throw new Error('原图已失效（404）');if(url.includes('nonimage'))return Buffer.from('<html>not an image</html>');if(url.includes('oversize'))return Buffer.alloc(8*1024*1024+1);if(url.includes('small'))return picture(100,100);if(url.includes('portrait'))return portrait;return wide;});
  const prefix='https://www.datocms-assets.com/103094/';
  for(const refs of [
    ['logo.svg','advert.jpg','avatar.png','icon.webp'],['wide.jpg?w=600','wide.jpg?w=1200','same-pixels.jpg','portrait.jpg'],['small.jpg','404.jpg','nonimage.jpg','oversize.jpg'],['thumb.jpg?width=500&height=300','thumb.jpg?width=1000&height=600','social.png','tracking.gif'],['second-logo.jpg','other-advert.jpg','pixel.gif','sprite.png'],
  ])await store.gather(f.query(refs.map(url=>({url:prefix+url}))),f.run,f.owner.id);
  const all=store.run(f.run),ready=all.filter(m=>m.status==='ready');assert.equal(ready.length,2);assert.equal(ready.find(m=>m.url.includes('portrait'))!.height,1000);
  assert.ok(all.filter(m=>m.status==='excluded').length>=10);assert.equal(all.filter(m=>m.status==='failed').length,3);assert.equal(calls.filter(u=>/wide.jpg/.test(u)).length,1);assert.deepEqual(calls.map(u=>new URL(u).pathname.split('/').at(-1)),['wide.jpg','same-pixels.jpg','portrait.jpg','small.jpg','404.jpg','nonimage.jpg','oversize.jpg','thumb.jpg']);
  for(const m of ready){const row=store.allowed(m.id,f.owner.id);assert.equal(digest(row.bytes!),m.sha256);assert.ok(row.thumbnail!.length>0);assert.equal(m.interpretation,'not_performed');assert.ok(m.sourceUrl);}
  assert.equal(imageIdentity(prefix+'image.jpg?w=300&h=400'),imageIdentity(prefix+'image.jpg?h=800&w=600'));assert.ok(imageExclusion(prefix+'ad.jpg','advert'));await assert.rejects(downloadImage('http://127.0.0.1/private'),/来源/);
  assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:null,nodeId:null},{answer:'伪造图',media:[{mediaId:randomUUID()}]},null),/图片/);
});

test('RM03/TR06: image adoption, private boundaries, repeat, replace/detach/undo, fixed schedule, shared progress, merge and restore',async t=>{
  const f=await fixture(t),store=new MediaStore(f.db,async()=>picture(960,640));
  await store.gather(f.query([{url:'https://www.uffizi.it/gallery.jpg',alt:'测试展厅'}]),f.run,f.owner.id);const asset=store.run(f.run)[0];
  const wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'图文行程',fixed:true,dates:{...emptyDates(),mode:'fixed',start:'2026-10-03',end:'2026-10-03'}})}).workspaceId,base=f.plans.get(wid),root=base.data.rootId;
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
  const raw={answer:'已生成配图提议',media:[{mediaId:asset.id}],proposal:{title:'添加展厅图',operations:[{kind:'set_media',nodeId:root,mediaIds:[asset.id]}]}};
  let checked=f.agent.proposals.prepare(f.owner.id,{workspaceId:wid,nodeId:root},raw,base);assert.equal(checked.proposal!.diffs.length,1);assert.deepEqual(f.plans.get(wid),base);
  const id=f.agent.proposals.insert(f.run,checked.proposal!),p=f.agent.proposals.view(id,f.owner.id);
  const peerHeaders=f.headers(f.peer),ownerHeaders=f.headers();
  assert.equal((await f.app.inject({url:`/api/media/${asset.id}`,headers:peerHeaders})).statusCode,403);
  assert.equal((await f.app.inject({url:`/api/media/${asset.id}?workspaceId=${wid}`,headers:peerHeaders})).statusCode,403);
  const input={requestId:randomUUID(),revision:p.revision,digest:p.digest,baseVersion:p.baseVersion},applied=f.agent.proposals.apply(id,f.owner.id,input);assert.deepEqual(f.agent.proposals.apply(id,f.owner.id,input),applied);
  assert.deepEqual(f.plans.get(wid).data.nodes,base.data.nodes);assert.deepEqual(f.plans.get(wid).data.progress,base.data.progress);
  const image=await f.app.inject({url:`/api/media/${asset.id}?workspaceId=${wid}`,headers:peerHeaders});assert.equal(image.statusCode,200);assert.equal(digest(image.rawPayload),asset.sha256);
  for(const path of [`/api/agent/runs/${f.run}/trajectory`,`/api/agent/runs/${f.run}/trajectory/a%3A0`,`/api/agent/runs/${f.run}/trajectory-export`])assert.equal((await f.app.inject({url:path,headers:peerHeaders})).statusCode,403);
  assert.equal((await f.app.inject({url:`/api/media/${asset.id}?workspaceId=${wid}`,headers:f.headers(f.stranger)})).statusCode,403);
  assert.throws(()=>f.command('media',{nodeId:root,mediaIds:[]},wid,f.peer),/只读/);
  const beforeDetach=f.agent.view(f.run,f.owner.id).trajectoryRevision;
  const detached=f.command('media',{nodeId:root,mediaIds:[]},wid);assert.equal((await f.app.inject({url:`/api/media/${asset.id}?workspaceId=${wid}`,headers:peerHeaders})).statusCode,403);
  assert.notEqual(f.agent.view(f.run,f.owner.id).trajectoryRevision,beforeDetach,'completed trajectory must refresh after a plan media change');
  f.command('undo',{changeId:detached.changeId});assert.deepEqual(f.plans.get(wid).data.media?.[root],[asset.id]);
  const trace=new Trajectory(f.db).export(f.run) as any;assert.ok(trace.records.some((x:any)=>x.item.title.includes('修改配图')));assert.ok(trace.records.some((x:any)=>x.item.title.includes('采用')));assert.ok(trace.records.some((x:any)=>x.item.title.includes('撤销') && x.raw.request.payload?.changeId===detached.changeId));
  const dir=mkdtempSync(join(tmpdir(),'media-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const backup=join(dir,'backup.db');await f.db.backup(backup);inspectBackup(backup);await restoreDatabase(backup,join(dir,'restored'));
  const restored=openDatabase(join(dir,'restored/travel.db'));assert.equal(digest(new MediaStore(restored).allowed(asset.id,f.peer.id,wid).bytes!),asset.sha256);restored.close();
  const corrupted=join(dir,'bad.db');copyFileSync(backup,corrupted);const broken=openDatabase(corrupted);broken.prepare('UPDATE media_assets SET thumbnail=? WHERE id=?').run(Buffer.from('bad'),asset.id);broken.close();await assert.rejects(restoreDatabase(corrupted,join(dir,'restored')),/图片|缩略图/);
  const still=openDatabase(join(dir,'restored/travel.db'));assert.equal(digest(new MediaStore(still).row(asset.id).bytes!),asset.sha256);still.close();
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(wid,f.peer.id);assert.equal((await f.app.inject({url:`/api/media/${asset.id}?workspaceId=${wid}`,headers:peerHeaders})).statusCode,403);
  assert.equal((await f.app.inject({url:`/api/media/${asset.id}?size=thumb`,headers:ownerHeaders})).statusCode,200);
});

test('RM06: failed media retries preserve identity and do not repeat model or webpage research',async t=>{
 const f=await fixture(t);let attempts=0;const store=new MediaStore(f.db,async()=>{attempts++;if(attempts===1)throw new Error('原图已失效（404）');return picture(800,600);});
 await store.gather(f.query([{url:'https://www.uffizi.it/retry.jpg'}]),f.run,f.owner.id);const failed=store.run(f.run)[0];assert.equal(failed.status,'failed');
 const usage=f.agent.view(f.run,f.owner.id).usage;await Promise.all([store.retry(failed.id,f.owner.id),store.retry(failed.id,f.owner.id)]);assert.equal(store.metadata(failed.id).status,'ready');assert.equal(attempts,2);assert.deepEqual(f.agent.view(f.run,f.owner.id).usage,usage);await store.retry(failed.id,f.owner.id);assert.equal(attempts,2);
});

test('TR01/02/05/07/08: all 1000 events, 100 KB detail, old-page search, pair links, redaction and export without execution',async t=>{
 const f=await fixture(t),trace=new Trajectory(f.db),now=Date.now(),large='完整结果'.repeat(22000)+'_OLD_PAGE_NEEDLE';
 f.db.prepare('INSERT INTO harness_sessions(id,header) VALUES(?,?)').run(f.run,JSON.stringify({id:f.run,version:2,createdAt:now}));
 const insert=f.db.prepare('INSERT INTO harness_events VALUES(?,?,?,?)');
 f.db.transaction(()=>{for(let i=0;i<1000;i++){const e={seq:i,time:now+i,type:i%2?'tool/result':'tool/call',data:i%2?{turn:1,step:Math.floor(i/2)+1,message:{role:'user',source:{kind:'tool',callId:`call-${i-1}`},content:[{type:'text',text:JSON.stringify({status:i===3?'failed':'ok',content:i===901?large:`result ${i}`,cookie:'cookie-value-hidden'})}]}}:{turn:1,step:i/2+1,callId:`call-${i}`,name:'read_travel_source',arguments:{url:'https://www.uffizi.it/?access_token=example-secret',Authorization:'Bearer secret-example',query:`query ${i}`}}};const body=JSON.stringify(e);insert.run(f.run,i,body,digest(body));}})();
 const page=trace.page(f.run,{filter:'all'});assert.equal(page.counts.harness,1000);assert.equal(page.items.length,40);assert.ok(page.nextOffset);assert.equal(page.gaps.length,0);
 const search=trace.page(f.run,{q:'_OLD_PAGE_NEEDLE',filter:'all'});assert.equal(search.matching,1);assert.equal(search.items[0].id,'h:901');
 const detail=trace.detail(f.run,'h:901');assert.ok(JSON.stringify(detail).includes(large));assert.equal(detail.related[0].id,'h:900');assert.ok(detail.item.detailBytes>100000);
 const before=f.agent.view(f.run,f.owner.id).usage,exported=trace.export(f.run) as any;assert.equal(exported.records.length,page.total);const text=JSON.stringify(exported);for(const secret of ['example-secret','cookie-value-hidden','secret-key-example','Bearer secret-example'])assert.ok(!text.includes(secret),secret);assert.ok(text.includes('[已隐藏]'));assert.ok(text.includes(large));assert.deepEqual(f.agent.view(f.run,f.owner.id).usage,before);
 const values=[];for(let i=0;i<20;i++){const start=performance.now();trace.page(f.run,{q:i%2?'_OLD_PAGE_NEEDLE':'',filter:i%3?'all':'errors'});values.push(performance.now()-start);}assert.ok(Math.max(...values)<300,JSON.stringify(values));
 const apiDetail=await f.app.inject({url:`/api/agent/runs/${f.run}/trajectory/h%3A901`,headers:f.headers()});assert.equal(apiDetail.statusCode,200);assert.ok(!apiDetail.body.includes('cookie-value-hidden'));
 assert.ok(trace.page(f.run,{filter:'errors'}).items.some(e=>e.id==='h:3'));const request=(trace.export(f.run) as any).records.find((r:any)=>r.item.type==='model.request').raw.data;assert.equal(request.config.maxTokens,4096);assert.ok(request.messages[0].content.includes('图片与轨迹受控测试'));
 f.db.prepare('DELETE FROM harness_events WHERE session_id=? AND seq=20').run(f.run);let e={seq:1001,time:now+1001,type:'future/event',data:{message:'保留未知字段'}};let body=JSON.stringify(e);insert.run(f.run,1001,body,digest(body));assert.ok(trace.page(f.run).gaps.some(g=>g.includes('20')));assert.ok(trace.page(f.run).gaps.some(g=>g.includes('未识别')));
});

test('TR08: nested secrets and serialized request text are removed while ordinary information remains',()=>{
 const result=JSON.stringify(redact({headers:{Authorization:'Bearer abc',Cookie:'session=abc;secret=yes'},text:'api_key="hidden" https://name:pass@example.com/a?token=hidden&day=2',tool:JSON.stringify({password:'hidden',label:'可读'})}));assert.ok(!result.includes('hidden'));assert.ok(!result.includes('name:pass'));assert.ok(result.includes('day=2'));assert.ok(result.includes('可读'));
});

test('RM03/TR06: media-only rejection, scope validation, candidate binding and merge retain preparations and progress', async t => {
 const f=await fixture(t),store=new MediaStore(f.db,async()=>picture(900,600));await store.gather(f.query([{url:'https://www.uffizi.it/merge-image.jpg'}]),f.run,f.owner.id);const media=store.run(f.run)[0];
 const source=f.command('create',{kind:'standalone',node:nodeFields.parse({title:'独立活动'})}).workspaceId,target=f.command('create',{kind:'trip',node:nodeFields.parse({title:'共同旅行'})}).workspaceId,root=f.plans.get(source).data.rootId,step=randomUUID();
 f.command('prep',{preparation:{title:'共用准备',nodeIds:[root],steps:[{id:step,text:'确认个人安排'}]}},source);f.command('progress',{stepId:step,done:true},source);
 const base=f.plans.get(source),prepared=f.agent.proposals.prepare(f.owner.id,{workspaceId:source,nodeId:root},{answer:'添加配图',proposal:{title:'配图提议',operations:[{kind:'set_media',nodeId:root,mediaIds:[media.id]}]}},base);
 const proposal=f.agent.proposals.insert(f.run,prepared.proposal!);f.agent.proposals.reject(proposal,f.owner.id);const view=f.agent.proposals.view(proposal,f.owner.id);assert.throws(()=>f.agent.proposals.apply(proposal,f.owner.id,{requestId:randomUUID(),revision:view.revision,digest:view.digest,baseVersion:view.baseVersion}),/放弃|过期/);assert.deepEqual(f.plans.get(source),base);
 assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:source,nodeId:root},{answer:'越界',proposal:{title:'越界',operations:[{kind:'set_media',nodeId:f.plans.get(target).data.rootId,mediaIds:[media.id]}]}},base),/范围/);
 assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:null,nodeId:null},{answer:'比较',candidates:[{id:'a',title:'甲',description:'甲',tradeoffs:'甲'},{id:'b',title:'乙',description:'乙',tradeoffs:'乙'}],media:[{mediaId:media.id,candidateId:'missing'}]},null),/候选/);
 f.command('media',{nodeId:root,mediaIds:[media.id]},source);const before=f.plans.get(source),targetBefore=f.plans.get(target);const merged=f.command('merge',{targetId:target,targetVersion:targetBefore.version,parentId:targetBefore.data.rootId},source);
 assert.deepEqual(f.plans.get(target).data.media?.[root],[media.id]);assert.equal(f.plans.get(target).data.progress[f.owner.id][step],true);f.command('undo',{changeId:merged.changeId});assert.deepEqual(f.plans.get(source).data,before.data);assert.deepEqual(f.plans.get(target).data,targetBefore.data);
 const version=f.plans.get(source).version;f.command('edit',{nodeId:root,node:nodeFields.parse({title:'更新后的活动'})},source);assert.throws(()=>f.plans.execute(f.owner.id,{kind:'media',requestId:randomUUID(),workspaceId:source,version,payload:{nodeId:root,mediaIds:[]}}),/更新/);assert.deepEqual(f.plans.get(source).data.media?.[root],[media.id]);
});

test('RM04/RM07: saved screenshots keep their aspect and Markdown never renders scripts, raw HTML or external images',async t=>{
 const f=await fixture(t),queryId=f.query([]),stored=f.browser.store.get(f.owner.id,queryId).result!,original=await picture(640,1000),artifact={id:randomUUID(),mimeType:'image/png',sha256:digest(original),byteLength:original.length,interpretation:'not_performed' as const};stored.artifact=artifact;
 f.db.prepare('UPDATE browser_queries SET result=? WHERE id=?').run(JSON.stringify(stored),queryId);f.db.prepare('INSERT INTO browser_artifacts VALUES(?,?,?,?,?,?,?)').run(artifact.id,queryId,f.owner.id,artifact.mimeType,artifact.sha256,original,stored.retrievedAt);
 const media=new MediaStore(f.db,async()=>{throw new Error('screenshot must not fetch');});await media.gather(queryId,f.run,f.owner.id);const shot=media.run(f.run)[0];assert.equal(shot.kind,'screenshot');assert.equal(shot.width,640);assert.equal(shot.height,1000);assert.equal(shot.interpretation,'not_performed');
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{RichContent}=await import('../src/service/client/RichContent.js');
 const html=renderToStaticMarkup(createElement(RichContent,{text:'# 标题\n\n- 清单\n\n|列|值|\n|---|---|\n|甲|乙|\n\n<script>alert(1)</script>\n\n[恶意](javascript:alert) ![跟踪](https://tracking.example/pixel.png) <iframe src="https://evil.example" />'}));assert.ok(html.includes('<h1>标题</h1>'));assert.ok(html.includes('<table>'));assert.ok(html.includes('<li>清单</li>'));assert.ok(!/<script|<iframe|javascript:|<img/.test(html));
 assert.ok(!JSON.stringify(redact({'X-Api-Key':'hidden','ZHIPU_CODING_API_KEY':'hidden',raw:'Cookie: session=hidden; extra=hidden\n可读'})).includes('hidden'));
});


test('RM06: repeated acquisition failure stays explicit, records the attempt and deduplicates a later successful retry',async t=>{
 let attempts=0;const bytes=await picture(900,600);const f=await fixture(t,async url=>{if(url.includes('retry') && ++attempts < 3)throw new Error('原图已失效（404）');return bytes;});
 const q=f.query([{url:'https://www.uffizi.it/primary.jpg',alt:'展厅'},{url:'https://www.uffizi.it/retry.jpg',alt:'展厅另一引用'}]);await f.agent.media.gather(q,f.run,f.owner.id);const original=f.agent.media.run(f.run).find(m=>m.status==='ready')!,failed=f.agent.media.run(f.run).find(m=>m.status==='failed')!,usage=f.agent.view(f.run,f.owner.id).usage;
 const beforeRetry=f.agent.view(f.run,f.owner.id).trajectoryRevision;
 assert.equal(f.agent.view(f.run,f.owner.id).trajectoryRevision,beforeRetry,'reading unchanged history must keep its revision');
 const request={method:'POST' as const,url:`/api/media/${failed.id}/retry`,headers:f.headers(),payload:{}};const again=await f.app.inject(request);assert.equal(again.statusCode,200);assert.equal(again.json().status,'failed');assert.match(again.json().message,/404/);assert.ok(f.agent.events(f.run,f.owner.id).some(e=>e.type==='media.retry' && (e.data as any).status==='failed'));
 assert.notEqual(f.agent.view(f.run,f.owner.id).trajectoryRevision,beforeRetry,'completed trajectory must refresh even when retry ends with the same failure message');
 const recovered=await f.app.inject(request);assert.equal(recovered.statusCode,200);assert.equal(recovered.json().duplicateOf,original.id);assert.equal(f.agent.media.run(f.run).filter(m=>m.status==='ready').length,1);assert.deepEqual(f.agent.view(f.run,f.owner.id).usage,usage);
});

test('notebook media: independent publication survives plan detachment and respects deletion, undo and access revocation', async t => {
  const f = await fixture(t, async () => picture(900, 600));
  await f.agent.media.gather(f.query([{url:'https://www.uffizi.it/note-photo.jpg',alt:'笔记图片'}]),f.run,f.owner.id);
  const image = f.agent.media.run(f.run)[0];
  const wid = f.command('create',{kind:'trip',node:nodeFields.parse({title:'笔记图片验收'})}).workspaceId;
  const root = f.plans.get(wid).data.rootId;
  f.db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'reader')").run(wid,f.peer.id);
  assert.throws(() => f.agent.media.allowed(image.id, f.peer.id, wid), /尚未公开/);
  f.command('note',{note:{title:'独立图文',body:`![图片](media:${image.id})`,nodeIds:[],mediaIds:[image.id],preparationIds:[]}},wid);
  const note = Object.values(f.plans.get(wid).data.notebook!)[0];
  assert.ok(f.agent.media.allowed(image.id, f.peer.id, wid).bytes);
  f.command('media',{nodeId:root,mediaIds:[image.id]},wid);
  f.command('media',{nodeId:root,mediaIds:[]},wid);
  assert.ok(f.agent.media.allowed(image.id, f.peer.id, wid).bytes, 'note keeps its own image reference');
  const deleted = f.command('deleteNote',{noteId:note.id},wid);
  assert.throws(() => f.agent.media.allowed(image.id, f.peer.id, wid), /尚未公开/);
  f.command('undo',{changeId:deleted.changeId});
  assert.ok(f.agent.media.allowed(image.id, f.peer.id, wid).bytes);
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(wid,f.peer.id);
  assert.throws(() => f.agent.media.allowed(image.id, f.peer.id, wid), /访问权限/);
  const another = f.command('create',{kind:'trip',node:nodeFields.parse({title:'其他旅行'})},undefined,f.stranger).workspaceId;
  assert.throws(() => f.command('note',{note:{title:'不能挪用',body:'',nodeIds:[],mediaIds:[image.id],preparationIds:[]}},another,f.stranger), /无权公开/);
});

test('notebook v6 backup restores independent images, checklist references and migration history', async t => {
  const f = await fixture(t, async () => picture(900,600));
  await f.agent.media.gather(f.query([{url:'https://www.uffizi.it/note-backup.jpg',alt:'备份笔记图'}]),f.run,f.owner.id);
  const image=f.agent.media.run(f.run)[0],wid=f.command('sample',{}).workspaceId;
  const root=f.plans.get(wid).data.rootId,prep=Object.values(f.plans.get(wid).data.preparations)[0];
  f.command('progress',{stepId:prep.steps[0].id,done:true},wid);
  f.command('note',{note:{title:'独立图片笔记',body:`原文\\n\n![图](media:${image.id})`,nodeIds:[],mediaIds:[image.id],preparationIds:[prep.id]}},wid);
  const migration=f.command('migrateNotes',{},wid),saved=f.plans.get(wid);
  const dir=mkdtempSync(join(tmpdir(),'notebook-v6-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const backup=join(dir,'backup.db');await f.db.backup(backup);inspectBackup(backup);
  await restoreDatabase(backup,join(dir,'restored'));
  const restored=await createApp({database:join(dir,'restored','travel.db')});t.after(()=>restored.app.close());
  assert.equal(restored.db.pragma('user_version',{simple:true}),8);
  assert.deepEqual(restored.plans.get(wid),saved);
  assert.ok(restored.agent.media.allowed(image.id,f.owner.id,wid).bytes);
  restored.plans.execute(f.owner.id,{kind:'undo',payload:{changeId:migration.changeId},requestId:randomUUID()});
  assert.equal(Object.keys(restored.plans.get(wid).data.notebook!).length,1);
  assert.equal(restored.plans.get(wid).data.progress[f.owner.id][prep.steps[0].id],true);
  assert.equal(restored.plans.get(wid).data.nodes[root].description,saved.data.nodes[root].description);
});

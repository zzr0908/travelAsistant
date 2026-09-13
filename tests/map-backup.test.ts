import { executionTables } from '../src/storage/execution.js';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createApp} from '../src/service/server/app.js';
import {nodeFields} from '../src/shared/model.js';
import {spatialSummary,spatialEvidenceText} from '../src/shared/maps.js';
import {mapCanonical,MapStore} from '../src/maps/store.js';
import {digest} from '../src/agent/browser/store.js';
import {browserRequest,type BrowserResult,type PageData} from '../src/agent/browser/model.js';
import {inspectBackup,restoreDatabase} from '../src/storage/maintenance.js';
import {inspectMapBackup,mapTables} from '../src/storage/map-backup.js';
import {agentTables} from '../src/storage/agent-backup.js';
import {mediaTables} from '../src/storage/media-backup.js';
import {openDatabase} from '../src/storage/database.js';

const bind=(assetId:string,primary=false)=>({assetId,primary,optional:false,nodeIds:[],mediaIds:[]});
async function fixture(t:TestContext) {
  let output:unknown={answer:'受控备份测试。'},requests=0;
  const f=await createApp({maps:{apiKey:'controlled-map-key',fetch:async input=>{
    requests++;const u=new URL(input),name=u.searchParams.get('text')||u.searchParams.get('name')||'controlled';
    return new Response(JSON.stringify({features:[{properties:{name,place_id:name,country_code:'it',category:'entertainment.museum'},geometry:{type:'Point',coordinates:[11.25,43.77]}}]}),{headers:{'content-type':'application/json'}});
  }},agent:{mediaDownload:async url=>sharp({create:{width:900,height:600,channels:3,background:url.includes('unrelated')?'#cc7755':'#557799'}}).png().toBuffer(),driver:{kind:'test',close:async()=>{},run:async i=>{i.beforeModel(10);await i.tools.find(t=>t.name==='publish_result')!.execute(output,i.signal);}}}});
  t.after(()=>f.app.close());
  const owner=f.auth.create({username:'owner',name:'A',password:'testing-password'},true),peer=f.auth.create({username:'peer',name:'B',password:'testing-password'}),stranger=f.auth.create({username:'stranger',name:'C',password:'testing-password'});
  const command=(kind:string,payload:object,workspaceId?:string,user=owner.id)=>f.plans.execute(user,{kind,payload,requestId:randomUUID(),...(workspaceId?{workspaceId,version:f.plans.get(workspaceId).version}:{})});
  const run=async(next:unknown,input:object={},user=owner.id)=>{output=next;const r=f.agent.submit(user,{requestId:randomUUID(),prompt:'受控备份验证',...input});await f.agent.wait(r.id);const view=f.agent.view(r.id,user);assert.equal(view.state,'completed',view.message);return view;};
  const place=async(name:string,user=owner.id)=>(await f.maps.query(user,{action:'search',text:name,requestId:randomUUID()})).assets[0];
  const image=async(runId:string,name='controlled-image',user=owner.id)=>{
    const input=browserRequest.parse({action:'read',requestId:randomUUID(),url:'https://www.uffizi.it/en/the-uffizi'}),q=f.browser.store.begin(user,input),text='Controlled historical photo fixture.';
    const page:PageData={pageId:randomUUID(),snapshotId:randomUUID(),sourceId:'official',sourceType:'official',url:'https://www.uffizi.it/en/the-uffizi',title:name,language:'en',contentKind:'page',text,textHash:digest(text),totalTextChars:text.length,truncated:false,textRange:{start:0,end:text.length,nextOffset:null},publishedAt:null,modifiedAt:null,experiencedAt:null,author:null,canonicalUrl:null,license:null,links:[],comments:[],media:[{kind:'image',url:`https://www.uffizi.it/${name}.jpg`,alt:name,caption:'',status:'reference_only'}],controls:[],counts:{commentsDetected:0,commentsSaved:0,commentsTotal:null,imagesDetected:1,mediaSaved:1,linksDetected:0,linksSaved:0,controlsDetected:0},viewport:{scrollY:0,height:800,documentHeight:800},evidenceId:randomUUID(),verification:'unverified'};
    const result:BrowserResult={schemaVersion:1,queryId:q.id,capability:'browser.read',providerId:'chrome-devtools-mcp',status:'ok',data:page,evidenceIds:[],artifact:null,context:input.context,missing:[],limitations:[],retrievedAt:new Date().toISOString(),durationMs:1,usage:{toolCalls:1,browserRequests:null,cost:null},message:'Constructed fixture'};
    f.browser.store.finish(user,result);f.db.prepare('INSERT INTO agent_browser_queries VALUES(?,?,?)').run(q.id,runId,user);await f.agent.media.gather(q.id,runId,user);return f.agent.media.run(runId).find(m=>m.alt===name)!;
  };
  return {...f,owner,peer,stranger,command,run,place,image,requests:()=>requests};
}

test('MA13: query, workspace, change, proposal and context references require historical publication, even after revocation',async t=>{
  const f=await fixture(t),wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'历史权限场景'})}).workspaceId,root=f.plans.get(wid).data.rootId;
  const shared=await f.place('shared'),hidden=await f.place('owner-private'),foreign=await f.place('outsider-private',f.stranger.id);
  f.db.prepare("INSERT INTO members VALUES(?,?,'editor')").run(wid,f.peer.id);
  f.command('spatial',{nodeId:root,bindings:[bind(shared.id,true)]},wid);
  const sharedVersion=f.plans.get(wid).version;
  const query=await f.maps.query(f.peer.id,{action:'details',placeId:shared.id,workspaceId:wid,requestId:randomUUID()});
  const r=await f.run({answer:'引用当时已经发布的地点。',spatial:[{assetId:shared.id}],proposal:{title:'保存引用',operations:[{kind:'update_node',nodeId:root,changes:{description:'添加一条说明，保留原地图'}},{kind:'set_spatial',nodeId:root,bindings:[bind(shared.id,true)]}]}},{workspaceId:wid,nodeId:root},f.peer.id);
  f.command('spatial',{nodeId:root,bindings:[]},wid);
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(wid,f.peer.id);
  inspectMapBackup(f.db);
  const directory=mkdtempSync(join(tmpdir(),'map-publication-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const good=join(directory,'good.db'),target=join(directory,'restored');await f.db.backup(good);await restoreDatabase(good,target);
  const original=new Database(join(target,'travel.db'),{readonly:true}),originalData=original.prepare('SELECT data FROM workspaces WHERE id=?').get(wid);original.close();
  const bad=(mutate:()=>void,pattern:RegExp)=>{
    f.db.exec('SAVEPOINT corrupt');try{mutate();assert.throws(()=>inspectMapBackup(f.db),pattern);}finally{f.db.exec('ROLLBACK TO corrupt; RELEASE corrupt');}
  };
  bad(()=>{
    const row=f.db.prepare('SELECT input FROM map_queries WHERE id=?').get(query.queryId) as {input:string},input=JSON.parse(row.input);input.placeId=hidden.id;
    f.db.prepare('UPDATE map_queries SET input=?,request_hash=? WHERE id=?').run(mapCanonical(input),digest(mapCanonical(input)),query.queryId);
  },/当时未发布/);
  bad(()=>{
    const data=f.plans.get(wid).data;data.spatial={[root]:[bind(foreign.id)]};f.db.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify(data),wid);
  },/私人/);
  bad(()=>{
    const row=f.db.prepare('SELECT id,before_data FROM changes WHERE json_extract(before_data,?)=?').get(`$."${wid}".version`,sharedVersion) as {id:string;before_data:string};
    const before=JSON.parse(row.before_data);before[wid].data.spatial[root].push(bind(foreign.id));f.db.prepare('UPDATE changes SET before_data=? WHERE id=?').run(JSON.stringify(before),row.id);
  },/私人|历史快照/);
  bad(()=>{
    const context=JSON.parse(f.agent.row(r.id).context);context.base.data.spatial[root].push(bind(hidden.id));f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(context),r.id);
  },/历史版本/);
  bad(()=>{
    const row=f.db.prepare('SELECT body FROM agent_proposals WHERE id=?').get(r.proposal!.id) as {body:string},body=JSON.parse(row.body);body.workspace.data.spatial[root].push(bind(hidden.id));const text=mapCanonical(body);f.db.prepare('UPDATE agent_proposals SET body=?,digest=? WHERE id=?').run(text,digest(text),r.proposal!.id);
  },/提议引用/);
  bad(()=>{
    const context=JSON.parse(f.agent.row(r.id).context);context.previousRuns=[{spatialAssets:[spatialSummary(foreign)]}];f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(context),r.id);
  },/研究上下文地图引用/);
  bad(()=>{
    const context=JSON.parse(f.agent.row(r.id).context);context.projection.spatial[root].push(bind(hidden.id));f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(context),r.id);
  },/研究投影中的空间关联/);
  bad(()=>{
    const result={queryId:hidden.source.queryId,status:'failed',assets:[],message:'controlled failure',cached:false,estimatedCredits:0};f.db.prepare('UPDATE map_queries SET result=? WHERE id=?').run(JSON.stringify(result),hidden.source.queryId);
  },/空间资产缺少来源查询/);
  bad(()=>{
    const saved=JSON.parse(f.agent.row(r.id).output!);const evidence={assetId:hidden.id,queryId:hidden.source.queryId,field:'name' as const,value:hidden.name};saved.claims=[{id:'hidden',status:'source_supported',nodeIds:[],text:spatialEvidenceText(hidden,evidence),spatialEvidence:evidence}];f.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(JSON.stringify(saved),r.id);
  },/回答地图来源/);
  const savedContext=f.agent.row(r.id).context,changed=JSON.parse(savedContext);changed.base.data.spatial[root].push(bind(hidden.id));f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(JSON.stringify(changed),r.id);
  const corrupt=join(directory,'bad.db');await f.db.backup(corrupt);await assert.rejects(restoreDatabase(corrupt,target),/历史版本/);f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(savedContext,r.id);
  const restored=openDatabase(join(target,'travel.db'));assert.deepEqual(restored.prepare('SELECT data FROM workspaces WHERE id=?').get(wid),originalData);assert.throws(()=>new MapStore(restored).allowed(shared.id,f.peer.id,wid),/权限/);restored.close();
  inspectMapBackup(f.db);
});

test('MA13: retained map and image summaries must come from the stopped predecessor, including runs without output',async t=>{
  const f=await fixture(t),first=await f.run({answer:'受控未完成前身'}),asset=await f.place('retained'),unrelated=await f.place('unrelated');
  f.db.prepare('INSERT INTO agent_map_queries VALUES(?,?)').run(first.id,asset.source.queryId);
  const image=await f.image(first.id),otherRun=await f.run({answer:'无关采集'}),otherImage=await f.image(otherRun.id,'unrelated-image');
  f.db.prepare("UPDATE agent_runs SET output=NULL,state='failed' WHERE id=?").run(first.id);
  const next=await f.run({answer:'复用中断资料'},{sessionId:first.sessionId});
  const original=f.agent.row(next.id).context;inspectMapBackup(f.db);
  const check=(edit:(retained:any)=>void,pattern:RegExp)=>{const context=JSON.parse(original);edit(context.previousRuns.at(-1).retainedResearch);f.db.prepare('UPDATE agent_runs SET context=?,output=NULL WHERE id=?').run(JSON.stringify(context),next.id);assert.throws(()=>inspectMapBackup(f.db),pattern);f.db.prepare('UPDATE agent_runs SET context=? WHERE id=?').run(original,next.id);};
  check(x=>x.spatialAssets[0]=spatialSummary(unrelated),/不属于上一轮/);
  check(x=>x.spatialAssets[0].name='forged-name',/地图摘要/);
  check(x=>x.media[0]=otherImage,/不属于上一轮/);
  check(x=>x.media[0].sha256='0'.repeat(64),/配图摘要/);
  assert.equal(JSON.parse(original).previousRuns.at(-1).retainedResearch.media[0].id,image.id);inspectMapBackup(f.db);
});

test('MA11/13: selecting an old candidate omits a detached shared photo while preserving valid historical backup',async t=>{
  const f=await fixture(t),source=await f.run({answer:'受控图片采集'}),image=await f.image(source.id);
  const wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'共享图文'})}).workspaceId,root=f.plans.get(wid).data.rootId;
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);f.command('media',{nodeId:root,mediaIds:[image.id]},wid);
  const parent=await f.run({answer:'两候选',candidates:[{id:'art',title:'艺术',description:'图文介绍',tradeoffs:'馆内为主'},{id:'walk',title:'散步',description:'街区',tradeoffs:'户外为主'}],media:[{candidateId:'art',mediaId:image.id}]},{workspaceId:wid,nodeId:root},f.peer.id);
  f.command('media',{nodeId:root,mediaIds:[]},wid);
  const next=await f.run({answer:'配图已撤销，保留文字方向。'},{sessionId:parent.sessionId,parentRunId:parent.id,selectedCandidateId:'art',workspaceId:wid,nodeId:root},f.peer.id);
  const context=JSON.parse(f.agent.row(next.id).context);assert.deepEqual(context.selectedCandidate.media,[]);assert.deepEqual(context.previousRuns.at(-1).media,[]);
  assert.throws(()=>f.agent.media.allowed(image.id,f.peer.id,wid),/尚未公开/);inspectMapBackup(f.db);
});

for(const version of [1,2,3,4,5])test(`MA13: nonempty v${version} backup migrates to v8 without rewriting saved rows or old proposal digests`,async t=>{
  const f=await fixture(t),wid=f.command('sample',{}).workspaceId,root=f.plans.get(wid).data.rootId;
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
  f.command('add',{parentId:root,node:nodeFields.parse({title:'日期未定的旧安排',location:{name:'手动位置',address:'旧地址',lat:43.77,lng:11.25}})},wid);
  const step=Object.values(f.plans.get(wid).data.preparations)[0].steps[0];
  f.command('progress',{stepId:step.id,done:true},wid,f.peer.id);
  let proposalId:string|undefined,imageId:string|undefined;
  if(version>=2){const source=await f.run({answer:'旧版来源记录'});const picture=await f.image(source.id);if(version===4)imageId=picture.id;}
  if(version>=3){
    const r=await f.run({answer:'旧版待采用提议',proposal:{title:'旧版草案',operations:[{kind:'new_workspace',id:'draft',node:{title:'旧版独立草案'}},...(imageId?[{kind:'set_media',nodeId:'draft',mediaIds:[imageId]}]:[])]}});
    proposalId=r.proposal!.id;
  }
  const directory=mkdtempSync(join(tmpdir(),`map-legacy-v${version}-`));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'legacy.db');await f.db.backup(file);
  const legacy=new Database(file);legacy.pragma('foreign_keys=OFF');
  const omitted=[...executionTables,'card_drafts',...(version<5?mapTables:[]),...(version<4?mediaTables:[]),...(version<3?agentTables:[]),...(version<2?['browser_queries','browser_artifacts']:[])];
  for(const table of omitted.reverse())legacy.exec(`DROP TABLE ${table}`);
  // Materialize the pre-map serialization once; the migration must preserve it byte for byte.
  const strip=(value:any):any=>{if(Array.isArray(value))return value.map(strip);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['spatial','spatialAssets','selectedCandidate','retainedResearch'].includes(k)&&(version>=4||k!=='media')).map(([k,v])=>[k,strip(v)]));return value;};
  for(const [table,key,column] of [['workspaces','id','data'],['changes','id','before_data'],...(version>=3?[['agent_runs','id','context'],['agent_runs','id','output'],['agent_proposals','id','body']]:[])])for(const row of legacy.prepare(`SELECT ${key} AS id,${column} AS value FROM ${table}`).all() as {id:string;value:string|null}[])if(row.value){const value=JSON.stringify(strip(JSON.parse(row.value)));legacy.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(value,row.id);if(table==='agent_proposals')legacy.prepare('UPDATE agent_proposals SET digest=? WHERE id=?').run(digest(value),row.id);}
  legacy.pragma(`user_version=${version}`);
  const tables=(legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(r=>r.name).filter(n=>!['sessions','invites'].includes(n));
  const saved=Object.fromEntries(tables.map(table=>[table,digest(mapCanonical(legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
  const proposal=proposalId?legacy.prepare('SELECT body,digest FROM agent_proposals WHERE id=?').get(proposalId):null;legacy.close();
  inspectBackup(file);const target=join(directory,'restored');await restoreDatabase(file,target);
  const migrated=openDatabase(join(target,'travel.db'));assert.equal(migrated.pragma('user_version',{simple:true}),8);
  for(const table of tables)assert.equal(digest(mapCanonical(migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),saved[table],`v${version}: ${table} changed during migration`);
  assert.equal((migrated.prepare('SELECT count(*) AS n FROM spatial_assets').get() as {n:number}).n,0);
  if(proposalId)assert.deepEqual(migrated.prepare('SELECT body,digest FROM agent_proposals WHERE id=?').get(proposalId),proposal);
  migrated.close();inspectBackup(join(target,'travel.db'));
  const app=await createApp({database:join(target,'travel.db')});t.after(()=>app.app.close());
  assert.equal(app.plans.get(wid).data.nodes[root].title,f.plans.get(wid).data.nodes[root].title);
  if(proposalId){const p=app.agent.proposals.view(proposalId,f.owner.id);assert.equal(p.status,'ready');const result=app.agent.proposals.apply(p.id,f.owner.id,{revision:p.revision,digest:p.digest,baseVersion:p.baseVersion,requestId:randomUUID()});assert.equal(app.plans.get(result.workspaceId).data.nodes[app.plans.get(result.workspaceId).data.rootId].title,'旧版独立草案');if(imageId)assert.equal(JSON.parse(app.agent.media.allowed(imageId,f.owner.id,result.workspaceId).metadata).id,imageId);}
  assert.equal(f.requests(),0,'legacy restoration must not call a map provider');
});

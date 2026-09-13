import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/service/server/app.js';
import type { AgentDriver, DriverInput } from '../src/agent/service.js';
import { nodeFields } from '../src/shared/model.js';
import { bindingStale, type SpatialSummary } from '../src/shared/maps.js';
import { inspectAgentBackup } from '../src/storage/agent-backup.js';
import { inspectMapBackup } from '../src/storage/map-backup.js';
import { Trajectory } from '../src/agent/trajectory.js';
import { restoreDatabase } from '../src/storage/maintenance.js';
import { openDatabase } from '../src/storage/database.js';
import { MapStore } from '../src/maps/store.js';

// Constructed geometry verifies contracts and transactions, not provider quality.
const points = [[11.25,43.76], [11.255,43.761]];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type':'application/json' } });
const upstream = async (input: string) => {
  const url = new URL(input), name = url.searchParams.get('text') || url.searchParams.get('name') || 'first';
  if (url.pathname.includes('routing')) return json({ features: [{ properties: { mode:'walk', units:'metric', distance_units:'meters', distance:450, time:360 }, geometry:{type:'MultiLineString',coordinates:[[points[0],[11.253,43.76],points[1]]]}}] });
  return json({ features:[{ properties:{name,place_id:name,formatted:name+', Florence, Italy',category:'entertainment.museum',city:'Florence',country_code:'it',country:'Italy',result_type:'amenity',rank:{confidence:1}},geometry:{type:'Point',coordinates:points[name==='second'?1:0]}}] });
};
const tool = (i: DriverInput, name: string, input: unknown) => i.tools.find(t => t.name === name)!.execute(input, i.signal);
const publish = (i: DriverInput, input: unknown) => tool(i, 'publish_result', input);
const binding = (assetId: string, primary = false, nodeIds: string[] = []) => ({ assetId, primary, optional:false, nodeIds, mediaIds:[] });
async function fixture(t: TestContext, work: (i: DriverInput) => Promise<void>) {
  const driver: AgentDriver = { kind:'test', run:work, close:async()=>{} };
  const f = await createApp({ maps:{ apiKey:'fake-map-key',fetch:upstream },agent:{driver} });
  t.after(()=>f.app.close());
  const owner=f.auth.create({username:'owner',name:'A',password:'testing-password'},true);
  const command=(kind:string,payload:object,workspaceId?:string,user=owner.id)=>f.plans.execute(user,{kind,payload,requestId:randomUUID(),...(workspaceId?{workspaceId,version:f.plans.get(workspaceId).version}:{})});
  const complete=async(input:object={},user=owner.id)=>{ const r=f.agent.submit(user,{requestId:randomUUID(),prompt:'受控地图测试',...input});await f.agent.wait(r.id);return f.agent.view(r.id,user); };
  return {...f,owner,command,complete};
}

test('MA14/19: continuing an unfinished run reuses retained map evidence without repeating lookup or publishing partial work',async t=>{
  let pass=0,asset!:SpatialSummary;
  const f=await fixture(t,async i=>{
    if (!pass++) {
      i.beforeModel(20);
      asset=((await tool(i,'read_map_data',{action:'search',text:'retained-museum',context:'Florence, Italy'})) as {assets:SpatialSummary[]}).assets[0];
      i.beforeModel(200000);
      assert.fail('the configured budget must stop this run');
    }
    i.beforeModel(20);
    assert.match(i.prompt,/retainedResearch/);assert.ok(i.prompt.includes(asset.id));
    await publish(i,{answer:'复用上一轮已保存的地点；未重复研究。',spatial:[{assetId:asset.id}]});
  });
  const first=await f.complete();assert.equal(first.state,'failed');assert.equal(first.output,null);assert.equal(first.usage.mapQueries,1);
  const before=f.maps.status().requests;
  const next=await f.complete({sessionId:first.sessionId,prompt:'继续，用已保存资料完成回答'});
  assert.equal(next.state,'completed',next.message);assert.equal(next.usage.mapQueries,0);assert.equal(f.maps.status().requests,before);
  assert.equal(next.output!.spatial[0].assetId,asset.id);assert.equal(f.plans.list(f.owner.id).length,0);
  const context=JSON.parse((f.db.prepare('SELECT context FROM agent_runs WHERE id=?').get(next.id) as {context:string}).context);
  assert.equal(context.previousRuns.at(-1).retainedResearch.spatialAssets[0].id,asset.id);
  assert.ok(!('geometry' in context.previousRuns.at(-1).retainedResearch.spatialAssets[0]));
});

test('MA06/10/19: map-backed candidates inherit verified assets, preview atomically, adopt once and undo without research',async t=>{
  let pass=0; let a!:SpatialSummary,b!:SpatialSummary,privateArea!:SpatialSummary;
  const f=await fixture(t,async i=>{
    i.beforeModel(20);
    const lookup=async(input:object)=>await tool(i,'read_map_data',input) as {queryId:string;assets:SpatialSummary[]};
    if (!pass++) {
      a=(await lookup({action:'search',text:'first',context:'Florence, Italy'})).assets[0];
      b=(await lookup({action:'search',text:'second',context:'Florence, Italy'})).assets[0];
      const line=(await lookup({action:'schematic',placeIds:[a.id,b.id]})).assets[0];
      privateArea=(await lookup({action:'suggested_area',placeIds:[a.id,b.id]})).assets[0];
      assert.equal('geometry' in a,false,'model receives summaries rather than editable geometry');
      await publish(i,{answer:'两个尚未采用的候选。',question:{text:'你选择哪个方向？',required:true},candidates:[{id:'walk',title:'依次看两处',description:'沿两处地点浏览。',tradeoffs:'地点明确。'},{id:'area',title:'在范围内探索',description:'保留更多自由安排。',tradeoffs:'只表示建议范围。'}],spatial:[{assetId:a.id,candidateId:'walk'},{assetId:b.id,candidateId:'walk'},{assetId:line.id,candidateId:'walk'},{assetId:privateArea.id,candidateId:'area'}]});
    } else {
      assert.ok(i.prompt.includes('本次明确选中的候选'));
      assert.ok(i.prompt.includes(a.id) && i.prompt.includes(b.id));
      const route=await lookup({action:'route',placeIds:[a.id,b.id]});
      await publish(i,{answer:'采用前核对地图与文字。',proposal:{title:'两处散步计划',operations:[
        {kind:'new_workspace',id:'root',node:{title:'散步'}},
        {kind:'add_node',id:'a',parentId:'root',node:{title:'第一处'}},
        {kind:'add_node',id:'b',parentId:'root',node:{title:'第二处'}},
        {kind:'set_spatial',nodeId:'a',bindings:[binding(a.id,true)]},
        {kind:'set_spatial',nodeId:'b',bindings:[binding(b.id,true)]},
        {kind:'set_spatial',nodeId:'root',bindings:[binding(route.assets[0].id,false,['a','b'])]},
      ]},spatial:[{assetId:route.assets[0].id,nodeId:'root'}],claims:[{id:'length',text:'This malicious unsupported text says it is open all night.',status:'source_supported',nodeIds:['root'],spatialEvidence:{assetId:route.assets[0].id,queryId:route.queryId,field:'distanceMeters',value:450}}]});
    }
  });
  const first=await f.complete(); assert.equal(first.state,'needs_input');assert.equal(first.usage.mapQueries,4);assert.equal(f.plans.list(f.owner.id).length,0);
  assert.equal('geometry' in first.spatial![0],false,'history payload stays small');
  assert.ok(f.agent.spatial(first.id,f.owner.id)[0].geometry);
  const answer={requestId:randomUUID(),answer:'选择散步并细化',selectedCandidateId:'walk'};
  const started=f.agent.answer(first.id,f.owner.id,answer);await f.agent.wait(started.id);
  const next=f.agent.view(started.id,f.owner.id);
  assert.equal(f.agent.answer(first.id,f.owner.id,answer).id,next.id,'repeated candidate selection must not start another run');
  assert.throws(()=>f.agent.answer(first.id,f.owner.id,{...answer,selectedCandidateId:'area'}),/已经答复/);
  assert.equal(next.state,'completed',next.message);assert.equal(next.usage.mapQueries,1);assert.equal(f.plans.list(f.owner.id).length,0);
  assert.ok(next.output!.claims[0].text.includes('450'));assert.ok(!next.output!.claims[0].text.includes('open all night'));
  const p=next.proposal!,input={revision:p.revision,digest:p.digest,baseVersion:p.baseVersion,requestId:randomUUID()};
  assert.equal(p.spatialBefore!.length,0);assert.equal(p.spatialAfter!.length,3);assert.equal(p.diffs.filter(d=>d.kind==='修改地图').length,3);
  const used=f.maps.status().requests, result=f.agent.proposals.apply(p.id,f.owner.id,input);
  assert.deepEqual(f.agent.proposals.apply(p.id,f.owner.id,input),result);
  const w=f.plans.get(result.workspaceId);assert.equal(w.version,1);assert.equal(w.data.nodes[p.spatialAfter!.find(r=>r.assetId===a.id)!.nodeId!].location.lng,points[0][0]);
  const peer=f.auth.create({username:'peer',name:'B',password:'testing-password'});f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(w.id,peer.id);
  assert.equal(f.maps.store.allowed(a.id,peer.id,w.id).id,a.id);assert.throws(()=>f.maps.store.allowed(privateArea.id,peer.id,w.id),/私人/);
  assert.throws(()=>f.agent.spatial(first.id,peer.id),/权限/);
  f.command('undo',{changeId:result.changeId});assert.equal(f.plans.list(f.owner.id).length,0);assert.equal(f.maps.status().requests,used);
  inspectAgentBackup(f.db);inspectMapBackup(f.db);
  const trace=new Trajectory(f.db),exported=trace.export(next.id) as any;
  assert.equal(exported.mapQueries.length,1);assert.equal(trace.page(next.id).counts.mapQueries,1);
  assert.ok(exported.records.some((r:any)=>r.item.type==='map.finished'));assert.ok(!JSON.stringify(exported).includes('fake-map-key'));
});

test('MA10: late apply interruption rolls back spatial publication; retry, undo and 409 preserve progress',async t=>{
  let target='',asset='';
  const f=await fixture(t,async i=>{i.beforeModel(10);await publish(i,{answer:'地图与说明一起预览。',proposal:{title:'绑定空间并补充说明',operations:[{kind:'update_node',nodeId:target,changes:{description:'经过预览的说明'}},{kind:'set_spatial',nodeId:target,bindings:[binding(asset,true)]}]}});});
  const wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'原计划'})}).workspaceId;target=f.plans.get(wid).data.rootId;
  f.command('add',{parentId:target,node:nodeFields.parse({title:'保持固定',fixed:true})},wid);
  const stepId=randomUUID();f.command('prep',{preparation:{title:'准备',note:'',nodeIds:[target],steps:[{id:stepId,text:'已完成的准备'}]}},wid);f.command('progress',{stepId,done:true},wid);
  asset=(await f.maps.query(f.owner.id,{action:'search',text:'first',workspaceId:wid,requestId:randomUUID()})).assets[0].id;
  const run=await f.complete({workspaceId:wid,nodeId:target});assert.equal(run.state,'completed',run.message);
  const proposal=run.proposal!,input={requestId:randomUUID(),revision:proposal.revision,digest:proposal.digest,baseVersion:proposal.baseVersion};
  const before=f.plans.get(wid),requests=f.maps.status().requests;
  const tables=['workspaces','members','changes','agent_proposals','agent_published_claims','agent_events','agent_apply_requests','spatial_assets','map_queries'];
  const snapshot=()=>Object.fromEntries(tables.map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const beforeTables=snapshot();
  // Fail at the final receipt write, after workspace, history and publication writes.
  f.db.exec("CREATE TEMP TRIGGER qa_abort_apply BEFORE INSERT ON agent_apply_requests BEGIN SELECT RAISE(ABORT,'injected final receipt interruption'); END");
  assert.throws(()=>f.agent.proposals.apply(proposal.id,f.owner.id,input),/injected final receipt interruption/);
  assert.deepEqual(snapshot(),beforeTables,'all partial writes must roll back, including proposal status/events');
  f.db.exec('DROP TRIGGER qa_abort_apply');
  const adopted=f.agent.proposals.apply(proposal.id,f.owner.id,input);
  assert.deepEqual(f.agent.proposals.apply(proposal.id,f.owner.id,input),adopted);
  assert.deepEqual(f.agent.proposals.apply(proposal.id,f.owner.id,{...input,requestId:randomUUID()}),adopted);
  const current=f.plans.get(wid);assert.equal(current.version,before.version+1);assert.equal(current.data.nodes[target].location.lng,points[0][0]);
  assert.deepEqual(current.data.progress,before.data.progress);assert.deepEqual(Object.values(current.data.nodes).filter(n=>n.fixed),Object.values(before.data.nodes).filter(n=>n.fixed));
  assert.equal((f.db.prepare('SELECT count(*) n FROM changes').get() as {n:number}).n,(beforeTables.changes as unknown[]).length+1);
  f.command('undo',{changeId:adopted.changeId});assert.deepEqual(f.plans.get(wid).data,before.data);assert.equal(f.maps.status().requests,requests);
  const next=await f.complete({workspaceId:wid,nodeId:target}),p=next.proposal!,w=f.plans.get(wid),{id,parentId,order,...fields}=w.data.nodes[target];
  f.command('edit',{nodeId:target,node:{...fields,notes:'另一窗口刚刚更新'}},wid);const fresh=f.plans.get(wid),freshTables=snapshot();
  const response=await f.app.inject({method:'POST',url:`/api/agent/proposals/${p.id}/apply`,headers:{cookie:'travel_session='+f.auth.session(f.owner),'x-travel-app':'1',host:'localhost'},payload:{requestId:randomUUID(),revision:p.revision,digest:p.digest,baseVersion:p.baseVersion}});
  assert.equal(response.statusCode,409,response.body);assert.deepEqual(f.plans.get(wid),fresh);assert.deepEqual(snapshot(),freshTables);assert.equal(f.maps.status().requests,requests);
});

test('MA02/03/10: forged coordinates, field evidence, fixed and out-of-scope bindings fail before plan mutation',async t=>{
  const f=await fixture(t,async()=>{}),wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'测试'})}).workspaceId;
  const root=f.plans.get(wid).data.rootId;
  f.command('add',{parentId:root,node:nodeFields.parse({title:'固定',fixed:true})},wid);
  f.command('add',{parentId:root,node:nodeFields.parse({title:'可调整'})},wid);
  const base=f.plans.get(wid),fixed=Object.values(base.data.nodes).find(n=>n.fixed)!,child=Object.values(base.data.nodes).find(n=>n.title==='可调整')!;
  const a=(await f.maps.query(f.owner.id,{action:'search',text:'first',requestId:randomUUID(),workspaceId:wid})).assets[0];
  const check=(operations:unknown[],nodeId=root)=>f.agent.proposals.prepare(f.owner.id,{workspaceId:wid,nodeId},{answer:'说明',proposal:{title:'预览',operations}},base);
  assert.throws(()=>check([{kind:'set_spatial',nodeId:fixed.id,bindings:[binding(a.id,true)]}]),/固定/);
  assert.throws(()=>check([{kind:'set_spatial',nodeId:root,bindings:[binding(a.id,true)]}],child.id),/范围/);
  assert.throws(()=>check([{kind:'set_spatial',nodeId:child.id,bindings:[binding(randomUUID(),true)]}]),/找不到/);
  const outsider = f.auth.create({ username:'private-map-owner', name:'私人地图所有者', password:'testing-password' });
  const privateAsset = (await f.maps.query(outsider.id,{action:'search',text:'private-place',requestId:randomUUID()})).assets[0];
  assert.throws(()=>check([{kind:'set_spatial',nodeId:child.id,bindings:[binding(privateAsset.id,true)]}]),/私人/);
  for (const assetId of [privateAsset.id, randomUUID()]) assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:wid,nodeId:root},{answer:'说明',spatial:[{assetId}]},base),/私人|找不到/);
  assert.throws(()=>check([{kind:'update_node',nodeId:child.id,changes:{location:{name:'假坐标',lat:43,lng:11,address:''}}}]),/坐标/);
  assert.throws(()=>f.agent.proposals.prepare(f.owner.id,{workspaceId:wid,nodeId:root},{answer:'说明',claims:[{id:'fake',text:'错误',status:'source_supported',spatialEvidence:{assetId:a.id,queryId:a.source.queryId,field:'name',value:'other'}}]},base),/证据/);
  assert.deepEqual(f.plans.get(wid),base);
});

test('MA11: apply rechecks original asset scope after access is revoked, with no partial plan write',async t=>{
  let assetId='',targetId='';
  const f=await fixture(t,async i=>{i.beforeModel(10);await publish(i,{answer:'说明',proposal:{title:'绑定地点',operations:[{kind:'set_spatial',nodeId:targetId,bindings:[binding(assetId,true)]}]}});});
  const source=f.command('create',{kind:'trip',node:nodeFields.parse({title:'共享研究'})}).workspaceId;
  const peer=f.auth.create({username:'peer',name:'B',password:'testing-password'});f.db.prepare("INSERT INTO members VALUES(?,?,'editor')").run(source,peer.id);
  assetId=(await f.maps.query(peer.id,{action:'search',text:'first',workspaceId:source,requestId:randomUUID()})).assets[0].id;
  const destination=f.command('create',{kind:'trip',node:nodeFields.parse({title:'B的计划'})},undefined,peer.id).workspaceId;targetId=f.plans.get(destination).data.rootId;
  const run=await f.complete({workspaceId:destination,nodeId:targetId},peer.id);assert.equal(run.state,'completed',run.message);
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(source,peer.id);
  const before=f.plans.get(destination),p=run.proposal!;
  assert.throws(()=>f.agent.proposals.apply(p.id,peer.id,{requestId:randomUUID(),revision:p.revision,digest:p.digest,baseVersion:p.baseVersion}),/权限/);
  assert.deepEqual(f.plans.get(destination),before);
});

test('MA15/19: agent map tool enforces eight queries and preserves a rejected ninth call in the trace',async t=>{
  const f=await fixture(t,async i=>{
    i.beforeModel(10);
    for(let n=0;n<8;n++)await tool(i,'read_map_data',{action:'search',text:'sample'+n});
    await assert.rejects(tool(i,'read_map_data',{action:'search',text:'ninth'}),/8 次/);
    await publish(i,{answer:'本轮地图查询达到上限，未完成部分保留待查。'});
  });
  const r=await f.complete();assert.equal(r.state,'completed');assert.equal(r.usage.mapQueries,8);assert.equal(f.maps.status().requests,8);
  const trace=new Trajectory(f.db).export(r.id) as any;assert.ok(trace.records.some((x:any)=>x.item.type==='map.failed'&&x.item.status==='error'));
});

test('MA09: replacing a primary place retains the old route as stale rather than rejecting the location change',async t=>{
  const f=await fixture(t,async()=>{}),wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'路线'})}).workspaceId,root=f.plans.get(wid).data.rootId;
  f.command('add',{parentId:root,node:nodeFields.parse({title:'终点'})},wid);const child=Object.values(f.plans.get(wid).data.nodes).find(n=>n.parentId===root)!.id;
  const search=async(text:string)=>(await f.maps.query(f.owner.id,{action:'search',text,workspaceId:wid,requestId:randomUUID()})).assets[0];
  const a=await search('first'),b=await search('second');
  f.command('spatial',{nodeId:root,bindings:[binding(a.id,true)]},wid);f.command('spatial',{nodeId:child,bindings:[binding(b.id,true)]},wid);
  const route=(await f.maps.query(f.owner.id,{action:'route',placeIds:[a.id,b.id],workspaceId:wid,requestId:randomUUID()})).assets[0];
  f.command('spatial',{nodeId:root,bindings:[binding(a.id,true),binding(route.id,false,[root,child])]},wid);
  const old=f.plans.get(wid).data.spatial![root].find(b=>b.assetId===route.id)!;
  f.command('spatial',{nodeId:root,bindings:[binding(b.id,true),old]},wid);
  const data=f.plans.get(wid).data;assert.equal(data.nodes[root].location.lng,points[1][0]);assert.ok(bindingStale(data,data.spatial![root].find(b=>b.assetId===route.id)!));
});

test('MA11/13: revoked shared research remains a valid backup without granting new reads',async t=>{
  let sharedId='';
  const f=await fixture(t,async i=>{i.beforeModel(10);await publish(i,{answer:'只展示研究时已发布的地点。',spatial:[{assetId:sharedId}]});});
  const wid=f.command('create',{kind:'trip',node:nodeFields.parse({title:'历史共享地图'})}).workspaceId,root=f.plans.get(wid).data.rootId;
  const peer=f.auth.create({username:'peer',name:'B',password:'testing-password'});
  f.db.prepare("INSERT INTO members VALUES(?,?,'editor')").run(wid,peer.id);
  sharedId=(await f.maps.query(f.owner.id,{action:'search',text:'first',requestId:randomUUID()})).assets[0].id;
  const privateId=(await f.maps.query(f.owner.id,{action:'search',text:'second',requestId:randomUUID()})).assets[0].id;
  f.command('spatial',{nodeId:root,bindings:[binding(sharedId,true)]},wid);
  const run=await f.complete({workspaceId:wid,nodeId:root},peer.id);assert.equal(run.state,'completed',run.message);
  inspectMapBackup(f.db);
  f.command('spatial',{nodeId:root,bindings:[]},wid);
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(wid,peer.id);
  assert.throws(()=>f.maps.store.allowed(sharedId,peer.id,wid),/权限/);
  assert.throws(()=>f.agent.view(run.id,peer.id),/权限/);
  inspectAgentBackup(f.db);inspectMapBackup(f.db);
  const directory=mkdtempSync(join(tmpdir(),'map-shared-history-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const good=join(directory,'good.db'),target=join(directory,'restored');await f.db.backup(good);await restoreDatabase(good,target);
  const restored=openDatabase(join(target,'travel.db'));
  assert.equal(new MapStore(restored).get(sharedId).id,sharedId);
  assert.throws(()=>new MapStore(restored).allowed(sharedId,peer.id,wid),/权限/);
  restored.close();
  const row=f.db.prepare('SELECT output FROM agent_runs WHERE id=?').get(run.id) as {output:string};
  const forged=JSON.parse(row.output);forged.output.spatial[0].assetId=privateId;
  f.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(JSON.stringify(forged),run.id);
  assert.throws(()=>inspectMapBackup(f.db),/历史发布范围/,'a different private asset is not legitimized by old membership');
  const bad=join(directory,'bad.db');await f.db.backup(bad);
  await assert.rejects(restoreDatabase(bad,target),/历史发布范围/);
  const intact=openDatabase(join(target,'travel.db'));assert.equal(new MapStore(intact).get(sharedId).id,sharedId);intact.close();
  f.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(row.output,run.id);
  inspectMapBackup(f.db);
});

test('MA12/13: moving and merging preserve spatial identity and reversible publication',async t=>{
  let sharedId='';
  const f=await fixture(t,async i=>{i.beforeModel(10);await publish(i,{answer:'阅读已归并的地图地点。',spatial:[{assetId:sharedId}]});});
  const source=f.command('create',{kind:'standalone',node:nodeFields.parse({title:'独立散步'})}).workspaceId,root=f.plans.get(source).data.rootId;
  f.command('add',{parentId:root,node:nodeFields.parse({title:'终点'})},source);
  f.command('add',{parentId:root,node:nodeFields.parse({title:'同一地点的第二次安排'})},source);
  const child=Object.values(f.plans.get(source).data.nodes).find(n=>n.title==='终点')!,duplicate=Object.values(f.plans.get(source).data.nodes).find(n=>n.title==='同一地点的第二次安排')!;
  const lookup=async(text:string)=>(await f.maps.query(f.owner.id,{action:'search',text,requestId:randomUUID()})).assets[0];
  const a=await lookup('first'),b=await lookup('second');sharedId=a.id;
  const hidden=(await f.maps.query(f.owner.id,{action:'suggested_area',placeIds:[a.id,b.id],name:'私人备选区域',requestId:randomUUID()})).assets[0];
  const route=(await f.maps.query(f.owner.id,{action:'route',placeIds:[a.id,b.id],requestId:randomUUID()})).assets[0];
  const area=(await f.maps.query(f.owner.id,{action:'suggested_area',placeIds:[a.id,b.id],name:'采用范围',requestId:randomUUID()})).assets[0];
  f.command('spatial',{nodeId:root,bindings:[binding(a.id,true)]},source);
  f.command('spatial',{nodeId:child.id,bindings:[binding(b.id,true)]},source);
  f.command('spatial',{nodeId:duplicate.id,bindings:[binding(a.id,true)]},source);
  f.command('spatial',{nodeId:root,bindings:[binding(a.id,true),binding(route.id,false,[root,child.id]),binding(area.id)]},source);
  const beforeMove=f.plans.get(source),moved=f.command('move',{nodeId:child.id,parentId:duplicate.id},source);
  const data=f.plans.get(source).data;assert.equal(data.spatial![child.id][0].assetId,b.id);assert.ok(bindingStale(data,data.spatial![root].find(r=>r.assetId===route.id)!));
  f.command('undo',{changeId:moved.changeId});assert.deepEqual(f.plans.get(source).data,beforeMove.data);
  const destinationOwner=f.auth.create({username:'destination',name:'B',password:'testing-password'}),reader=f.auth.create({username:'observer',name:'C',password:'testing-password'});
  const target=f.command('create',{kind:'trip',node:nodeFields.parse({title:'另一人的旅行'})},undefined,destinationOwner.id).workspaceId,targetRoot=f.plans.get(target).data.rootId;
  f.db.prepare("INSERT INTO members VALUES(?,?,'editor')").run(target,f.owner.id);f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(target,reader.id);
  const beforeSource=f.plans.get(source),beforeTarget=f.plans.get(target),requests=f.maps.status().requests;
  const merged=f.command('merge',{targetId:target,targetVersion:beforeTarget.version,parentId:targetRoot},source);
  const combined=f.plans.get(target).data;
  assert.deepEqual(combined.spatial,beforeSource.data.spatial);
  assert.equal(combined.spatial![root][0].assetId,combined.spatial![duplicate.id][0].assetId,'two plan occurrences retain one place identity');
  for(const id of [a.id,b.id,route.id,area.id])assert.equal(f.maps.store.allowed(id,reader.id,target).id,id);
  assert.throws(()=>f.maps.store.allowed(hidden.id,reader.id,target),/私人/);
  const read=await f.complete({workspaceId:target,nodeId:targetRoot},reader.id);assert.equal(read.state,'completed',read.message);
  f.command('undo',{changeId:merged.changeId});
  assert.deepEqual(f.plans.get(source).data,beforeSource.data);assert.deepEqual(f.plans.get(target).data,beforeTarget.data);
  assert.throws(()=>f.maps.store.allowed(a.id,reader.id,target),/私人/);
  assert.equal(f.agent.spatial(read.id,reader.id).length,0,'historical publication does not grant new geometry access');
  assert.equal(f.agent.view(read.id,reader.id).output?.answer,'阅读已归并的地图地点。');
  assert.equal(f.maps.status().requests,requests,'move/merge/undo/history reads do not query providers');
  inspectAgentBackup(f.db);inspectMapBackup(f.db);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMapRefs, agentMediaTargets, mapItemId, workspaceMediaTargets } from '../src/service/client/map-media.js';
import type { AgentRunView } from '../src/shared/agent.js';
import type { WorkspaceData } from '../src/shared/model.js';
import { nodeFields } from '../src/shared/model.js';

test('a candidate photo opens the matching object after candidate filtering, without borrowing another candidate image', () => {
  const run = { output: { spatial: [
    {assetId:'museum', candidateId:'art', mediaIds:['art-photo']},
    {assetId:'bridge', candidateId:'river', mediaIds:['river-photo']},
    {assetId:'square', candidateId:'art', mediaIds:[]},
    {assetId:'museum', mediaIds:['answer-photo']},
  ]}, spatial: [{id:'museum',name:'Uffizi'},{id:'bridge',name:'Ponte Vecchio'}] } as AgentRunView;
  const river = agentMediaTargets(run,'river');
  assert.equal(river.length,1);
  assert.deepEqual(river[0].mediaIds,['river-photo']);
  assert.equal(river[0].itemId,'0:bridge','selection index belongs to the displayed candidate, not the combined history');
  assert.equal(river[0].itemId,mapItemId(agentMapRefs(run,river[0].tab!)[0],0));
  assert.equal(river[0].label,'Ponte Vecchio · 地点');
  assert.deepEqual(agentMediaTargets(run).flatMap(t=>t.mediaIds),['answer-photo']);
  assert.deepEqual(agentMediaTargets(run,'missing'),[]);
});

test('one shared place and photo can target two distinct plan occurrences; unlinked photos create no location', () => {
  const makeNode = (id: string) => ({...nodeFields.parse({title:id}),id,parentId:null,order:0});
  const data: WorkspaceData = {rootId:'morning',kind:'trip',sample:false,nodes:{morning:makeNode('morning'),evening:makeNode('evening')},preparations:{},progress:{},
    media:{morning:['linked','unlinked']}, spatial:{
      morning:[{assetId:'same-place',primary:true,optional:false,nodeIds:[],mediaIds:['linked']}],
      evening:[{assetId:'same-place',primary:true,optional:false,nodeIds:[],mediaIds:['linked']}],
    }};
  const morning=workspaceMediaTargets(data,'morning'),evening=workspaceMediaTargets(data,'evening');
  assert.notEqual(morning[0].itemId,evening[0].itemId);
  assert.equal(morning[0].label,'morning');assert.equal(evening[0].label,'evening');
  assert.deepEqual(morning[0].mediaIds,['linked']);
  assert.ok(!morning.some(t=>t.mediaIds.includes('unlinked')));
  assert.deepEqual(workspaceMediaTargets(data,'missing'),[]);
});

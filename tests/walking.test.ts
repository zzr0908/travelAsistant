import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nodeFields,type PlanNode,type WorkspaceData} from '../src/shared/model.js';
import {walkingGroups,type WalkingStop} from '../src/shared/walking.js';
const node=(id:string,parentId:string|null,dates={}):PlanNode=>({...nodeFields.parse({title:id,dates}),id,parentId,order:0});
const day=(value:string)=>({mode:'fixed',start:value,end:value});
const stop=(id:string,x=11.25):WalkingStop=>({nodeId:id,assetId:id,coordinates:[x,43.77]});
const data=(nodes:PlanNode[]):WorkspaceData=>({rootId:'root',kind:'trip',nodes:Object.fromEntries(nodes.map(n=>[n.id,n])),preparations:{},progress:{},sample:false});
test('walking segments inherit day dates, exclude parent overview stops and never cross days',()=>{
 const w=data([node('root',null),node('day1','root',day('2026-10-01')),node('day2','root',day('2026-10-02')),node('a','day1'),node('b','day1'),node('c','day2'),node('d','day2')]);
 assert.deepEqual(walkingGroups(w,[stop('day1'),stop('a'),stop('b'),stop('c'),stop('d')]).map(g=>g.stops.map(s=>s.nodeId)),[['a','b'],['c','d']]);
});
test('walking segments preserve unknown-date order but separate long-distance legs and multiday overview',()=>{
 const w=data([node('root',null),node('a','root'),node('b','root'),node('c','root'),node('d','root',{mode:'fixed',start:'2026-10-01',end:'2026-10-03'}),node('e','root')]);
 assert.deepEqual(walkingGroups(w,[stop('a'),stop('b',11.251),stop('c',12.5),stop('d',12.501),stop('e',12.502)]).map(g=>g.stops.map(s=>s.nodeId)),[['a','b'],['c'],['d'],['e']]);
});

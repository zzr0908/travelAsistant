import test from 'node:test';
import assert from 'node:assert/strict';
import {distanceToRoute,routeNearby,routeSearchCenters} from '../src/shared/route-nearby.js';
import type {Geometry,SpatialAsset} from '../src/shared/maps.js';
const path:Geometry={type:'LineString',coordinates:[[0,0],[0,.01],[.01,.01]]};
const asset=(entityId:string,coordinates:[number,number])=>({id:entityId,entityId,geometry:{type:'Point',coordinates}} as SpatialAsset);
const route=(mode='walk')=>({geometry:path,route:{mode}} as SpatialAsset);
test('route filtering follows actual bends and does not connect disjoint legs',()=>{
 assert.ok(distanceToRoute([.0001,.005],[path])<12);
 assert.ok(distanceToRoute([.005,.005],[path])>500);
 const separated:Geometry={type:'MultiLineString',coordinates:[[[0,0],[0,.001]],[[0,.02],[0,.021]]]};
 assert.ok(distanceToRoute([0,.01],[separated])>900);
 assert.equal(distanceToRoute([0,0],[{type:'Point',coordinates:[0,0]}]),Infinity);
});
test('along-route candidates exclude planned entities, deduplicate and reject schematic routes',()=>{
 const planned=asset('planned',[0,.005]),near=asset('near',[.0001,.005]),far=asset('far',[.005,.005]);
 assert.deepEqual(routeNearby([planned,near,{...near,id:'duplicate'},far],[route()],[planned]).map(a=>a.entityId),['near']);
 assert.deepEqual(routeNearby([near],[route('schematic')],[]),[]);
 assert.deepEqual(routeNearby([near],[],[]),[]);
});

test('route search centers cover long bends and separate legs without sampling imaginary bridges',()=>{
 const r={geometry:{type:'MultiLineString',coordinates:[[[0,0],[0,.03],[.03,.03]],[[.1,.1],[.1,.101]]]},route:{mode:'walk'}} as SpatialAsset;
 const points=routeSearchCenters(r);
 assert.ok(points.length>7);
 for(const point of points)assert.ok(distanceToRoute(point,[r.geometry])<.01);
 assert.ok(points.some(p=>p[0]===0&&p[1]>.01&&p[1]<.02));
 assert.ok(points.some(p=>p[0]===.1&&p[1]===.1));
 assert.ok(!points.some(p=>p[0]>.03&&p[0]<.1));
 for(let n=0;n<=300;n++) {
  for(const p of [[0,n/10000],[n/10000,.03]])assert.ok(Math.min(...points.map(c=>Math.hypot(c[0]-p[0],c[1]-p[1])*111195))<501);
 }
 assert.deepEqual(routeSearchCenters({...r,route:{mode:'schematic'}} as SpatialAsset),[]);
});

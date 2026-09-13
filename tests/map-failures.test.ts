import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/service/server/app.js';
import {nodeFields} from '../src/shared/model.js';
import {mapFailureMessage,mapResourceFallback} from '../src/service/client/map-errors.js';
import type {MapTransportOptions} from '../src/maps/transport.js';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const place={features:[{properties:{name:'Controlled recovery',place_id:'recovery',formatted:'Florence, Italy',country_code:'it',city:'Florence',category:'entertainment.museum',result_type:'amenity',rank:{confidence:1}},geometry:{type:'Point',coordinates:[11.25,43.77]}}]};
async function fixture(t:TestContext,options:MapTransportOptions){
  const f=await createApp({maps:{apiKey:'controlled-test-key',...options}});t.after(()=>f.app.close());
  const owner=f.auth.create({username:'owner',password:'testing-password'},true);
  const headers={cookie:'travel_session='+f.auth.session(owner),'x-travel-app':'1',host:'localhost'};
  const workspaceId=f.plans.execute(owner.id,{kind:'create',requestId:randomUUID(),payload:{kind:'trip',node:nodeFields.parse({title:'故障时保留的计划'})}}).workspaceId;
  const saved=f.plans.get(workspaceId);
  const search=(text:string,signal?:AbortSignal)=>f.maps.query(owner.id,{action:'search',text,workspaceId,requestId:randomUUID()},{signal});
  const unchanged=()=>assert.deepEqual(f.plans.get(workspaceId),saved);
  return {...f,owner,headers,workspaceId,search,unchanged};
}

test('MA14: 401/403 are not retried; rate and upstream failures retry once with backoff and readable canvas errors',async t=>{
  for(const [status,code,pattern,count] of [[401,'MAP_AUTH',/鉴权/,1],[403,'MAP_AUTH',/鉴权/,1],[429,'MAP_RATE',/请求较多/,2],[503,'MAP_UPSTREAM',/地图资源未加载/,2]] as const){
    await t.test(String(status),async t=>{
      const starts:number[]=[];
      const f=await fixture(t,{fetch:async()=>{starts.push(Date.now());return json({private:'never display raw upstream response'},status);}});
      const r=await f.app.inject({url:'/api/maps/resources/v1/styles/positron/style.json',headers:f.headers});
      assert.equal(r.statusCode,503);assert.equal(r.json().code,code);assert.equal(starts.length,count);
      if(count===2)assert(starts[1]-starts[0]>=450,'automatic retry must back off');
      const message=await mapFailureMessage({status:r.statusCode,body:new Blob([r.body])});assert.match(message,pattern);assert.doesNotMatch(message,/private|upstream response/);
      f.unchanged();assert.equal(f.maps.status().requests,count);
    });
  }
});

test('MA14/16: disconnected provider retries once, hides credential-bearing errors and recovers on explicit retry',async t=>{
  let failed=true;const starts:number[]=[];
  const f=await fixture(t,{fetch:async url=>{starts.push(Date.now());if(failed)throw Error('network failure '+url);return json(place);}});
  const first=await f.search('retry-place');assert.equal(first.status,'failed');assert.match(first.message,/网络/);assert.equal(first.assets.length,0);assert.doesNotMatch(JSON.stringify(first),/controlled-test-key|apiKey/);assert.equal(starts.length,2);assert(starts[1]-starts[0]>=450);
  failed=false;const second=await f.search('retry-place');assert.equal(second.status,'ok');assert.equal(second.assets.length,1);assert.equal(starts.length,3);f.unchanged();
  const msg=await mapFailureMessage({status:503,body:new Blob([JSON.stringify({code:'MAP_NETWORK',message:'secret raw details'})])});assert.match(msg,/网络/);assert.doesNotMatch(msg,/secret/);
});

test('MA14: empty results stay explicit and a changed search can recover without binding a place',async t=>{
  let empty=true,calls=0;const f=await fixture(t,{fetch:async()=>{calls++;return json(empty?{features:[]}:place);}});
  const result=await f.search('empty');assert.equal(result.status,'no_match');assert.deepEqual(result.assets,[]);assert.match(result.message,/未找到可靠结果/);assert.equal(calls,1);
  empty=false;const next=await f.search('more-specific');assert.equal(next.status,'ok');assert.equal(calls,2);f.unchanged();
});

test('MA14/15: unconfigured and exhausted-budget requests stop before any upstream work',async t=>{
  for(const options of [{apiKey:''},{dailyBudget:0}]){
    let calls=0;const f=await fixture(t,{...options,fetch:async()=>{calls++;return json(place);}});
    const result=await f.search('blocked');assert.equal(result.status,'failed');assert.match(result.message,'apiKey' in options?/尚未配置/:/预算/);assert.equal(calls,0);assert.equal(f.maps.status().requests,0);f.unchanged();
    const resource=await f.app.inject({url:'/api/maps/resources/v1/styles/positron/style.json',headers:f.headers});
    const message=await mapFailureMessage({body:new Blob([resource.body])});assert.match(message,'apiKey' in options?/尚未配置/:/预算/);assert.equal(calls,0);
  }
});

test('MA14: deadline and cancellation reject late results without saving assets or replacing the cancelled receipt',async t=>{
  let resolveLate!:(value:Response)=>void,started!:()=>void;
  const ready=new Promise<void>(r=>{started=r;});let calls=0;
  const f=await fixture(t,{fetch:async()=>{calls++;if(calls===1){started();return new Promise<Response>(r=>{resolveLate=r;});}return json(place);}});
  const controller=new AbortController(),pending=f.search('cancelled-late',controller.signal);await ready;controller.abort();
  const cancelled=await pending;assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.assets,[]);
  resolveLate(json(place));await new Promise(r=>setImmediate(r));
  assert.equal((f.db.prepare('SELECT count(*) n FROM spatial_assets').get() as {n:number}).n,0);
  assert.equal(JSON.parse((f.db.prepare('SELECT result FROM map_queries WHERE id=?').get(cancelled.queryId) as {result:string}).result).status,'cancelled');
  const retry=await f.search('cancelled-late');assert.equal(retry.status,'ok');assert.equal(calls,2);f.unchanged();
  const slow=await fixture(t,{timeoutMs:80,fetch:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const start=Date.now(),timedOut=await slow.search('timeout');assert.equal(timedOut.status,'failed');assert.match(timedOut.message,/超时/);assert(Date.now()-start<1500);assert.equal(slow.maps.status().requests,1);assert.deepEqual(timedOut.assets,[]);slow.unchanged();
});

test('MA14/16: malformed, oversized and unknown resource errors never expose raw text',async()=>{
  for(const body of ['<html>credential=private-value</html>',JSON.stringify({code:'UNRECOGNIZED',message:'private-value'}),'x'.repeat(8193)])assert.equal(await mapFailureMessage({body:new Blob([body])}),mapResourceFallback);
  assert.match(await mapFailureMessage({status:0}),/网络/);
  assert.match(await mapFailureMessage({body:new Blob([JSON.stringify({code:'MAP_TIMEOUT'})])}),/超时/);
});

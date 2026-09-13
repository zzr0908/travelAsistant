import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {SessionMap} from '../src/service/client/session-map.js';
test('tab state survives reload, isolates keys and handles corrupt or unavailable storage',()=>{
 const data=new Map<string,string>(),storage=()=>({getItem:(key:string)=>data.get(key)||null,setItem:(key:string,value:string)=>{data.set(key,value);}});
 const first=new SessionMap('one',z.string(),2,storage);
 first.set('user-a:trip','cafe');first.set('user-b:trip','museum');
 const reloaded=new SessionMap('one',z.string(),2,storage);
 assert.equal(reloaded.get('user-a:trip'),'cafe');assert.equal(reloaded.get('user-b:trip'),'museum');
 reloaded.set('third','park');assert.equal(new SessionMap('one',z.string(),2,storage).has('user-a:trip'),false);
 reloaded.delete('third');assert.equal(new SessionMap('one',z.string(),2,storage).has('third'),false);
 assert.equal(new SessionMap('two',z.string(),2,storage).size,0);
 data.set('one','not-json');assert.equal(new SessionMap('one',z.string(),2,storage).size,0);
 data.set('one',JSON.stringify([['key',42]]));assert.equal(new SessionMap('one',z.string(),2,storage).size,0);
 const blocked=new SessionMap('one',z.string(),2,()=>{throw new Error('storage blocked');});blocked.set('a','b');assert.equal(blocked.get('a'),'b');
 blocked.clear();assert.equal(blocked.size,0);
});

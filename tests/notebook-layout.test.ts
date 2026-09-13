import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {registerHooks} from 'node:module';
const cssHook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:next(url,context);}});
const {NotebookView}=await import('../src/service/client/NotebookView.js');
cssHook.deregister();
import {nodeFields,type WorkspaceView} from '../src/shared/model.js';
import {noteFields} from '../src/shared/notes.js';
test('notebook keeps its list while switching and editing; save failure preserves inline draft',async()=>{
 const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
 const location={hash:'#w=w&n=root&v=笔记'};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 const values={window,document,location,history:{replaceState:(_a:unknown,_b:unknown,h:string)=>{location.hash=h;}},requestAnimationFrame:(fn:()=>void)=>{fn();return 1;},fetch:async()=>Response.json({media:[]}),IS_REACT_ACT_ENVIRONMENT:true};
 const originals=new Map(Object.keys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const [k,v]of Object.entries(values))Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});
 const note=(id:string)=>({...noteFields.parse({title:id,body:'正文 '+id,nodeIds:['root']}),id,createdAt:'2026-09-10',updatedAt:'2026-09-10'});
 const w={id:'w',ownerId:'u',deleted:false,members:[],history:[],role:'owner',version:1,data:{rootId:'root',kind:'trip',sample:false,nodes:{root:{...nodeFields.parse({title:'旅行'}),id:'root',parentId:null,order:0}},notebook:{a:note('a'),b:note('b')},preparations:{},progress:{}}} as WorkspaceView;
 const root=createRoot(document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(NotebookView,{workspace:w,nodeId:'root',userId:'u',onRefresh:()=>{},onSave:async()=>{throw Error('连接失败');}})));
  const click=async(label:string)=>act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!.click();});
  await act(async()=>document.querySelectorAll<HTMLButtonElement>('.note-list-row')[1].click());
  assert.equal(document.querySelector('.note-reader h2')?.textContent,'b');
  assert.equal(document.querySelectorAll('.note-list-row').length,2);
  assert.equal(document.querySelector('.note-related')?.hasAttribute('open'),false);
  await click('编辑');assert.equal(document.querySelector('dialog'),null);assert.ok(document.querySelector('.note-inline-editor textarea'));
  await act(async()=>{document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});
  assert.match(document.body.textContent!,/连接失败/);assert.equal(document.querySelector('textarea')!.value,'正文 b');
  await click('取消');assert.equal(document.querySelector('.note-reader h2')?.textContent,'b');
 }finally{await act(async()=>root.unmount());for(const [k,v]of originals)if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {SaveResearchNote} from '../src/service/client/SaveResearchNote.js';
import type {AgentRunView} from '../src/shared/agent.js';

test('independent research requires an editable destination; failed save preserves draft and retry identity',async()=>{
 const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
 (window.HTMLElement.prototype as any).showModal=function(){};
 (window.HTMLElement.prototype as any).close=function(){};
 const commands:any[]=[];let failure=0,savedTo='';
 const workspace={id:'editable',role:'owner',version:2,data:{rootId:'root',nodes:{root:{title:'目标旅行'}}}};
 const fetcher=async(url:unknown,options:RequestInit)=>{
  if(url==='/api/workspaces')return Response.json({workspaces:[{id:'editable',title:'目标旅行',role:'owner'},{id:'readonly',title:'只读旅行',role:'reader'}]});
  if(url==='/api/workspaces/editable')return Response.json(workspace);
  if(url==='/api/commands'){
   commands.push(JSON.parse(options.body as string));
   if(failure===0){failure++;throw new Error('lost response');}
   if(failure===1){failure++;return Response.json({message:'权限已变为只读'},{status:403});}
   return Response.json({});
  }
  throw new Error(String(url));
 };
 const values:Record<string,unknown>={window,document,fetch:fetcher,IS_REACT_ACT_ENVIRONMENT:true};
 const originals=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 const root=createRoot(document.getElementById('root')!);
 const run={scope:{workspaceId:null},prompt:'独立研究',media:[],output:{answer:'草稿正文',claims:[],candidates:[],media:[],spatial:[]}} as unknown as AgentRunView;
 try{
  await act(async()=>root.render(createElement(SaveResearchNote,{run,onClose:()=>{},onSaved:async id=>{savedTo=id;}})));
  const submit=()=>document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await act(async()=>{submit();});assert.equal(commands.length,0);
  assert.equal(document.querySelector('option[value="readonly"]'),null);
  const select=document.querySelector('select')!;
  Object.defineProperty(select,'value',{value:'editable',configurable:true});
  await act(async()=>select.dispatchEvent(new window.Event('change',{bubbles:true})));
  await act(async()=>{submit();});
  assert.match(document.body.textContent!,/连接中断/);
  assert.equal(document.querySelector('textarea')!.value,'草稿正文');
  await act(async()=>{submit();});
  assert.match(document.body.textContent!,/权限已变为只读/);
  assert.equal(document.querySelector('textarea')!.value,'草稿正文');
  assert.equal(savedTo,'');
  await act(async()=>{submit();});
  assert.equal(savedTo,'editable');
  assert.equal(new Set(commands.map(c=>c.requestId)).size,1);
  assert.ok(commands.every(c=>c.workspaceId==='editable'&&c.payload.note.nodeIds.length===0));
  assert.match(document.body.textContent!,/已保存到旅行笔记/);
  await act(async()=>{submit();});assert.equal(commands.length,3,'saved form must not submit again');
 }finally{
  await act(async()=>root.unmount());
  for(const [key,value]of originals)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});

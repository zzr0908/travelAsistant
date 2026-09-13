import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {useNoteNavigation} from '../src/service/client/note-navigation.js';

test('opening a note starts at its header, returning restores list position and focus without disturbing rerenders',async()=>{
 const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
 const location={hash:'#w=trip&n=day&v=笔记'};
 const focus:string[]=[],scrolls:unknown[]=[];
 let top=650;
 Object.defineProperty(window,'scrollY',{get:()=>top,configurable:true});
 window.scrollTo=((options:any)=>{top=options.top;scrolls.push(options);}) as any;
 window.HTMLElement.prototype.focus=function(){focus.push(this.id);};
 window.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({id:this.id,options});top=300;};
 const values:Record<string,unknown>={window,document,location,history:{replaceState:(_a:unknown,_b:unknown,hash:string)=>{location.hash=hash;}},IS_REACT_ACT_ENVIRONMENT:true};
 const saved=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 function Harness(){const {selected,readingRoot,rows,selectNote}=useNoteNavigation();return createElement('section',{id:'reader',ref:readingRoot},selected?createElement('button',{id:'back',onClick:()=>selectNote('')},'返回'):createElement('button',{id:'note',ref:(el:HTMLButtonElement|null)=>{if(el)rows.current.set('note',el);else rows.current.delete('note');},onClick:()=>selectNote('note')},'打开'));}
 const root=createRoot(document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(Harness)));assert.equal(scrolls.length,0);
  await act(async()=>document.getElementById('note')!.click());
  assert.equal(focus.at(-1),'reader');assert.equal(top,300);assert.equal(new URLSearchParams(location.hash.slice(1)).get('note'),'note');
  top=1100;const count=scrolls.length;
  await act(async()=>root.render(createElement(Harness)));assert.equal(scrolls.length,count);assert.equal(top,1100);
  await act(async()=>document.getElementById('back')!.click());
  assert.equal(top,650);assert.equal(focus.at(-1),'note');
  const hash=new URLSearchParams(location.hash.slice(1));assert.equal(hash.has('note'),false);assert.equal(hash.get('w'),'trip');assert.equal(hash.get('n'),'day');
 }finally{
  await act(async()=>root.unmount());
  for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});

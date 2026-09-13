import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {RichContent} from '../src/service/client/RichContent.js';
import {NoteInlineImage} from '../src/service/client/NoteInlineImage.js';
import type {MediaAsset} from '../src/shared/agent.js';

test('notes preserve literal backslash sequences and do not render untrusted HTML or image URLs',()=>{
 const html=renderToStaticMarkup(createElement(RichContent,{preserveLineEscapes:true,text:'`first\\nsecond`\n\n<script>alert(1)</script>\n\n![photo](https://example.com/private.png)'}));
 assert.ok(html.includes('first\\nsecond'));
 assert.ok(!html.includes('<script>'));
 assert.ok(!html.includes('<img'));
});
test('inline image failure keeps caption, retries a new request, and opens from the actual trigger',async()=>{
 const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
 const values:Record<string,unknown>={window,document,IS_REACT_ACT_ENVIRONMENT:true};
 const saved=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 const root=createRoot(document.getElementById('root')!);
 try {
  let trigger:HTMLButtonElement|undefined;
  const image={id:'test-image',alt:'老桥图注',caption:'来源说明',sourceTitle:'图片来源',width:200,height:100} as MediaAsset;
  await act(async()=>root.render(createElement(NoteInlineImage,{image,onOpen:button=>{trigger=button;}})));
  const first=document.querySelector('img')!.getAttribute('src');
  await act(async()=>{document.querySelector('img')!.dispatchEvent(new window.Event('error'));});
  assert.ok(document.body.textContent!.includes('图片暂时无法加载'));
  assert.ok(document.body.textContent!.includes('来源说明'));
  const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==='重试图片')!;
  await act(async()=>retry.click());
  assert.notEqual(document.querySelector('img')!.getAttribute('src'),first);
  await act(async()=>{document.querySelector('img')!.dispatchEvent(new window.Event('load'));});
  assert.ok(!document.body.textContent!.includes('正在加载图片'));
  const button=document.querySelector('button')!;
  await act(async()=>button.click());assert.equal(trigger,button);
 }finally {
  await act(async()=>root.unmount());
  for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});

test('note image survives refreshed media props and restores focus and scroll after closing',async()=>{
 const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
 let focused:unknown,position:unknown;
 const frames=new Map<number,FrameRequestCallback>();let next=0;
 window.HTMLElement.prototype.focus=function(){focused=this;};
 (window.HTMLElement.prototype as any).showModal=function(){};
 window.scrollTo=(value:unknown)=>{position=value;};
 const values:Record<string,unknown>={window,document,scrollX:0,scrollY:460,requestAnimationFrame:(fn:FrameRequestCallback)=>{frames.set(++next,fn);return next;},cancelAnimationFrame:(id:number)=>frames.delete(id),IS_REACT_ACT_ENVIRONMENT:true};
 const saved=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 const root=createRoot(document.getElementById('root')!);
 const image={id:'compass',alt:'圆规',width:700,height:700,sourceUrl:'https://example.com',retrievedAt:'2026-09-09'} as MediaAsset;
 try{
  const render=()=>root.render(createElement(RichContent,{text:'![圆规](media:compass)',images:[{...image}]}));
  await act(async()=>render());
  const trigger=document.querySelector('button')!;
  await act(async()=>trigger.click());
  await act(async()=>render());
  assert.equal(document.querySelector('.note-inline-image button'),trigger,'parent refresh must not remount the image');
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click());
  for(const callback of frames.values())callback(0);
  assert.equal(focused,trigger);
  assert.deepEqual(position,{left:0,top:460,behavior:'instant'});
  assert.equal(document.querySelector('dialog'),null);
 }finally{
  await act(async()=>root.unmount());
  for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});

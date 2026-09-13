import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentDriver, DriverInput, ExecutionTask } from '../../shared/execution.js';
import { EXECUTION_PROTOCOL } from '../../shared/execution.js';
import { AppClient } from './client.js';
import { BrowserEngine, type BrowserOptions } from '../browser/engine.js';
import { MemoryBrowserStore } from '../browser/memory-store.js';
import { buildPrompt } from './prompt.js';
import { processImage } from '../../shared/image-processing.js';
import { digest } from '../../shared/hash.js';
import { downloadImage } from './image-download.js';

export class AgentWorker {
  readonly client:AppClient;
  readonly browser:BrowserEngine;
  private store=new MemoryBrowserStore();
  private controller=new AbortController();
  private active=new Map<string,Promise<void>>();
  private runs=new Map<string,{task:ExecutionTask;signal:AbortSignal}>();
  private loops:Promise<void>[]=[];
  private leaseMs=15000;
  private seen=0;
  private health?:Server;
  async startHealth(port=4318) {
    this.health=createServer((req,res)=>{if(req.url!=='/health'){res.writeHead(404).end();return;}const connected=Date.now()-this.seen<this.leaseMs;res.writeHead(connected?200:503,{'content-type':'application/json'}).end(JSON.stringify({service:'agent',protocol:EXECUTION_PROTOCOL,connected}));});
    await new Promise<void>((resolve,reject)=>{this.health!.once('error',reject);this.health!.listen(port,'127.0.0.1',resolve);});
  }
  constructor(base:string,token:string,browserOptions:BrowserOptions,private driver?:AgentDriver) {
    this.client=new AppClient(base,token);this.browser=new BrowserEngine(this.store,browserOptions);
  }
  sessionCall(runId:string,method:string,value:unknown) {
    const run=this.runs.get(runId);if(!run)throw Error('没有本次运行的持久化凭据');
    return this.client.call(run.task,method,value,run.signal);
  }
  async start() {
    const capabilities=['image','release',...(this.browser.status().enabled?['browser']:[]),...(this.driver?['research']:[])];
    const register=async()=>{const status=await this.client.request('/internal/agent/v1/register',{instanceId:this.client.instanceId,protocol:EXECUTION_PROTOCOL,version:'0.2.0',capabilities},this.controller.signal);this.leaseMs=status.leaseMs;this.seen=Date.now();};
    const poll=async(kinds:string[],capacity:number)=>{
      const own=new Set<Promise<void>>();
      while(!this.controller.signal.aborted){
        try {
          if(own.size>=capacity){await Promise.race(own);continue;}
          const {task}=await this.client.request('/internal/agent/v1/claim',{instanceId:this.client.instanceId,kinds},this.controller.signal);
          this.seen=Date.now();
          if(task){
            const p=this.execute(task).catch(()=>{}).finally(()=>{own.delete(p);this.active.delete(task.id);});own.add(p);this.active.set(task.id,p);
          }else await delay(200,undefined,{signal:this.controller.signal});
        }catch{if(!this.controller.signal.aborted){await delay(500,undefined,{signal:this.controller.signal}).catch(()=>{});await register().catch(()=>{});}}
      }
      await Promise.allSettled(own);
    };
    // App may be starting or migrating. Reconnect without creating new paid work.
    while(!this.controller.signal.aborted){try{await register();break;}catch{await delay(500,undefined,{signal:this.controller.signal}).catch(()=>{});}}
    this.loops=[poll(['research'],2),poll(['browser'],4),poll(['image'],2),poll(['release'],4)];
  }
  private async execute(task:ExecutionTask) {
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.controller.signal,AbortSignal.timeout(Math.max(1,task.deadline-Date.now()))]);
    let renewing=false;
    const renew=async()=>{if(renewing||signal.aborted)return;renewing=true;try{await this.client.request(`/internal/agent/v1/jobs/${task.id}/renew`,{instanceId:this.client.instanceId,lease:task.lease},signal,Math.min(3000,this.leaseMs/2));}catch{controller.abort(new Error('执行租约失联'));}finally{renewing=false;}};
    const timer=setInterval(()=>void renew(),Math.max(100,this.leaseMs/3));timer.unref();
    let result:unknown=null,error:string|undefined;
    try{
      if(task.kind==='research'){
        if(!this.driver)throw Error('研究模型未配置');
        this.runs.set(task.payload.id,{task,signal});
        let saved=false,text='';let effects=Promise.resolve();
        const enqueue=(method:string,value:unknown)=>{effects=effects.then(()=>this.client.call(task,method,value,signal)).then(()=>{});void effects.catch(()=>{});return effects;};
        const input:DriverInput={id:task.payload.id,prompt:task.payload.strategy?buildPrompt(task.payload.strategy)+(task.payload.strategy.repair?'\n上一轮未形成有效产物。请调用 publish_result 提交完整结果。这是唯一一次格式修复。':''):task.payload.prompt,maxTokens:task.payload.maxTokens,signal,
          beforeModel:async value=>{await effects;await this.client.call(task,'beforeModel',value,signal);},
          request:value=>enqueue('request',value),usage:value=>enqueue('usage',value),text:value=>{text=(text+value).slice(-16000);},hasResult:()=>saved,
          tools:task.payload.tools.map((tool:any)=>({...tool,execute:async(value:unknown,_toolSignal:AbortSignal)=>{await effects;const result=await this.client.call(task,'tool',{name:tool.name,input:value},signal);if(tool.name==='publish_result')saved=true;return result;}})),
        };
        await this.driver.run(input);await effects;if(text)await this.client.call(task,'text',text,signal);
      }else if(task.kind==='browser'){
        const {owner,input,lease,queryId}=task.payload;
        const value=await this.browser.execute(owner,input,signal,lease);
        try{if(value.artifact)await this.client.upload(task,'screenshot',this.store.artifact(owner,value.artifact.id).bytes,signal);const rebind=(id:string)=>id.startsWith(value.queryId+':')?queryId+id.slice(value.queryId.length):id;result={...value,queryId,evidenceIds:value.evidenceIds.map(rebind),data:value.data?{...value.data,evidenceId:value.data.evidenceId?rebind(value.data.evidenceId):null}:null};}
        finally{this.store.forget(value.queryId);}
      }else if(task.kind==='image'){
        if(task.payload.process){
          const original=await this.client.download(task,'original',signal),image=await processImage(original,signal);
          await this.client.upload(task,'image',image.bytes,signal);await this.client.upload(task,'thumbnail',image.thumbnail,signal);
          result={width:image.width,height:image.height,sha256:digest(image.bytes),thumbnailSha256:digest(image.thumbnail)};
        }else{const bytes=await downloadImage(task.payload.url,signal);await this.client.upload(task,'image',bytes,signal);result={byteLength:bytes.length};}
      }else if(task.kind==='release'){
        if(task.payload.researchId){this.runs.set(task.payload.researchId,{task,signal});await this.driver?.release?.(task.payload.researchId);this.runs.delete(task.payload.researchId);}
        if(task.payload.lease)await this.browser.releaseLease(task.payload.lease);
      }
      signal.throwIfAborted();
    }catch(e){error=signal.aborted?'Agent 执行中断，已保存资料保留':e instanceof Error && /图片|来源|原图|预算|格式|超时/.test(e.message)?e.message:'Agent 执行失败，已保存资料保留';}
    try {
      if(!signal.aborted){
        const body={instanceId:this.client.instanceId,lease:task.lease,result,error};
        try{await this.client.request(`/internal/agent/v1/jobs/${task.id}/complete`,body,signal);}
        catch{signal.throwIfAborted();await this.client.request(`/internal/agent/v1/jobs/${task.id}/complete`,body,signal);}
      }
    }finally{clearInterval(timer);}
  }
  async close() {this.controller.abort();await new Promise<void>(resolve=>this.health?this.health.close(()=>resolve()):resolve());await Promise.allSettled(this.loops);await Promise.allSettled([...this.active.values()]);await this.driver?.close();await this.browser.close();}
}

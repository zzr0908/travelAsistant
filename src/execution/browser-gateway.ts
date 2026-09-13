import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/database.js';
import { BrowserStore } from '../storage/browser.js';
import { browserRequest, browserResult, BrowserError, type BrowserResult } from '../shared/browser-model.js';
import { defaultHosts, sources } from '../shared/browser-sources.js';
import type { BrowserApi } from '../shared/browser-port.js';
import type { ExecutionBroker } from './broker.js';
import { digest } from '../shared/hash.js';

/** Durable query data stays here; browser handles and Chrome live only in the worker. */
export class BrowserGateway implements BrowserApi {
  readonly store:BrowserStore;
  private tasks=new Map<string,{owner:string;lease:string;controller:AbortController;promise:Promise<BrowserResult>}>();
  private affinity=new Map<string,string>();
  constructor(db:DB,private broker:ExecutionBroker) {this.store=new BrowserStore(db);this.store.recover();}
  status() {return {enabled:this.broker.capability('browser'),provider:'chrome-devtools-mcp',providerVersion:'1.8.0',chromeMinimum:149,headless:true,connection:'agent_service',allowedHosts:defaultHosts,sources:sources.map(({id,label,type})=>({id,label,type})),capabilities:['read','capture','follow','scroll','search','expand','screenshot','login','close'],limitations:['浏览器由独立 Agent 服务执行；重启后页面句柄失效，已存证据保留。']};}
  private failure(id:string,input:any,message:string):BrowserResult {
    return browserResult.parse({schemaVersion:1,queryId:id,capability:`browser.${input.action}`,providerId:'chrome-devtools-mcp',status:'interrupted',data:null,evidenceIds:[],artifact:null,context:input.context,missing:['query_result'],limitations:['不会自动重放浏览器操作'],retrievedAt:new Date().toISOString(),durationMs:0,usage:{toolCalls:0,browserRequests:null,cost:null},message});
  }
  start(owner:string,raw:unknown,signal?:AbortSignal,lease=owner) {
    if(!this.broker.capability('browser'))throw new BrowserError('unavailable','Agent 浏览器未连接');
    if([...this.tasks.values()].filter(t=>t.owner===owner).length>=4)throw new BrowserError('unavailable','浏览器任务已达并发上限');
    const previousWorker=this.affinity.get(lease);if(previousWorker && !this.broker.workerAvailable(previousWorker))this.affinity.delete(lease);
    signal?.throwIfAborted();
    const input=browserRequest.parse(raw),begun=this.store.begin(owner,input);
    if(begun.existing)return {queryId:begun.id,state:this.store.get(owner,begun.id).state};
    const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let committed:BrowserResult|undefined;
    let jobId='';
    const job=this.broker.submit('browser',{owner,lease,input,queryId:begun.id},{signal:controller.signal,timeoutMs:60000,affinity:this.affinity.get(lease),finish:rawResult=>{
      const result=browserResult.parse(rawResult);
      if(result.queryId!==begun.id)throw new BrowserError('restricted','查询结果标识不匹配');
      if(result.data && digest(result.data.text)!==result.data.textHash)throw new BrowserError('failed','正文摘要不匹配');
      const bytes=result.artifact?this.broker.consumeBlobs(jobId,['screenshot'])[0]:undefined;
      if(result.artifact && (!bytes || digest(bytes)!==result.artifact.sha256 || bytes.length!==result.artifact.byteLength))throw new BrowserError('failed','截图摘要不匹配');
      this.store.finish(owner,result,bytes);committed=result;
    }});
    jobId=job.id;
    const promise=job.promise.then(({workerId})=>{this.affinity.set(lease,workerId);return committed!;}).catch(error=>{
      const current=this.store.get(owner,begun.id);if(current.result)return current.result;
      const result=this.failure(begun.id,input,error instanceof Error?error.message:'浏览器执行中断');this.store.finish(owner,result);return result;
    }).finally(()=>{this.tasks.delete(begun.id);signal?.removeEventListener('abort',abort);});
    this.tasks.set(begun.id,{owner,lease,controller,promise});
    return {queryId:begun.id,state:'queued'};
  }
  async execute(owner:string,raw:unknown,signal?:AbortSignal,lease=owner) {const {queryId}=this.start(owner,raw,signal,lease);return this.tasks.get(queryId)?.promise || this.store.get(owner,queryId).result!;}
  cancel(owner:string,id:string) {const row=this.store.get(owner,id);if(row.result)return {queryId:id,state:row.state};this.store.state(id,'cancelling');this.tasks.get(id)?.controller.abort();return {queryId:id,state:'cancelling'};}
  async releaseLease(lease:string) {
    const work=[...this.tasks.values()].filter(t=>t.lease===lease);for(const t of work)t.controller.abort();await Promise.allSettled(work.map(t=>t.promise));
    const affinity=this.affinity.get(lease);this.affinity.delete(lease);
    if(affinity && this.broker.capability('release')) {
      try{await this.broker.submit('release',{lease},{affinity,timeoutMs:3000}).promise;}catch{/* A dead worker cannot retain a live Chrome lease. */}
    }
  }
  async disconnect(owner:string) {await Promise.allSettled([...new Set([owner,...[...this.tasks.values()].filter(t=>t.owner===owner).map(t=>t.lease)])].map(l=>this.releaseLease(l)));}
  async close() {for(const t of this.tasks.values())t.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.promise));}
}

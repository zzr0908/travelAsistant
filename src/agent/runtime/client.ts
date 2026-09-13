import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionTask } from '../../shared/execution.js';

export class WorkerHttpError extends Error {constructor(public status:number,message:string){super(message);}}
export class AppClient {
  readonly instanceId=randomUUID();
  constructor(readonly base:string,private token:string) {
    const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('内部服务地址无效');
  }
  async request(path:string,body:unknown,signal?:AbortSignal,timeoutMs=10000):Promise<any> {
    const response=await fetch(this.base+path,{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])])});
    const value=await response.json() as any;if(!response.ok)throw new WorkerHttpError(response.status,value.message||'内部服务请求失败');return value;
  }
  async call(task:ExecutionTask,method:string,value:unknown,signal?:AbortSignal) {
    const body={instanceId:this.instanceId,lease:task.lease,operationId:randomUUID(),method,value};
    // Retry only the exact same application operation, never a model request.
    for(let attempt=0;;attempt++) {
      try{return (await this.request(`/internal/agent/v1/jobs/${task.id}/call`,body,signal,Math.max(1000,Math.min(65000,task.deadline-Date.now())))).value;}
      catch(error){if(signal?.aborted||error instanceof WorkerHttpError||attempt>=1)throw error;await delay(100,undefined,{signal});}
    }
  }
  async download(task:ExecutionTask,name:string,signal?:AbortSignal) {
    const response=await fetch(`${this.base}/internal/agent/v1/jobs/${task.id}/blobs/${name}`,{headers:{authorization:`Bearer ${this.token}`,'x-worker-id':this.instanceId,'x-worker-lease':task.lease},signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
    if(!response.ok)throw new WorkerHttpError(response.status,'执行附件读取失败');
    return Buffer.from(await response.arrayBuffer());
  }
  async upload(task:ExecutionTask,name:string,bytes:Buffer,signal?:AbortSignal) {
    const response=await fetch(`${this.base}/internal/agent/v1/jobs/${task.id}/blobs/${name}`,{method:'PUT',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/octet-stream','x-worker-id':this.instanceId,'x-worker-lease':task.lease},body:new Uint8Array(bytes),signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
    if(!response.ok)throw new WorkerHttpError(response.status,'执行附件上传失败');
  }
}

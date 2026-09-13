import type { AgentDriver, DriverInput } from '../shared/execution.js';
import type { ExecutionBroker } from './broker.js';
import { ensure } from '../service/domain/validation.js';

/** App-side execution port. It contains no model loop, prompt policy or provider. */
export class RemoteDriver implements AgentDriver {
  kind='remote' as const;
  private affinity=new Map<string,string>();
  constructor(private broker:ExecutionBroker) {}
  available() {return this.broker.capability('research');}
  status() {return this.broker.status();}
  async run(input:DriverInput) {
    const job=this.broker.submit('research',{
      id:input.id,prompt:input.prompt,strategy:input.strategy,maxTokens:input.maxTokens,
      tools:input.tools.map(({name,description,parameters})=>({name,description,parameters})),
    },{signal:input.signal,affinity:this.affinity.get(input.id),call:async(method,value)=>{
      input.signal.throwIfAborted();
      switch(method) {
        case 'beforeModel': ensure(Number.isSafeInteger(value)&&value>=0,'模型输入估计无效');await input.beforeModel(value);return null;
        case 'request': await input.request?.(value);return null;
        case 'usage': {
          ensure(value&&typeof value.model==='string','模型用量格式无效');
          for(const key of ['input','output','cache','total'])ensure(value[key]===undefined || (Number.isSafeInteger(value[key])&&value[key]>=0),'模型用量无效');
          await input.usage(value);return null;
        }
        case 'text': ensure(typeof value==='string'&&value.length<=16000,'文字片段过长');input.text(value);return null;
        case 'tool': {
          const tool=input.tools.find(t=>t.name===value?.name);ensure(tool,'工具未授权',403);
          return tool.execute(value.input,input.signal);
        }
        default: ensure(false,'执行操作未授权',403);
      }
    }});
    try{await job.promise;}finally{const workerId=this.broker.workerForJob(job.id);if(workerId)this.affinity.set(input.id,workerId);}
  }
  async release(id:string) {
    const affinity=this.affinity.get(id);this.affinity.delete(id);
    if(affinity && this.broker.workerAvailable(affinity) && this.broker.capability('release'))await this.broker.submit('release',{researchId:id},{affinity,timeoutMs:5000}).promise;
  }
  async close() { /* The app owns the broker; restarting a worker does not close the app. */ }
}

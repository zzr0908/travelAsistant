import { AgentWorker } from '../../src/agent/runtime/worker.js';
import { setTimeout as delay } from 'node:timers/promises';
const worker=new AgentWorker(process.env.APP_INTERNAL_URL!,process.env.TRAVEL_SERVICE_TOKEN!,{directory:"unused",enabled:false},{kind:'test',async run(input){
  await input.beforeModel(20);
  if(input.prompt.includes('WAIT_FOR_KILL'))await delay(60000,undefined,{signal:input.signal});
  await input.tools.find(t=>t.name==='publish_result')!.execute({answer:'两个服务回归验证',proposal:{title:'分离验证',operations:[{kind:'new_workspace',id:'root',node:{title:'独立服务草案'}}]}},input.signal);
},async release(){}});
await worker.start();process.send?.({ready:true});
process.once('SIGTERM',()=>void worker.close().then(()=>process.exit(0)));

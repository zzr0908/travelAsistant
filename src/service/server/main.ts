import { resolve } from 'node:path';
import { createApp } from './app.js';
import { acquireLock } from '../../storage/runtime-lock.js';
import { loadEnvironment, appSecrets, secret } from './runtime-config.js';
import { cardExtractor } from '../../cards/model.js';
loadEnvironment();
const port=Number(process.env.PORT || 4317),host=process.env.HOST || '127.0.0.1';
const directory=resolve(process.env.DATA_DIR || 'data');
const release=acquireLock(directory);process.once('exit',release);
const credentials=appSecrets(directory);
const proxy=process.env.TRUST_PROXY;
const {app,execution}=await createApp({database:resolve(directory,'travel.db'),staticRoot:resolve(process.env.STATIC_ROOT || 'dist/client'),host,port,logger:true,
  agent:{mode:process.env.TRAVEL_AGENT_MODE==='development'?'development':'ordinary',limits:process.env.TRAVEL_AGENT_LIMITS?JSON.parse(process.env.TRAVEL_AGENT_LIMITS):undefined},
  execution:{token:credentials.token},setupToken:credentials.setupToken,publicUrl:process.env.PUBLIC_URL,
  trustProxy:proxy ? (/^\d+$/.test(proxy)?Number(proxy):proxy.split(',')):undefined,
  cardExtractor:cardExtractor({key:secret('CARD_API_KEY') || secret('ZHIPU_API_KEY'),model:process.env.CARD_MODEL || 'glm-5.3-flash',baseUrl:process.env.CARD_BASE_URL}),
});
app.addHook('onClose',async()=>release());
try {
  await execution!.listen(process.env.INTERNAL_HOST || '127.0.0.1',Number(process.env.INTERNAL_PORT || 4319));
  await app.listen({host,port});
}catch(error){await app.close();throw error;}
console.log(`行间功能服务：http://localhost:${port}；首次安装凭据位于 ${credentials.setupFile}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});

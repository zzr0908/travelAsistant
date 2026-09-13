import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { AgentWorker } from './worker.js';
import { browserOptions } from '../browser/config.js';

const envFile=process.env.TRAVEL_ENV_FILE || resolve('.env');
if(existsSync(envFile))for(const [k,v] of Object.entries(parseEnv(readFileSync(envFile,'utf8'))))if(process.env[k]===undefined)process.env[k]=v;
const token=(process.env.TRAVEL_SERVICE_TOKEN_FILE?readFileSync(process.env.TRAVEL_SERVICE_TOKEN_FILE,'utf8'):process.env.TRAVEL_SERVICE_TOKEN || '').trim();
if(token.length<32)throw Error('请通过安装器配置 TRAVEL_SERVICE_TOKEN_FILE');
const worker=new AgentWorker(process.env.APP_INTERNAL_URL || 'http://127.0.0.1:4319',token,{...browserOptions(resolve(process.env.AGENT_DATA_DIR || 'data-agent')),headless:true,maxSessions:4});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void worker.close().then(()=>process.exit(0));});
await worker.startHealth(Number(process.env.AGENT_HEALTH_PORT || 4318));
await worker.start();
console.log('Agent 执行服务已启动；研究模型未配置，浏览器能力独立提供。');

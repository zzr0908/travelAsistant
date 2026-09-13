import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { appSecrets } from '../dist/server/service/server/runtime-config.js';
const root=resolve(import.meta.dirname,'..');
const file=process.env.TRAVEL_ENV_FILE || join(root,'.env');
const env={...(existsSync(file)?parseEnv(readFileSync(file,'utf8')):{}),...process.env};
const directory=resolve(env.DATA_DIR || join(root,'data'));
process.env.TRAVEL_CONFIG_DIR=resolve(env.TRAVEL_CONFIG_DIR || join(directory,'config'));
for(const key of ['TRAVEL_SERVICE_TOKEN','TRAVEL_SERVICE_TOKEN_FILE','TRAVEL_SETUP_TOKEN','TRAVEL_SETUP_TOKEN_FILE'])if(env[key])process.env[key]=env[key];
const credentials=appSecrets(directory);
env.TRAVEL_CONFIG_DIR=credentials.config;
if(!env.TRAVEL_SERVICE_TOKEN && !env.TRAVEL_SERVICE_TOKEN_FILE)env.TRAVEL_SERVICE_TOKEN_FILE=join(credentials.config,'service-token');
env.APP_INTERNAL_URL=env.APP_INTERNAL_URL || `http://127.0.0.1:${env.INTERNAL_PORT || 4319}`;
env.AGENT_DATA_DIR=resolve(env.AGENT_DATA_DIR || join(root,'data-agent'));
const children=[];let stopping=false;
function stop(signal='SIGTERM') {if(stopping)return;stopping=true;for(const child of children)child.kill(signal);const timer=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');},10000);timer.unref();}
for(const entry of ['dist/server/service/server/main.js','scripts/start-agent.mjs']) {
  const child=spawn(process.execPath,[join(root,entry)],{cwd:root,env,stdio:'inherit'});children.push(child);
  child.on('error',error=>{console.error(error.message);process.exitCode=1;stop();});
  child.on('exit',code=>{if(!stopping){process.exitCode=code || 1;stop();}});
}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>stop(signal));
console.log(`首次管理员设置：使用 ${credentials.config}/setup-token 中的安装凭据。`);

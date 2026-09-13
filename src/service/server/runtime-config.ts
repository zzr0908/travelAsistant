import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

export function loadEnvironment() {
  const path=process.env.TRAVEL_ENV_FILE || resolve('.env');
  if(existsSync(path))for(const [key,value] of Object.entries(parseEnv(readFileSync(path,'utf8'))))if(process.env[key]===undefined)process.env[key]=value;
}
export function secret(name:string) {
  const file=process.env[`${name}_FILE`];return (file?readFileSync(file,'utf8'):process.env[name] || '').trim();
}
export function appSecrets(directory:string) {
  const config=resolve(process.env.TRAVEL_CONFIG_DIR || join(directory,'config'));mkdirSync(config,{recursive:true,mode:0o700});
  const setupConfig=resolve(process.env.TRAVEL_SETUP_CONFIG_DIR || config);mkdirSync(setupConfig,{recursive:true,mode:0o700});
  const get=(name:string,file:string,base=config)=>{
    const configured=secret(name);if(configured)return configured;
    const path=join(base,file);if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
    return readFileSync(path,'utf8').trim();
  };
  return {token:get('TRAVEL_SERVICE_TOKEN','service-token'),setupToken:get('TRAVEL_SETUP_TOKEN','setup-token',setupConfig),config,setupFile:join(setupConfig,'setup-token')};
}

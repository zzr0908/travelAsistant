import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { backupDatabase } from '../dist/server/storage/maintenance.js';
import { appSecrets } from '../dist/server/service/server/runtime-config.js';
const root=resolve(import.meta.dirname,'..'),home=resolve(process.env.TRAVEL_INSTALL_DIR || join(homedir(),'Library/Application Support/TravelAssistant'));
const dry=process.argv.includes('--no-start');
if(process.platform!=='darwin')throw Error('Native background installation requires macOS');
mkdirSync(home,{recursive:true,mode:0o700});
const config=join(home,'config'),data=join(home,'data'),agentData=join(home,'agent-data'),logs=join(home,'logs');
for(const directory of [config,data,agentData,logs,join(home,'releases')])mkdirSync(directory,{recursive:true,mode:0o700});
process.env.TRAVEL_CONFIG_DIR=config;appSecrets(data);
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const release=join(home,'releases',`${version}-${Date.now()}`);mkdirSync(release);
// Copy only runtime inputs. Logs, credentials, databases, source QA material and .git never enter an installation.
for(const name of ['dist','config/harness','runtime','scripts/start-agent.mjs','scripts/control.mjs','package.json','node_modules','vendor/deepseek-harness']){
 const destination=join(release,name);mkdirSync(resolve(destination,'..'),{recursive:true});
 cpSync(join(root,name),destination,{recursive:true,verbatimSymlinks:true,filter:path=>!path.endsWith('/.git')});
}
// Pin the actual Node binary used by LaunchAgents, independent of shell and future PATH changes.
mkdirSync(join(release,'bin'));cpSync(process.execPath,join(release,'bin/node'));
if(spawnSync(join(release,'bin/node'),['--version'],{stdio:'pipe'}).status!==0){rmSync(release,{recursive:true,force:true});throw Error('当前 Node 依赖机器外部动态库。请使用 bash scripts/install.sh 安装固定官方运行时。');}
const envFile=join(config,'local.env');
if(!existsSync(envFile))writeFileSync(envFile,'# 选填：普通模型密钥；修改后运行 travel restart\nZHIPU_API_KEY=\nCARD_API_KEY=\nBROWSER_ENABLED=1\nHOST=127.0.0.1\nPORT=4317\nINTERNAL_PORT=4319\n',{mode:0o600,flag:'wx'});
const localEnv=parseEnv(readFileSync(envFile,'utf8'));
const current=join(home,'current');
function launch(args,allow=false){const r=spawnSync('launchctl',args,{stdio:'inherit'});if(r.status&&!allow)throw Error(`launchctl ${args[0]} failed`);}
const domain=`gui/${process.getuid()}`,labels=['com.travelassistant.app','com.travelassistant.agent'];
const launchDir=dry?join(home,'launchagents'):join(homedir(),'Library/LaunchAgents');mkdirSync(launchDir,{recursive:true});
if(!dry){
  for(const label of labels)launch(['bootout',`${domain}/${label}`],true);
  if(existsSync(join(data,'travel.db'))){const backups=join(home,'backups');mkdirSync(backups,{recursive:true,mode:0o700});await backupDatabase(join(data,'travel.db'),join(backups,`before-${version}-${Date.now()}.db`));}
}
const link=join(home,'current-next');rmSync(link,{force:true});symlinkSync(release,link);renameSync(link,current);
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
for(const [index,label] of labels.entries()){
 const service=index?'agent':'app',entry=index?'scripts/start-agent.mjs':'dist/server/service/server/main.js';
 const env={PATH:`${join(current,'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,TRAVEL_ENV_FILE:envFile,TRAVEL_CONFIG_DIR:config,DATA_DIR:data,AGENT_DATA_DIR:agentData,TRAVEL_SERVICE_TOKEN_FILE:join(config,'service-token'),APP_INTERNAL_URL:`http://127.0.0.1:${localEnv.INTERNAL_PORT || 4319}`};
 const file=join(launchDir,`${label}.plist`);
 writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${esc(join(current,'bin/node'))}</string><string>${esc(join(current,entry))}</string></array><key>WorkingDirectory</key><string>${esc(current)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${esc(join(logs,service+'.log'))}</string><key>StandardErrorPath</key><string>${esc(join(logs,service+'.log'))}</string></dict></plist>`,{mode:0o600});
 if(!dry)launch(['bootstrap',domain,file]);
}
const command=join(home,'travel');
writeFileSync(command,`#!/bin/sh\nexport TRAVEL_INSTALL_DIR=${"'"+home.replaceAll("'","'\\''")+"'"}\nexec "$TRAVEL_INSTALL_DIR/current/bin/node" "$TRAVEL_INSTALL_DIR/current/scripts/control.mjs" "$@"\n`,{mode:0o700});
console.log(`安装完成：${home}\n${dry?'未启动服务（验收模式）':'访问 http://localhost:4317'}\n管理命令："${command}" status\n首次设置凭据："${command}" setup-token\n模型配置：${envFile}`);

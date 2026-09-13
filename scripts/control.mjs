import { readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
const home=resolve(process.env.TRAVEL_INSTALL_DIR || join(homedir(),'Library/Application Support/TravelAssistant'));
const command=process.argv[2] || 'status',domain=`gui/${process.getuid()}`,labels=['com.travelassistant.app','com.travelassistant.agent'];
const run=(cmd,args,optional=false)=>{const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.status&&!optional)process.exitCode=r.status;};
if(command==='setup-token')console.log(readFileSync(join(home,'config/setup-token'),'utf8').trim());
else if(command==='status')for(const label of labels)run('launchctl',['print',`${domain}/${label}`]);
else if(command==='stop')for(const label of labels.toReversed())run('launchctl',['bootout',`${domain}/${label}`],true);
else if(command==='start')for(const label of labels)run('launchctl',['bootstrap',domain,join(homedir(),'Library/LaunchAgents',label+'.plist')]);
else if(command==='restart')for(const label of labels)run('launchctl',['kickstart','-k',`${domain}/${label}`]);
else if(command==='logs'){const service=process.argv[3] || 'app';if(!['app','agent'].includes(service))throw Error('Use app or agent');run('tail',['-n','100','-f',join(home,'logs',service+'.log')]);}
else if(command==='backup'||command==='restore'){
 if(!process.argv[3])throw Error(`Usage: travel ${command} /absolute/path/backup.db`);
 const script=join(home,'current/dist/server/storage/maintenance.js');
 const {backupDatabase,restoreDatabase}=await import(pathToFileURL(script).href);
 console.log(command==='backup'?await backupDatabase(join(home,'data/travel.db'),resolve(process.argv[3])):await restoreDatabase(resolve(process.argv[3]),join(home,'data')));
}else throw Error('Commands: start | stop | restart | status | logs [app|agent] | setup-token | backup FILE | restore FILE');

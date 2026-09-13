import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
if(process.platform!=='darwin')throw Error('This regression requires macOS launchd');
const home=resolve(process.env.TRAVEL_INSTALL_DIR),dir=mkdtempSync(join(tmpdir(),'travel-launchd-'));
const domain=`gui/${process.getuid()}`,labels=['app','agent'].map(s=>`com.travelassistant.regression.${process.pid}.${s}`);
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const [appPort,internalPort,agentPort]=await Promise.all([port(),port(),port()]);
try{
 for(const [i,service] of ['app','agent'].entries()){
  let xml=readFileSync(join(home,'launchagents',`com.travelassistant.${service}.plist`),'utf8').replace(`com.travelassistant.${service}`,labels[i]);
  xml=xml.replace(/<key>APP_INTERNAL_URL<\/key><string>[^<]*<\/string>/,`<key>APP_INTERNAL_URL</key><string>http://127.0.0.1:${internalPort}</string>`);
  xml=xml.replace('<key>EnvironmentVariables</key><dict>',`<key>EnvironmentVariables</key><dict><key>PORT</key><string>${appPort}</string><key>INTERNAL_PORT</key><string>${internalPort}</string><key>AGENT_HEALTH_PORT</key><string>${agentPort}</string><key>BROWSER_ENABLED</key><string>0</string>`);
  const file=join(dir,service+'.plist');writeFileSync(file,xml);
  assert.equal(spawnSync('plutil',['-lint',file],{stdio:'pipe'}).status,0);
  const launched=spawnSync('launchctl',['bootstrap',domain,file],{encoding:'utf8'});assert.equal(launched.status,0,launched.stderr);
 }
 for(let i=0;i<150;i++){
  try{if((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok && (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok)break;}catch{}
  if(i===149)assert.fail('Isolated LaunchAgents did not become healthy');
  await new Promise(r=>setTimeout(r,100));
 }
 console.log('PASS: relocated native installation, valid plists, two isolated launchd jobs start and connect; no default services or live database modified.');
}finally{
 for(const label of labels.reverse())spawnSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});
 rmSync(dir,{recursive:true,force:true});
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
process.env.npm_config_cache ||= resolve(root,'.cache/npm');
const pin=JSON.parse(readFileSync(resolve(root,'vendor/deepseek-harness.lock.json'),'utf8'));
const harness=resolve(root,pin.checkoutPath);
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,stdio:'inherit'});if(result.status!==0)throw new Error(`${command} failed (${result.status})`);}
if(!existsSync(resolve(harness,'.git'))){run('git',['clone','--filter=blob:none','--no-checkout',pin.repository,harness]);run('git',['checkout','--detach',pin.revision],harness);}
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:harness,encoding:'utf8'});if(revision.stdout.trim()!==pin.revision)throw new Error('Harness revision differs from the reviewed pin; preserve your checkout and resolve it before installing.');
if(!process.argv.includes('--skip-install'))run('npm',['ci']);
run('npx',['--yes',pin.packageManager,'install','--frozen-lockfile','--store-dir',resolve(root,'.cache/pnpm-store')],harness);
run(process.execPath,['scripts/prepare-harness-app.mjs','--build']);
run('npm',['run','build']);

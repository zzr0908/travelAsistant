import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const result=spawnSync('git',['ls-files','-z'],{encoding:'utf8'});assert.equal(result.status,0);
const files=result.stdout.split('\0').filter(Boolean);
for(const file of files){
 assert.ok(!/(^|\/)(\.cache|data|data-agent|output|tmp)(\/|$)|\.db(?:-wal|-shm)?$/.test(file),`Private runtime artifact: ${file}`);
 assert.ok(!/(^|\/)\.env(?:$|\.)/.test(file)||file==='.env.example',`Credential file: ${file}`);
 const body=readFileSync(file).toString('utf8');
 assert.ok(!/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|sk-[A-Za-z0-9]{30,}/.test(body),`Potential credential: ${file}`);
}
console.log(`PASS: ${files.length} tracked project files; runtime data and obvious credential formats excluded.`);

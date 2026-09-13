import ts from 'typescript';
import { readFileSync,readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const runtimeFiles=[...readdirSync(join(root,'src/agent/runtime')).filter(p=>p.endsWith('.ts')).map(p=>'src/agent/runtime/'+p),'src/agent/browser/engine.ts','src/agent/browser/memory-store.ts','src/agent/browser/chrome.ts'];
for(const path of runtimeFiles){
 const ast=ts.createSourceFile(path,readFileSync(join(root,path),'utf8'),ts.ScriptTarget.Latest,true);
 for(const node of ast.statements){
  if(!ts.isImportDeclaration(node)||!ts.isStringLiteral(node.moduleSpecifier))continue;
  if(node.importClause?.isTypeOnly)continue;
  const name=node.moduleSpecifier.text;
  if(/(?:storage|service|execution|cards)\//.test(name)||name==='better-sqlite3')throw Error(`${path}: worker must not import app implementation (${name})`);
 }
}
for(const file of readdirSync(join(root,'config/harness/worker'))){const body=readFileSync(join(root,'config/harness/worker',file),'utf8');if(/storage\/|openDatabase|better-sqlite3/.test(body))throw Error(`Worker plugin ${file} depends on app storage`);}
console.log('PASS: Agent runtime and Harness worker plugins have no runtime imports of app domain or SQLite.');

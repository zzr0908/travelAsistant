// Read-only evidence export. Contains no model/network dispatch.
import Database from 'better-sqlite3';import{readFileSync,writeFileSync,mkdirSync,chmodSync}from'node:fs';import{createHash}from'node:crypto';import{resolve}from'node:path';
const sha=x=>createHash('sha256').update(x).digest('hex');
const db=new Database(process.argv[2]||'.cache/agent-live/travel.db',{readonly:true});
const dir=resolve('.cache/agent-acceptance');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const notes={
 '9a54b0c9-2ed1-489b-a5ba-1095a0864b67':['AP03','passed_developer','Notes field retest after schema descriptions; only notes changed in preview, UI rejected without formal write.'],
 '7340813f-a17f-4d2e-b019-7b15b96bc869':['preflight','partial','Model response succeeded; initial persistence event-routing gap. No complete Harness trace.'],
 'b39c3104-461c-493c-9846-9027510cf042':['AS01','failed','Browser schema discriminator produced empty arguments; cancelled. Initial Harness trace gap retained.'],
 'b0b498f2-4df7-4212-b57c-387bbe447b9a':['AS01','failed','Persistence service was accessed from wrong context; no outbound request.'],
 '5b9f7331-c621-4a4f-92cc-d8de477f6563':['AS01','failed','Repeated invalid browser arguments; cancelled.'],
 '939fc7bc-8bfa-4b06-8fdf-e3164908b92d':['AS01','failed','Timeout; invalid proposal structure and source quotation.'],
 '14052404-8d17-4f1a-a8bd-0f0cb0331b9b':['AS01','failed','Token dispatch threshold; whitespace/escaped-newline source matching issue.'],
 '8e29da51-340c-430c-99f5-0e75ebde624b':['AS01','failed_quality','Ticket restrictions generalized across ticket types; UI rejected without plan write.'],
 'ff10da9f-3642-4f49-8024-466d0d6b6fdc':['AS01','passed_developer','UI adopted date-unset two-day guide; four views checked; original output retained.'],
 '65b246a2-f650-4378-8ab7-48e3ad8ff065':['AS02','passed_developer','Scoped relaxation adopted and undone; fixed/outside nodes and two-member progress unchanged.'],
 '80f2e5ef-b48a-4cc7-9475-f6bad2a76261':['AS04','failed_quality','Invented source URL and wrong notice/date association; overly permissive cafe advice.'],
 '68ecf5c5-164b-4a7c-96f2-beb907aabb62':['AS04','failed_quality','Cafe opening hours treated as sufficient for after-museum-closing visit.'],
 '77a911d3-8bf3-4af8-8a68-ac8711363b84':['AS04','passed_developer','Read three official pages; ticket-specific obligation, expired 2025 notice and unknown cafe access identified. Optional follow-up unnecessary but no write.'],
 '3f6a06af-6554-419d-ae0a-596c31c704ed':['AS04','passed_developer','Explicit UI answer ended research without additional browsing or plan modification.'],
 'fab271de-1a14-4e0c-b5b3-6050cfb4b878':['AS03','passed_developer','Two distinct preparation candidates; required selection persisted and answered through candidate button.'],
 '6aebde88-8b62-4520-8644-0457bd3b86ce':['AS03','failed_quality','Generated minimal checklist but incorrectly claimed existing preparation could not be associated; not adopted.'],
 '7b2474b5-bf99-4c99-92e7-888b75b8046a':['AS03','passed_developer','After tool schema clarification, correct association plus minimal checklist; UI adopted/undone and peer confirmed; private preference absent.'],
};
const runs=[];
for(const r of db.prepare('SELECT * FROM agent_runs ORDER BY rowid').all()){
 const events=db.prepare('SELECT * FROM agent_events WHERE run_id=? ORDER BY seq').all(r.id);
 const h=db.prepare('SELECT * FROM harness_sessions WHERE id=?').get(r.id);
 const he=db.prepare('SELECT * FROM harness_events WHERE session_id=? ORDER BY seq').all(r.id);
 const qs=db.prepare('SELECT q.* FROM browser_queries q JOIN agent_browser_queries a ON a.query_id=q.id WHERE a.run_id=? ORDER BY q.rowid').all(r.id);
 const p=db.prepare('SELECT * FROM agent_proposals WHERE run_id=?').get(r.id);
 const raw=JSON.stringify({run:r,events,harnessSession:h,harnessEvents:he,browserQueries:qs,proposal:p},null,2)+'\n';const path=resolve(dir,r.id+'.json');writeFileSync(path,raw,{mode:0o600});chmodSync(path,0o600);
 const detail=notes[r.id]||['AP22','passed_ui_only','Supplemental UI preview/adopt/undo; see UI evidence. The 1440px run used description for an ambiguous notes request; field descriptions were clarified and separately retested.'];
 const queries=qs.map(q=>{const x=q.result?JSON.parse(q.result):null;return{id:q.id,status:q.state,url:x?.data?.url||null,textHash:x?.data?.textHash||null,textChars:x?.data?.text?.length||0,textRange:x?.data?.textRange||null,missing:x?.missing||[]};});
 runs.push({id:r.id,scenario:detail[0],reviewStatus:detail[1],review:detail[2],createdAt:r.created,updatedAt:r.updated,elapsedMs:Date.parse(r.updated)-Date.parse(r.created),state:r.state,requestedModel:'glm-5.3-flash',usage:JSON.parse(r.usage),sourceQueries:queries,appEvents:events.length,harnessEvents:he.length,harnessSequenceValid:he.every((e,i)=>e.seq===i&&sha(e.body)===e.sha256),completeHarnessTrace:he.length>0,promptRevision:he.find(e=>JSON.parse(e.body).type==='user/message')?sha(he.find(e=>JSON.parse(e.body).type==='user/message').body):null,proposal:p?{id:p.id,revision:p.revision,workspaceId:p.workspace_id,changeId:p.change_id}:null,privateArtifact:path,artifactSha256:sha(raw)});
}
const manifest=JSON.parse(readFileSync('.cache/harness-artifacts.json','utf8'));
const report={timestamp:new Date().toISOString(),method:'Actual application UI -> built Harness -> GLM-5.3-Flash; read-only export of all runs, including failures',harnessRevision:manifest.revision,mode:'explicit_development_coding_plan',ordinaryDeploymentCredentialReady:false,cost:{amount:null,status:'not_measured'},runs,totals:{runs:runs.length,modelRequests:runs.reduce((n,r)=>n+r.usage.modelRequests,0),browserQueries:runs.reduce((n,r)=>n+r.usage.browserQueries,0),knownReportedTokenSubtotal:runs.reduce((n,r)=>n+(r.usage.tokens||0),0),usageUnknownRunIds:runs.filter(r=>r.usage.tokens===null).map(r=>r.id),reportedTokens:runs.every(r=>r.usage.tokens!==null)?runs.reduce((n,r)=>n+r.usage.tokens,0):null},revisionFiles:Object.fromEntries(['src/agent/service.ts','src/shared/agent.ts','src/agent/proposals.ts','src/service/client/AgentPanel.tsx','config/harness/travel/driver.mjs','config/harness/travel/persistence.mjs'].map(p=>[p,sha(readFileSync(p))]))};
mkdirSync('docs/qa/agent-integration',{recursive:true});writeFileSync('docs/qa/agent-integration/live-runs.json',JSON.stringify(report,null,2)+'\n');console.log({runs:runs.length,totals:report.totals,privateDirectory:dir});db.close();

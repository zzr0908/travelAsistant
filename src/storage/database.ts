import Database from "better-sqlite3";
import { migrateExecution } from "./execution.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(filename: string) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 8) {
    db.close();
    throw new Error("数据版本高于当前应用，请使用较新版本。");
  }
  if (version === 0)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE workspaces(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),version INTEGER NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE members(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','editor','reader')),PRIMARY KEY(workspace_id,user_id));
      CREATE INDEX idx_members_user ON members(user_id,workspace_id);
      CREATE TABLE invites(token_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),role TEXT NOT NULL CHECK(role IN ('editor','reader')),expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE changes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_body TEXT NOT NULL,label TEXT NOT NULL,before_data TEXT NOT NULL,after_versions TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL,undone_by TEXT,UNIQUE(user_id,request_id));
      PRAGMA user_version = 1;
    `);
    })();
  if (version < 2)
    db.transaction(() => {
      db.exec(`
        CREATE TABLE browser_queries(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL,
          result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL,
          UNIQUE(owner_id,request_id)
        );
        CREATE INDEX idx_browser_queries_owner ON browser_queries(owner_id,created);
        CREATE TABLE browser_artifacts(
          id TEXT PRIMARY KEY, query_id TEXT NOT NULL REFERENCES browser_queries(id),
          owner_id TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
          bytes BLOB NOT NULL, created TEXT NOT NULL
        );
        PRAGMA user_version = 2;
      `);
    })();
  if (version < 3)
    db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),workspace_id TEXT REFERENCES workspaces(id),node_id TEXT,title TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE INDEX idx_agent_sessions_owner ON agent_sessions(owner_id,updated);
        CREATE TABLE agent_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,parent_run_id TEXT REFERENCES agent_runs(id),scope TEXT NOT NULL,context TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,usage TEXT NOT NULL,output TEXT,question_answer TEXT,answer_run_id TEXT REFERENCES agent_runs(id),cancel_requested INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(owner_id,request_id));
        CREATE UNIQUE INDEX idx_agent_active_owner ON agent_runs(owner_id) WHERE state IN ('queued','running','cancelling');
        CREATE TABLE agent_events(run_id TEXT NOT NULL REFERENCES agent_runs(id),seq INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(run_id,seq));
        CREATE TABLE agent_proposals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),revision INTEGER NOT NULL,digest TEXT NOT NULL,base_version INTEGER,workspace_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,change_id TEXT REFERENCES changes(id),created TEXT NOT NULL);
        CREATE TABLE agent_apply_requests(owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,proposal_id TEXT NOT NULL REFERENCES agent_proposals(id),result TEXT NOT NULL,PRIMARY KEY(owner_id,request_id));
        CREATE TABLE agent_published_claims(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES agent_proposals(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),query_id TEXT REFERENCES browser_queries(id),body TEXT NOT NULL,dependencies TEXT NOT NULL,created TEXT NOT NULL);
        CREATE TABLE agent_browser_queries(query_id TEXT PRIMARY KEY REFERENCES browser_queries(id),run_id TEXT NOT NULL REFERENCES agent_runs(id),owner_id TEXT NOT NULL REFERENCES users(id));
        CREATE TABLE harness_sessions(id TEXT PRIMARY KEY REFERENCES agent_runs(id),header TEXT NOT NULL,inherited_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE harness_events(session_id TEXT NOT NULL REFERENCES harness_sessions(id),seq INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(session_id,seq));
        PRAGMA user_version = 3;
      `);
    })();
  if (version < 4) db.transaction(() => {
    db.exec(`
      CREATE TABLE media_assets(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        query_id TEXT NOT NULL REFERENCES browser_queries(id), identity TEXT NOT NULL,
        metadata TEXT NOT NULL, sha256 TEXT, thumbnail_sha256 TEXT, bytes BLOB, thumbnail BLOB,
        UNIQUE(owner_id, identity)
      );
      CREATE TABLE agent_run_media(run_id TEXT NOT NULL REFERENCES agent_runs(id), media_id TEXT NOT NULL REFERENCES media_assets(id), PRIMARY KEY(run_id,media_id));
      PRAGMA user_version = 4;
    `);
  })();
  if (version < 5) db.transaction(() => {
    db.exec(`
      CREATE TABLE map_queries(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),workspace_id TEXT REFERENCES workspaces(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,cache_key TEXT NOT NULL,input TEXT NOT NULL,result TEXT,created TEXT NOT NULL,UNIQUE(owner_id,request_id));
      CREATE INDEX idx_map_queries_cache ON map_queries(owner_id,cache_key,created);
      CREATE TABLE spatial_assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),query_id TEXT NOT NULL REFERENCES map_queries(id),identity TEXT NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,UNIQUE(owner_id,identity));
      CREATE TABLE agent_map_queries(run_id TEXT NOT NULL REFERENCES agent_runs(id),query_id TEXT NOT NULL REFERENCES map_queries(id),PRIMARY KEY(run_id,query_id));
      CREATE TABLE map_usage(day TEXT PRIMARY KEY,credits REAL NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version = 5;
    `);
  })();
  // v6 requires note-aware media permissions, history and backup readers.
  // Keep historical JSON and proposal digests intact; conversion is a reversible command.
  if (version < 6) db.pragma('user_version = 6');
  if(version<7)db.transaction(()=>db.exec(`
    CREATE TABLE card_drafts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,expires INTEGER NOT NULL,UNIQUE(owner_id,request_id));
    PRAGMA user_version=7;
  `))();
  if(version<8)migrateExecution(db);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;

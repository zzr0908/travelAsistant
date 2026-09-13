import type { DB } from './database.js';
import { ensure } from '../service/domain/validation.js';
import { digest } from '../shared/hash.js';

export const executionTables = ['execution_jobs', 'execution_receipts', 'execution_blobs'];
export function migrateExecution(db: DB) {
  db.transaction(() => db.exec(`
    CREATE TABLE execution_jobs(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, worker_id TEXT, lease TEXT, lease_until INTEGER,
      affinity TEXT, deadline INTEGER NOT NULL, created INTEGER NOT NULL,
      result TEXT, error TEXT
    );
    CREATE INDEX idx_execution_queue ON execution_jobs(state,created);
    CREATE TABLE execution_receipts(
      job_id TEXT NOT NULL REFERENCES execution_jobs(id), operation_id TEXT NOT NULL,
      hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(job_id,operation_id)
    );
    CREATE TABLE execution_blobs(
      job_id TEXT NOT NULL REFERENCES execution_jobs(id), name TEXT NOT NULL,
      bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(job_id,name)
    );
    PRAGMA user_version=8;
  `))();
}
export function inspectExecutionBackup(db: DB) {
  for (const row of db.prepare('SELECT * FROM execution_jobs').all() as any[]) {
    ensure(['research','browser','image','release'].includes(row.kind), '执行任务类型无效');
    ensure(['queued','running','completed','failed','cancelled','interrupted'].includes(row.state), '执行任务状态无效');
    ensure(Number.isSafeInteger(row.deadline) && Number.isSafeInteger(row.created) && row.deadline >= row.created, '执行任务期限无效');
    JSON.parse(row.payload); if (row.result) JSON.parse(row.result);
    ensure(row.state !== 'running' || (row.worker_id && row.lease && Number.isSafeInteger(row.lease_until)), '执行租约无效');
  }
  for (const row of db.prepare('SELECT * FROM execution_receipts').all() as any[]) {
    ensure(/^[a-f0-9]{64}$/.test(row.hash), '执行回执摘要无效'); JSON.parse(row.result);
  }
  for (const row of db.prepare('SELECT * FROM execution_blobs').all() as any[]) {
    ensure(row.bytes.length <= 16 * 1024 * 1024 && digest(row.bytes) === row.sha256, '执行附件摘要无效');
  }
}

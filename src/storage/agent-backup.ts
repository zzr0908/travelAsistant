import type Database from 'better-sqlite3';
import { ensure, validateData } from '../service/domain/validation.js';
import { agentOutput, claimSchema } from '../shared/agent.js';
import { digest } from '../shared/hash.js';
import { browserResult } from '../shared/browser-model.js';
import vocabulary from '../shared/harness-event-types.json' with { type: 'json' };
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { MapStore } from '../maps/store.js';
import { spatialEvidenceText } from '../shared/maps.js';

export function harnessValidator() {
  const root = existsSync(resolve(import.meta.dirname, '../../package.json')) ? resolve(import.meta.dirname, '../..') : resolve(import.meta.dirname, '../../..');
  const bundled = resolve(root, 'runtime/harness-validator.cjs');
  if(existsSync(bundled))return createRequire(import.meta.url)(bundled) as { validateStoredEvents(header: unknown, events: unknown[]): unknown };
  const manifestPath = resolve(root, '.cache/harness-artifacts.json');
  ensure(existsSync(manifestPath), '恢复 Harness 日志前请先运行 npm run harness:prepare');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const artifact = manifest.packages['@deepseek-ai/dsh-session-persistence'];
  ensure(artifact && digest(readFileSync(artifact.entry)) === artifact.sha256, 'Harness 校验器构建摘要不匹配');
  return createRequire(import.meta.url)(artifact.entry) as { validateStoredEvents(header: unknown, events: unknown[]): unknown };
}

export const agentTables = ['agent_sessions', 'agent_runs', 'agent_events', 'agent_proposals', 'agent_apply_requests', 'agent_published_claims', 'agent_browser_queries', 'harness_sessions', 'harness_events'];
export function inspectAgentBackup(db: Database.Database) {
  const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
  for (const run of rows<{ id: string; owner_id: string; session_owner: string; state: string; scope: string; context: string; usage: string; output: string | null }>('SELECT r.*,s.owner_id AS session_owner FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id')) {
    ensure(run.owner_id === run.session_owner, '研究会话归属无效');
    ensure(['queued','running','needs_input','completed','partial','cancelling','cancelled','failed','interrupted'].includes(run.state), '研究状态无效');
    const scope = JSON.parse(run.scope), context = JSON.parse(run.context), usage = JSON.parse(run.usage);
    ensure(scope && context && typeof context.scopeLabel === 'string', '研究上下文无效');
    ensure(Number.isSafeInteger(usage.modelRequests) && usage.modelRequests >= 0 && Number.isSafeInteger(usage.browserQueries) && usage.browserQueries >= 0, '研究用量无效');
    if (context.base) validateData(context.base.data);
    if (run.output) {
      const saved = JSON.parse(run.output); agentOutput.parse(saved.output);
      for (const claim of saved.claims) inspectClaim(claim, run.owner_id);
      if (saved.proposal) validateData(saved.proposal.workspace.data);
    }
    const events = db.prepare('SELECT seq,data FROM agent_events WHERE run_id=? ORDER BY seq').all(run.id) as { seq: number; data: string }[];
    events.forEach((event, i) => { ensure(event.seq === i, '研究事件序号不连续'); JSON.parse(event.data); });
  }
  function inspectClaim(claim: Record<string, unknown>, owner?: string) {
    const { url: _url, retrievedAt: _time, textHash: _hash, limitations: _limits, ...fields } = claim;
    const parsed = claimSchema.parse(fields);
    if (parsed.spatialEvidence) {
      ensure(!parsed.queryId && !parsed.quote, '地图字段证据不能绑定网页原文');
      const asset = new MapStore(db).verifyEvidence(parsed.spatialEvidence);
      ensure(parsed.text === spatialEvidenceText(asset, parsed.spatialEvidence) && claim.url === asset.source.url && claim.retrievedAt === asset.source.retrievedAt && parsed.status === (['suggestion','manual'].includes(asset.source.provider) ? 'suggestion' : 'source_supported'), '地图字段主张与来源不一致');
      return;
    }
    if (parsed.status !== 'source_supported') return;
    const row = db.prepare('SELECT owner_id,result FROM browser_queries WHERE id=?').get(parsed.queryId) as { owner_id: string; result: string } | undefined;
    ensure(row && (!owner || row.owner_id === owner), '事实来源引用或归属无效');
    const result = browserResult.parse(JSON.parse(row.result));
    ensure(result.data && parsed.quote && result.data.text.includes(parsed.quote) && result.data.textHash === claim.textHash && result.data.url === claim.url, '事实片段与来源不一致');
  }
  for (const p of rows<{ body: string; digest: string; base_version: number | null; workspace_id: string; owner_id: string }>('SELECT p.*,r.owner_id FROM agent_proposals p JOIN agent_runs r ON r.id=p.run_id')) {
    ensure(digest(p.body) === p.digest, '提议哈希校验失败');
    const body = JSON.parse(p.body); validateData(body.workspace.data);
    ensure(body.workspace.id === p.workspace_id && body.workspace.ownerId === (body.before?.ownerId || p.owner_id) && (body.before?.version ?? null) === p.base_version, '提议上下文或归属无效');
    if (body.before) validateData(body.before.data);
    for (const claim of body.claims) inspectClaim(claim, p.owner_id);
  }
  for (const row of rows<{ body: string; dependencies: string; query_id: string | null }>('SELECT body,dependencies,query_id FROM agent_published_claims')) {
    const claim = JSON.parse(row.body); inspectClaim(claim); JSON.parse(row.dependencies);
    ensure((claim.queryId || null) === row.query_id, '共享来源关联无效');
  }
  for (const row of rows<{ owner_id: string; query_owner: string; run_owner: string }>('SELECT a.owner_id,q.owner_id AS query_owner,r.owner_id AS run_owner FROM agent_browser_queries a JOIN browser_queries q ON q.id=a.query_id JOIN agent_runs r ON r.id=a.run_id')) ensure(row.owner_id === row.query_owner && row.owner_id === row.run_owner, '研究查询归属无效');
  for (const row of rows<{ id: string; header: string; inherited_count: number }>('SELECT * FROM harness_sessions')) {
    const header = JSON.parse(row.header);
    ensure(header.id === row.id && header.version === vocabulary.sessionFormat && Number.isSafeInteger(header.createdAt) && header.createdAt >= 0, 'Harness 会话格式不受支持');
    ensure(Number.isSafeInteger(row.inherited_count) && row.inherited_count >= 0 && (header.isSeeded || row.inherited_count === 0), 'Harness 继承序号无效');
    const events = db.prepare('SELECT seq,body,sha256 FROM harness_events WHERE session_id=? ORDER BY seq').all(row.id) as { seq: number; body: string; sha256: string }[];
    events.forEach((row, index) => {
      ensure(row.seq === index && digest(row.body) === row.sha256, 'Harness 日志序号或哈希损坏');
      const event = JSON.parse(row.body);
      ensure(event.seq === index && typeof event.type === 'string' && (vocabulary.events.includes(event.type) || event.ignorable === true), 'Harness 包含未知必需事件');
      ensure(event.data && typeof event.data === 'object' && Number.isSafeInteger(event.time) && event.time >= 0, 'Harness 事件格式无效');
    });
    if (events.length) harnessValidator().validateStoredEvents(header, events.map(row => JSON.parse(row.body)));
  }
}

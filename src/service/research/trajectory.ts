import { MediaStore } from './media.js';
import type { DB } from '../../storage/database.js';
import type { TraceItem, TracePage } from '../../shared/trajectory.js';
import { digest } from '../../storage/browser.js';
import { ensure } from '../domain/validation.js';

const sensitive = /^(?:.*[_-])?(authorization|proxy.authorization|cookie|set.cookie|password|passwd|api.?key|access.?token|refresh.?token|secret|client.?secret|token|credential|credentials)$/i;
const scrub = (value: string): string => value
  .replace(/^(\s*(?:Set-Cookie|Cookie|Authorization|Proxy-Authorization)\s*:\s*)[^\r\n]+/gmi, '$1[已隐藏]')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z\d+/_=.:~-]+/gi, '$1 [已隐藏]')
  .replace(/\b(sk-[a-zA-Z\d_-]{12,})\b/g, '[已隐藏]')
  .replace(/((?:authorization|proxy.authorization|cookie|set.cookie|password|passwd|api.?key|access.?token|refresh.?token|client.?secret|secret|token)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;}\n]+)/gi, '$1[已隐藏]')
  .replace(/https?:\/\/[^\s"<>]+/gi, raw => { try { const u = new URL(raw); if (u.username || u.password) { u.username = ''; u.password = ''; } for (const k of [...u.searchParams.keys()]) if (/(token|session|cookie|password|signature|secret|key|auth|credential)/i.test(k)) u.searchParams.set(k, '[已隐藏]'); return u.href; } catch { return raw; } });
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // Tool results often contain serialized JSON inside a text block.
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed)); } catch { /* ordinary prose */ }
    return scrub(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[已隐藏]' : redact(v)]));
  return value;
}
type RecordItem = { item: TraceItem; raw: unknown; hash?: string };
const titles: Record<string, string> = {
  'map.started': '查找地图内容', 'map.finished': '地图查询结果', 'map.failed': '地图查询未完成',
  'qa.fixture': '可控验收记录（非模型执行）',
  'turn/start': '开始处理需求', 'turn/end': '本轮执行结束', 'step/start': '开始执行步骤', 'step/end': '步骤结束',
  'user/message': '接收需求与上下文', 'request/header': '模型请求配置', 'request/context': '模型上下文配置',
  'assistant/message': '模型返回', 'assistant/attempt': '模型尝试记录', 'tool/call': '调用工具', 'tool/result': '工具返回',
  'model.started': '发起模型请求', 'model.request': '模型完整输入', 'research.started': '开始查阅来源',
  'research.finished': '来源读取结果', 'media.retry': '重新采集图片', 'media.collected': '采集来源图片', 'run.status': '研究状态',
  'result.staged': '保存建议', 'result.ready': '建议已就绪', 'question.ready': '等待你的答复',
  'question.answered': '答复已保存', 'proposal.applied': '采用到正式计划', 'agent/inbox/spliced': '更新消息队列',
};
const toolNames: Record<string,string> = { read_map_data: '查询地点与几何', read_plan_context: '读取计划上下文', read_travel_source: '查阅网页资料', check_plan_draft: '检查变更提议', publish_result: '生成建议与提议' };
const bad = new Set(['failed','interrupted','cancelled','timeout','restricted','unavailable','unsupported','rate_limited','no_match']);
const failedResult = (d: any) => {
  if (d.error || d.reason?.kind === 'error' || bad.has(d.state) || bad.has(d.status)) return true;
  const blocks = (content: any[]): boolean => content.some((c: any) => {
    if (c.isError || c.error || c.type === 'tool-result' && c.result?.kind === 'error') return true;
    if (Array.isArray(c.content) && blocks(c.content)) return true;
    const payload = c.text || c.content || c.result?.text;
    if (typeof payload !== 'string') return false;
    try { const p = JSON.parse(payload); return p.error || bad.has(p.status); } catch { return false; }
  });
  return blocks(d.message?.content || []);
};
export class Trajectory {
  constructor(private db: DB) {}
  revision(runId: string): string {
    // Appended events and later plan edits can change a completed run's trajectory.
    // This lightweight token avoids re-projecting long histories on every UI poll.
    const revision = this.db.prepare(`SELECT
      (SELECT max(seq) FROM agent_events WHERE run_id=?) AS application,
      (SELECT max(seq) FROM harness_events WHERE session_id=?) AS harness,
      (SELECT w.version FROM workspaces w JOIN agent_proposals p ON p.workspace_id=w.id WHERE p.run_id=?) AS plan
    `).get(runId, runId, runId);
    return digest(JSON.stringify(revision));
  }
  private records(runId: string): { records: RecordItem[]; gaps: string[] } {
    const records: RecordItem[] = [], gaps: string[] = [];
    const harness = this.db.prepare('SELECT seq,body,sha256 FROM harness_events WHERE session_id=? ORDER BY seq').all(runId) as {seq: number; body: string; sha256: string}[];
    let expected = 0, step: number | null = null, turn: number | null = null;
    const calls = new Map<string, {time: number; name: string}>();
    for (const row of harness) {
      if (row.seq !== expected) gaps.push(`Harness 序号 ${expected}—${row.seq - 1} 缺失`); expected = row.seq + 1;
      if (digest(row.body) !== row.sha256) gaps.push(`Harness #${row.seq} 校验失败`);
      let raw: any; try { raw = JSON.parse(row.body); } catch { gaps.push(`Harness #${row.seq} 无法解析`); raw = { type: 'unknown', data: { raw: row.body } }; }
      const data = raw.data || {};
      step = data.step ?? step; turn = data.turn ?? turn;
      const callId = data.callId || data.message?.source?.callId || null;
      if (raw.type === 'tool/call') calls.set(callId, {time: raw.time, name: data.name});
      const call = calls.get(callId), detail = redact(raw), unknown = !titles[raw.type];
      if (unknown) gaps.push(`保留未识别事件 ${raw.type} #${row.seq}，可查看原始详情`);
      const error = failedResult(data);
      const terminal = /^(tool\/result|assistant\/message|step\/end|turn\/end)$/.test(raw.type);
      const title = raw.type === 'tool/call' ? toolNames[data.name] || `调用 ${data.name}` : raw.type === 'tool/result' ? `${toolNames[call?.name || ''] || call?.name || '工具'} · 返回` : titles[raw.type] || `未识别事件：${raw.type}`;
      records.push({ item: { id: `h:${row.seq}`, origin: 'harness', seq: row.seq, type: raw.type, title, time: new Date(raw.time || 0).toISOString(), step, turn, status: error ? 'error' : unknown ? 'warning' : terminal ? 'success' : 'info', summary: error ? '发生错误，展开查看原始记录' : data.usage ? `${data.usage.totalTokens ?? '未知'} tokens` : callId ? (call?.name || data.name || '') : '', callId, durationMs: raw.type === 'tool/result' && call ? Math.max(0, raw.time - call.time) : null, detailBytes: Buffer.byteLength(JSON.stringify(detail)), internal: ['step/start','step/end','turn/start','turn/end','request/header','request/context','agent/inbox/spliced','tool/result'].includes(raw.type) }, raw: detail, hash: row.sha256 });
    }
    for (const r of records) if (r.item.type === 'tool/call') {
      const result = records.find(x => x.item.type === 'tool/result' && x.item.callId === r.item.callId);
      if (result) { r.item.status = result.item.status; r.item.durationMs = result.item.durationMs; if(result.item.status === 'error')r.item.summary = '调用未成功，展开查看原始错误与输入'; }
      else { const state = (this.db.prepare('SELECT state FROM agent_runs WHERE id=?').get(runId) as {state:string}).state; r.item.status = ['queued','running','cancelling'].includes(state) ? 'running' : 'warning'; r.item.summary = '尚未记录工具返回'; }
    }
    const application = this.db.prepare('SELECT seq,type,data,created FROM agent_events WHERE run_id=? ORDER BY seq').all(runId) as {seq: number; type: string; data: string; created: string}[];
    expected = 0;
    for (const r of application) {
      if (r.seq !== expected) gaps.push(`应用事件序号 ${expected}—${r.seq - 1} 缺失`); expected = r.seq + 1;
      const d: any = redact(JSON.parse(r.data));
      if (!titles[r.type]) gaps.push(`保留未识别应用事件 ${r.type} #${r.seq}`);
      records.push({ item: { id: `a:${r.seq}`, origin: 'application', seq: r.seq, type: r.type, title: titles[r.type] || `应用事件：${r.type}`, time: r.created, step: null, turn: null, status: failedResult(d) ? 'error' : d.state === 'partial' || ['partial','ambiguous'].includes(d.status) ? 'warning' : d.state === 'running' || d.state === 'queued' || d.state === 'cancelling' ? 'running' : 'info', summary: d.message || (r.type === 'research.finished' ? `${d.title || '网页'} · ${d.status}` : ''), callId: r.type.startsWith('map.') ? d.requestId || null : null, durationMs: d.durationMs ?? null, detailBytes: Buffer.byteLength(JSON.stringify(d)), internal: ['run.status','model.started','research.started','research.finished','media.collected','result.staged'].includes(r.type) }, raw: { type: r.type, seq: r.seq, createdAt: r.created, data: d } });
    }
    const proposal = this.db.prepare('SELECT id,workspace_id,change_id,base_version,status FROM agent_proposals WHERE run_id=?').get(runId) as any;
    if (proposal) {
      const changes = this.db.prepare("SELECT id,label,request_body,after_versions,result,created,undone_by FROM changes WHERE id=? OR id=(SELECT undone_by FROM changes WHERE id=?) OR (json_extract(request_body,'$.kind')='media' AND EXISTS(SELECT 1 FROM json_each(after_versions) WHERE key=?)) OR id IN (SELECT undone_by FROM changes WHERE json_extract(request_body,'$.kind')='media' AND EXISTS(SELECT 1 FROM json_each(after_versions) WHERE key=?)) ORDER BY rowid").all(proposal.change_id, proposal.change_id, proposal.workspace_id, proposal.workspace_id) as any[];
      for (const c of changes) records.push({ item: { id: `c:${c.id}`, origin: 'change', seq: null, type: 'plan.change', title: c.label, time: c.created, step: null, turn: null, status: 'success', summary: c.undone_by ? '此变更已撤销' : `版本 ${Object.values(JSON.parse(c.after_versions)).join('、')}`, callId: null, durationMs: null, detailBytes: JSON.stringify(c).length, internal: false }, raw: redact({ ...c, request: JSON.parse(c.request_body), versions: JSON.parse(c.after_versions), result: JSON.parse(c.result), proposalId: proposal.id, baseVersion: proposal.base_version, association: c.id === proposal.change_id || c.id === (changes.find(x => x.id === proposal.change_id)?.undone_by) ? 'this_proposal' : 'same_workspace_media_change' }) });
    }
    // The sort is stable for equal times; the immutable sequence remains visible.
    records.sort((a,b) => a.item.time.localeCompare(b.item.time) || (a.item.origin === b.item.origin ? (a.item.seq || 0) - (b.item.seq || 0) : a.item.origin.localeCompare(b.item.origin)));
    let currentStep: number | null = null, currentTurn: number | null = null;
    for (const r of records) {
      if (r.item.type === 'model.request') { const response = records.find(x => x.item.type === 'assistant/message' && x.item.time >= r.item.time); r.item.step = response?.item.step || null; r.item.turn = response?.item.turn || null; }
      if (r.item.origin === 'harness' && r.item.step) {currentStep = r.item.step;currentTurn = r.item.turn;}
      if (r.item.origin === 'application' && !r.item.step && r.item.type !== 'model.request') {r.item.step = currentStep;r.item.turn = currentTurn;}
    }
    return { records, gaps };
  }
  page(runId: string, options: { offset?: number; q?: string; filter?: string } = {}): TracePage {
    const { records, gaps } = this.records(runId);
    const run = this.db.prepare('SELECT state,created,updated,output FROM agent_runs WHERE id=?').get(runId) as any;
    const queries = this.queries(runId), output = run.output ? JSON.parse(run.output) : null;
    const q = (options.q || '').toLocaleLowerCase();
    const selected = records.filter(r => (!q || `${r.item.title}\n${JSON.stringify(r.raw)}`.toLocaleLowerCase().includes(q)) && (options.filter === 'all' || options.filter === 'errors' ? options.filter === 'all' || ['error','warning'].includes(r.item.status) : options.filter === 'model' ? /model\.|assistant\/|request\//.test(r.item.type) : options.filter === 'tools' ? /tool\/|research\.|media\.|map\./.test(r.item.type) : options.filter === 'changes' ? r.item.origin === 'change' || /proposal\./.test(r.item.type) : (!r.item.internal || ['error','warning'].includes(r.item.status))));
    const offset = options.offset || 0, end = offset + 40;
    return { items: selected.slice(offset,end).map(r => r.item), total: records.length, matching: selected.length, nextOffset: end < selected.length ? end : null, gaps, durationMs: Math.max(0, Date.parse(['queued','running','cancelling'].includes(run.state) ? new Date().toISOString() : run.updated) - Date.parse(run.created)), hasRequestSnapshot: records.some(r => r.item.type === 'model.request'), counts: { harness: records.filter(r => r.item.origin === 'harness').length, application: records.filter(r => r.item.origin === 'application').length, changes: records.filter(r => r.item.origin === 'change').length, errors: records.filter(r => r.item.status === 'error').length, queries: queries.length, pages: queries.filter(q => ['ok','partial'].includes(q.result?.status) && q.result?.data?.contentKind === 'page').length, failedQueries: queries.filter(q => !q.result || !['ok','partial'].includes(q.result.status)).length, mapQueries: this.mapQueries(runId).length, claims: output?.claims?.filter((c: any) => c.status === 'source_supported').length || 0, media: new MediaStore(this.db).run(runId).filter(m => m.status === 'ready').length } };
  }
  detail(runId: string, eventId: string) {
    const { records } = this.records(runId), r = records.find(r => r.item.id === eventId); ensure(r, '找不到轨迹记录', 404);
    return { item: r.item, record: r.raw, mapQueries: this.mapQueries(runId).filter(q => JSON.stringify(r.raw).includes(q.queryId)), queries: r.item.callId ? this.queries(runId).filter(q => JSON.stringify(records.filter(x => x.item.callId === r.item.callId).map(x => x.raw)).includes(q.queryId)).map(redact) : [], related: r.item.callId ? records.filter(x => x !== r && x.item.callId === r.item.callId).map(x => ({ id: x.item.id, record: x.raw })) : [], redaction: '凭据、Cookie 和敏感 URL 参数已隐藏；其余已保存内容完整呈现。', originalSha256: r.hash || null };
  }
  private mapQueries(runId: string) { return (this.db.prepare('SELECT q.id,q.input,q.result FROM map_queries q JOIN agent_map_queries a ON a.query_id=q.id WHERE a.run_id=? ORDER BY q.rowid').all(runId) as {id:string;input:string;result:string|null}[]).map(q => ({queryId:q.id,input:JSON.parse(q.input),result:q.result ? JSON.parse(q.result) : null})); }
  private queries(runId: string) { return (this.db.prepare('SELECT q.id,q.input,q.result FROM browser_queries q JOIN agent_browser_queries a ON a.query_id=q.id WHERE a.run_id=? ORDER BY q.rowid').all(runId) as {id: string; input: string; result: string | null}[]).map(r => ({queryId: r.id, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null})); }
  export(runId: string) {
    const { records, gaps } = this.records(runId), run = this.db.prepare('SELECT id,session_id,parent_run_id,scope,context,prompt,state,message,usage,created,updated,output FROM agent_runs WHERE id=?').get(runId) as any;
    const session = this.db.prepare('SELECT header,inherited_count FROM harness_sessions WHERE id=?').get(runId) as any;
    const proposal = this.db.prepare('SELECT id,revision,digest,base_version,workspace_id,status,change_id,body FROM agent_proposals WHERE run_id=?').get(runId) as any;
    const payload = redact({ schemaVersion: 1, exportedAt: new Date().toISOString(), redaction: '已隐藏凭据、Cookie 和敏感 URL 参数；哈希字段指向原始保存记录，脱敏后内容另附摘要。未自动重放执行。', completeness: { gaps, ...this.page(runId).counts, total: records.length, modelInput: records.some(r => r.item.type === 'model.request') ? 'exact_dispatch_snapshot_redacted' : 'legacy_header_and_ordered_messages_only; no_exact_dispatch_snapshot' }, run: { ...run, scope: JSON.parse(run.scope), context: JSON.parse(run.context), usage: JSON.parse(run.usage), output: run.output ? JSON.parse(run.output) : null }, harnessSession: session ? { header: JSON.parse(session.header), inheritedCount: session.inherited_count } : null, records: records.map(r => ({ ...r, redactedSha256: digest(JSON.stringify(r.raw)) })), queries: this.queries(runId), mapQueries: this.mapQueries(runId), proposal: proposal ? { ...proposal, body: JSON.parse(proposal.body) } : null, media: new MediaStore(this.db).run(runId) });
    return payload;
  }
}

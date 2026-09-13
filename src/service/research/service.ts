import type { ImageProcessor } from '../../shared/image-processing.js';
import { MediaStore, downloadImage } from './media.js';
import { cardsContext } from '../../shared/cards.js';
import type { CardExtractor } from '../../cards/import.js';
import { redact, Trajectory } from './trajectory.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../../storage/database.js';
import { Plans } from '../domain/plans.js';
import { AppError, ensure } from '../domain/validation.js';
import { descendants, trail, type Workspace } from '../../shared/model.js';
import { agentOutput, type AgentScope, type AgentOutput, type AgentClaim, type AgentRunView, type AgentUsage, type AgentCapability, type AgentSessionView, type AgentEvent, type RunState } from '../../shared/agent.js';
import type { BrowserApi } from '../../shared/browser-port.js';
import { browserRequest } from '../../shared/browser-model.js';
import { digest } from '../../storage/browser.js';
import { canonical, Proposals, type PreparedProposal } from './proposals.js';
import type { MapService } from '../../maps/service.js';
import { MapStore } from '../../maps/store.js';
import { mapInputSchema, spatialSummary as mapSummary, type SpatialAsset } from '../../shared/maps.js';

import { defaultLimits, type AgentDriver, type AgentLimits, type DriverInput, type TravelTool } from '../../shared/execution.js';
export { defaultLimits };
export type { AgentDriver, AgentLimits, DriverInput, TravelTool } from '../../shared/execution.js';
export interface AgentOptions { driver?: AgentDriver; model?: string; mode?: 'ordinary' | 'development'; limits?: Partial<AgentLimits>; mediaDownload?: typeof downloadImage; mediaProcess?:ImageProcessor; maps?: MapService }
interface RunRow { id: string; session_id: string; owner_id: string; parent_run_id: string | null; request_hash: string; scope: string; context: string; prompt: string; state: RunState; message: string; usage: string; output: string | null; question_answer: string | null; answer_run_id: string | null; cancel_requested: number; created: string; updated: string }
interface SavedOutput { output: AgentOutput; claims: AgentClaim[]; proposal: PreparedProposal | null }
const runRequest = z.object({ researchPlaceIds:z.array(z.string().uuid()).max(10).optional(), requestId: z.string().uuid(), sessionId: z.string().uuid().optional(), workspaceId: z.string().uuid().nullable().default(null), nodeId: z.string().uuid().nullable().default(null), prompt: z.string().trim().min(1).max(8000), parentRunId: z.string().uuid().optional(), selectedCandidateId: z.string().min(1).max(100).optional() }).strict();
const newUsage = (): AgentUsage => ({ modelRequests: 0, browserQueries: 0, mapQueries: 0, mapEstimatedCredits: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: null, responseModels: [] });
const mapToolInput = mapInputSchema.omit({ workspaceId: true, requestId: true }).extend({ requestId: z.string().uuid().optional() });
const active = ['queued', 'running', 'cancelling'];
const stopped = new Set<RunState>(['cancelled', 'failed', 'interrupted']);
// GLM's function interface expects object properties at the schema root. A root
// discriminated union was silently exposed as an empty object by the provider.
const sourceToolInput = z.object({
  action: z.enum(['read','capture','scroll','follow']),
  requestId: z.string().uuid().optional(), url: z.string().url().optional(),
  pageId: z.string().uuid().optional(), snapshotId: z.string().uuid().optional(), linkId: z.string().optional(),
  maxChars: z.number().int().min(500).max(9000).optional(), startChar: z.number().int().min(0).optional(),
}).strict();
export class AgentService {
  readonly proposals: Proposals;
  readonly media: MediaStore;
  readonly limits: AgentLimits;
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  private pumping = false;
  private closePromise?: Promise<void>;
  private readableSpatial(ids: string[], owner: string, workspaceId?: string) {
    return new MapStore(this.db).readMany(ids, owner, workspaceId, { skipUnavailable: true });
  }
  private retainedResearch(id: string, owner: string, workspaceId?: string) {
    this.access(id, owner);
    const rows = this.db.prepare('SELECT q.result FROM map_queries q JOIN agent_map_queries a ON a.query_id=q.id WHERE a.run_id=? ORDER BY q.rowid DESC').all(id) as {result: string | null}[];
    const ids = [...new Set(rows.flatMap(row => row.result ? (JSON.parse(row.result).assets || []).map((asset: {id:string}) => asset.id) : []))] as string[];
    const images = this.media.run(id).filter(image => image.status === 'ready').slice(0,12).flatMap(image => {
      try {this.media.allowed(image.id,owner,workspaceId);return [image];} catch {return [];}
    });
    const pageRows=this.db.prepare('SELECT query_id FROM agent_browser_queries WHERE run_id=? AND owner_id=? ORDER BY rowid DESC LIMIT 6').all(id,owner) as {query_id:string}[];
    const pages=pageRows.flatMap(row=>{
      const result=this.browser.store.get(owner,row.query_id).result,page=result?.data;
      return result&&page?.text ? [{queryId:result.queryId,url:page.url,title:page.title,text:page.text.slice(0,3000),retrievedAt:result.retrievedAt,status:result.status,limitations:result.limitations,truncated:page.truncated||page.text.length>3000}] : [];
    });
    return {sourceRunId:id,pages,note:'上一轮未完成，但以下资料已保存且当前可访问；可复用引用，不等于已有可采用提议。',spatialAssets:this.readableSpatial(ids.slice(0,24),owner,workspaceId).map(mapSummary),media:images};
  }
  constructor(public db: DB, public plans: Plans, public browser: BrowserApi, public options: AgentOptions = {}) {
    this.proposals = new Proposals(db, plans);
    this.media = new MediaStore(db, options.mediaDownload, options.mediaProcess);
    this.limits = { ...defaultLimits, ...options.limits };
    for (const value of Object.values(this.limits)) ensure(Number.isSafeInteger(value) && value > 0, 'Agent 限额配置必须为正整数');
    const interrupted = db.prepare("SELECT id FROM agent_runs WHERE state IN ('queued','running','cancelling')").all() as { id: string }[];
    for (const row of interrupted) this.state(row.id, 'interrupted', '服务已重启，本次研究已中断；可查看已保存资料并手动继续。');
  }
  capability(): AgentCapability {
    const available = !!this.options.driver && (this.options.driver.available?.() ?? true) && !this.closing;
    const model = this.options.model || 'glm-5.3-flash', label = model === 'glm-5.3-flash' ? 'GLM-5.3-Flash' : model;
    return { available, model, mode: available ? this.options.mode || 'ordinary' : 'disabled', message: !available && this.options.driver?.status ? this.options.driver.status().message : available ? `${label} · ${this.options.mode === 'development' ? '开发验证' : '已连接'}` : '模型尚未配置，可继续手动规划。' };
  }
  row(id: string) {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id) as RunRow | undefined;
    ensure(row, '找不到研究记录', 404); return row;
  }
  access(id: string, owner: string) {
    const row = this.row(id); ensure(row.owner_id === owner, '没有该研究的访问权限', 403);
    const scope = JSON.parse(row.scope) as AgentScope;
    if (scope.workspaceId) this.plans.access(scope.workspaceId, owner, false, true);
    return row;
  }
  private check(row: RunRow, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const fresh = this.access(row.id, row.owner_id);
    ensure(!this.closing && !fresh.cancel_requested && fresh.state === 'running', '研究已停止', 409);
    const scope = JSON.parse(row.scope) as AgentScope;
    if (scope.workspaceId) this.plans.access(scope.workspaceId, row.owner_id);
    for(const id of (JSON.parse(row.context) as {researchPlaceIds?:string[]}).researchPlaceIds || [])this.options.maps!.store.allowed(id,row.owner_id,scope.workspaceId || undefined);
  }
  event(id: string, type: string, data: unknown) {
    const seq = (this.db.prepare('SELECT coalesce(max(seq),-1)+1 AS n FROM agent_events WHERE run_id=?').get(id) as { n: number }).n;
    this.db.prepare('INSERT INTO agent_events(run_id,seq,type,data,created) VALUES(?,?,?,?,?)').run(id, seq, type, JSON.stringify(data), new Date().toISOString());
  }
  private state(id: string, state: RunState, message: string) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE agent_runs SET state=?,message=?,updated=? WHERE id=?').run(state, message, new Date().toISOString(), id);
      this.event(id, 'run.status', { state, message });
    })();
  }
  sessions(owner: string): AgentSessionView[] {
    const rows = this.db.prepare('SELECT * FROM agent_sessions WHERE owner_id=? ORDER BY updated DESC,rowid DESC LIMIT 100').all(owner) as { id: string; workspace_id: string | null; node_id: string | null; title: string; updated: string }[];
    return rows.filter(r => !r.workspace_id || this.plans.role(r.workspace_id, owner)).map(r => ({ id: r.id, scope: { workspaceId: r.workspace_id, nodeId: r.node_id }, title: r.title, updatedAt: r.updated }));
  }
  history(sessionId: string, owner: string) {
    const session = this.db.prepare('SELECT * FROM agent_sessions WHERE id=? AND owner_id=?').get(sessionId, owner);
    ensure(session, '找不到本人的会话', 404);
    const ids = this.db.prepare('SELECT id FROM agent_runs WHERE session_id=? ORDER BY rowid').all(sessionId) as { id: string }[];
    return ids.map(r => this.view(r.id, owner));
  }
  events(id: string, owner: string, after = -1): AgentEvent[] {
    this.access(id, owner);
    return (this.db.prepare('SELECT seq,type,data,created FROM agent_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500').all(id, after) as { seq: number; type: string; data: string; created: string }[]).map(r => ({ seq: r.seq, type: r.type, data: r.type === 'model.request' ? { message: '请求已保存，可在执行轨迹中查看完整输入' } : redact(JSON.parse(r.data)), createdAt: r.created }));
  }
  view(id: string, owner: string): AgentRunView {
    const row = this.access(id, owner), context = JSON.parse(row.context) as { scopeLabel: string; base?: Workspace | null; researchPlaceIds?:string[] }, scope = JSON.parse(row.scope) as AgentScope;
    const saved = row.output ? JSON.parse(row.output) as SavedOutput : null;
    const proposal = this.db.prepare('SELECT id FROM agent_proposals WHERE run_id=?').get(id) as { id: string } | undefined;
    const media = this.media.run(id), seen = new Set(media.map(m => m.id));
    const associated = [...(saved?.output.media || []).map(m => m.mediaId), ...(saved?.output.spatial || []).flatMap(r => r.mediaIds), ...Object.values(saved?.proposal?.workspace.data.media || {}).flat(), ...Object.values(saved?.proposal?.before?.data.media || {}).flat()];
    for(const mid of associated) if(!seen.has(mid)) {
      try {const asset = this.media.row(mid); const shared = asset.owner_id !== owner ? scope.workspaceId || undefined : undefined; this.media.allowed(mid, owner, shared); media.push({...this.media.metadata(mid), ...(shared ? {accessWorkspaceId:shared} : {})});seen.add(mid);}
      catch(error) {if(!(error instanceof AppError) || ![403,404].includes(error.status))throw error; /* Detached shared media must not make private history inaccessible. */}
    }
    const spatial = this.spatial(id, owner).map(mapSummary);
    const presentationData = saved?.proposal?.workspace.data || saved?.proposal?.before?.data || context.base?.data;
    return { id, sessionId: row.session_id, scope, scopeLabel: context.scopeLabel, prompt: row.prompt, state: row.state, message: row.message, createdAt: row.created, updatedAt: row.updated, trajectoryRevision: new Trajectory(this.db).revision(id), usage: JSON.parse(row.usage), output: saved ? { answer: saved.output.answer, candidates: saved.output.candidates, question: saved.output.question, claims: saved.claims, media: saved.output.media || [], spatial: (saved.output.spatial || []).map(ref => {
      const node = ref.nodeId ? presentationData?.nodes[ref.nodeId] : undefined;
      const parent = node?.parentId ? presentationData?.nodes[node.parentId] : undefined;
      return node ? {...ref,title:[parent?.title,node.title].filter(Boolean).join(' · '),description:node.description} : ref;
    }) } : null, proposal: proposal ? this.proposals.view(proposal.id, owner) : null, questionAnswered: !!row.answer_run_id, parentRunId: row.parent_run_id, media, spatial, researchPlaceIds:(context.researchPlaceIds || []).filter(id=>spatial.some(a=>a.id===id)) };
  }
  spatial(id: string, owner: string): SpatialAsset[] {
    const row = this.access(id, owner), scope = JSON.parse(row.scope) as AgentScope;
    const saved = row.output ? JSON.parse(row.output) as SavedOutput : null;
    const spatialIds = [...((JSON.parse(row.context) as {researchPlaceIds?:string[]}).researchPlaceIds || []), ...(saved?.output.spatial || []).map(r => r.assetId), ...(saved?.claims || []).flatMap(c => c.spatialEvidence ? [c.spatialEvidence.assetId] : []), ...Object.values(saved?.proposal?.workspace.data.spatial || {}).flat().map(b => b.assetId), ...Object.values(saved?.proposal?.before?.data.spatial || {}).flat().map(b => b.assetId)];
    return this.readableSpatial(spatialIds, owner, scope.workspaceId || undefined);
  }
  submit(owner: string, raw: unknown): AgentRunView {
    const input = runRequest.parse(raw), requestHash = digest(canonical(input));
    const previous = this.db.prepare('SELECT id,request_hash FROM agent_runs WHERE owner_id=? AND request_id=?').get(owner, input.requestId) as { id: string; request_hash: string } | undefined;
    if (previous) { ensure(previous.request_hash === requestHash, '同一请求标识不能用于不同任务', 409); return this.view(previous.id, owner); }
    ensure(this.capability().available, '模型不可用，输入已保留，可继续手动规划', 503);
    const busy = this.db.prepare("SELECT id FROM agent_runs WHERE owner_id=? AND state IN ('queued','running','cancelling')").get(owner) as { id: string } | undefined;
    ensure(!busy, '你有一项研究正在进行，请等待完成或停止后重新提交', 409);
    const counts = this.db.prepare("SELECT count(*) AS n FROM agent_runs WHERE state='queued'").get() as { n: number };
    ensure(counts.n < this.limits.queueSize || this.running.size < this.limits.concurrency, '研究等待队列已满，请稍后重试；输入已保留', 429);
    let sessionId = input.sessionId;
    const scope = { workspaceId: input.workspaceId, nodeId: input.nodeId };
    let base: Workspace | null = null;
    if (scope.workspaceId) {
      base = this.plans.access(scope.workspaceId, owner);
      scope.nodeId ||= base.data.rootId;
      ensure(base.data.nodes[scope.nodeId], '找不到当前规划范围');
    } else ensure(!scope.nodeId, '新草案不能携带已有节点');
    if (sessionId) {
      const session = this.db.prepare('SELECT * FROM agent_sessions WHERE id=? AND owner_id=?').get(sessionId, owner) as { workspace_id: string | null; node_id: string | null } | undefined;
      ensure(session && session.workspace_id === scope.workspaceId && session.node_id === scope.nodeId, '会话与本次规划范围不一致', 403);
    }
    let previousRuns: unknown[] = [];
    if (sessionId) previousRuns = (this.db.prepare('SELECT id,state,prompt,output,question_answer FROM agent_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 8').all(sessionId) as { id:string; state:RunState; prompt: string; output: string | null; question_answer: string | null }[]).reverse().map((r,index,runs) => {
      const saved = r.output ? (JSON.parse(r.output) as SavedOutput).output : null;
      const assets = this.readableSpatial((saved?.spatial || []).map(ref => ref.assetId), owner, scope.workspaceId || undefined);
      return { prompt: r.prompt, answer: saved?.answer || null, candidates: saved?.candidates || [], question: saved?.question, userAnswer: r.question_answer,
        media: (saved?.media || []).flatMap(ref => { try { this.media.allowed(ref.mediaId, owner, scope.workspaceId || undefined); return [{ ...ref, ...this.media.metadata(ref.mediaId) }]; } catch { return []; } }),
        spatial: (saved?.spatial || []).filter(ref => assets.some(a => a.id === ref.assetId)), spatialAssets: assets.map(mapSummary),
        ...(r.id === [...runs].reverse().find(run=>stopped.has(run.state))?.id ? {state:r.state,retainedResearch:this.retainedResearch(r.id,owner,scope.workspaceId || undefined)} : {}) };
    });
    let selectedCandidate: unknown = null;
    if (input.parentRunId) {
      const parent = this.access(input.parentRunId, owner); ensure(parent.session_id === sessionId && !active.includes(parent.state), '继续任务必须属于已结束的同一会话', 409);
      if (input.selectedCandidateId) {
        const saved = parent.output ? JSON.parse(parent.output) as SavedOutput : null, candidate = saved?.output.candidates.find(c => c.id === input.selectedCandidateId);
        ensure(candidate, '选中的候选不属于上一轮回答');
        const refs = saved!.output.spatial?.filter(r => r.candidateId === candidate.id) || [];
        const assets = this.readableSpatial(refs.map(r => r.assetId), owner, scope.workspaceId || undefined);
        const media = (saved!.output.media || []).filter(m => m.candidateId === candidate.id).filter(m => {try {this.media.allowed(m.mediaId,owner,scope.workspaceId || undefined);return true;} catch {return false;}});
        selectedCandidate = { ...candidate, spatial: refs.filter(r => assets.some(a => a.id === r.assetId)), assets: assets.map(mapSummary), media, unavailableAssets: refs.filter(r => !assets.some(a => a.id === r.assetId)).map(r => r.assetId) };
      }
    } else ensure(!input.selectedCandidateId, '选择候选需要上一轮任务');
    const inheritedPlaceIds=input.parentRunId ? (JSON.parse(this.access(input.parentRunId,owner).context) as {researchPlaceIds?:string[]}).researchPlaceIds : undefined;
    const researchPlaceIds=[...new Set(input.researchPlaceIds ?? inheritedPlaceIds ?? [])];
    const researchPlaces=researchPlaceIds.map(id=>{
      ensure(this.options.maps,'地图服务未配置',503);
      const asset=this.options.maps.store.allowed(id,owner,scope.workspaceId || undefined);
      ensure(asset.kind==='place','研究目标必须是地点');return mapSummary(asset);
    });
    const scopeLabel = base ? trail(base.data, scope.nodeId!).map(n => n.title).join(' / ') : '新独立计划';
    const editable = base ? descendants(base.data, scope.nodeId!).map(n => n.id) : [];
    const context = {
      scopeLabel, base, researchPlaceIds, researchPlaces,
      projection: base ? { cards: cardsContext(base.data,scope.nodeId!), workspaceId: base.id, version: base.version, scopeNodeId: scope.nodeId, role: this.plans.role(base.id, owner), nodes: descendants(base.data, scope.nodeId!), ancestors: trail(base.data, scope.nodeId!).slice(0, -1), constraints: Object.values(base.data.nodes).filter(n => n.fixed && !editable.includes(n.id)), preparations: Object.values(base.data.preparations).filter(p => p.nodeIds.some(n => editable.includes(n))), personalProgress: base.data.progress[owner] || {}, spatial: Object.fromEntries(Object.entries(base.data.spatial || {}).filter(([id]) => editable.includes(id))), spatialAssets: this.readableSpatial(Object.entries(base.data.spatial || {}).filter(([id]) => editable.includes(id)).flatMap(([, refs]) => refs.map(r => r.assetId)), owner, base.id).map(mapSummary), media: Object.fromEntries(Object.entries(base.data.media || {}).filter(([id]) => editable.includes(id)).map(([id,ids]) => [id,ids.map(mid => this.media.metadata(mid))])) } : null,
      previousRuns,
      selectedCandidate,
    };
    const id = randomUUID(), now = new Date().toISOString();
    this.db.transaction(() => {
      if (!sessionId) {
        sessionId = randomUUID();
        this.db.prepare('INSERT INTO agent_sessions(id,owner_id,workspace_id,node_id,title,created,updated) VALUES(?,?,?,?,?,?,?)').run(sessionId, owner, scope.workspaceId, scope.nodeId, scopeLabel, now, now);
      }
      this.db.prepare("INSERT INTO agent_runs(id,session_id,owner_id,request_id,request_hash,parent_run_id,scope,context,prompt,state,message,usage,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'queued','等待研究资源',?,?,?)").run(id, sessionId, owner, input.requestId, requestHash, input.parentRunId || null, JSON.stringify(scope), JSON.stringify(context), input.prompt, JSON.stringify(newUsage()), now, now);
      this.db.prepare('UPDATE agent_sessions SET updated=? WHERE id=?').run(now, sessionId);
      this.event(id, 'run.status', { state: 'queued', message: '等待研究资源' });
    })();
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      if (this.row(id).state === 'queued') this.state(id, 'failed', 'queue_timeout：等待超过时限，未调用模型，请稍后重试。');
    }, this.limits.queueMs));
    this.pump();
    return this.view(id, owner);
  }
  answer(id: string, owner: string, input: { requestId: string; answer: string; selectedCandidateId?: string }) {
    return this.db.transaction(() => {
      const row = this.access(id, owner);
      if (row.answer_run_id) { ensure(row.question_answer === input.answer && JSON.parse(this.row(row.answer_run_id).context).selectedCandidate?.id === input.selectedCandidateId, '问题已经答复，不能重复改变答案', 409); return this.view(row.answer_run_id, owner); }
      const saved = row.output ? JSON.parse(row.output) as SavedOutput : null;
      ensure(row.state === 'needs_input' && saved?.output.question, '这项研究没有待答问题', 409);
      ensure(input.answer.trim() || !saved.output.question.required, '请先回答必要问题');
      const scope = JSON.parse(row.scope) as AgentScope;
      const result = this.submit(owner, { requestId: input.requestId, sessionId: row.session_id, ...scope, parentRunId: id, selectedCandidateId: input.selectedCandidateId, prompt: `针对问题“${saved.output.question.text}”，我的答复：${input.answer || '跳过非必要问题，请保留未知项继续。'}` });
      this.db.prepare('UPDATE agent_runs SET question_answer=?,answer_run_id=? WHERE id=?').run(input.answer, result.id, id);
      this.event(id, 'question.answered', { runId: result.id }); return result;
    })();
  }
  cancel(id: string, owner: string) {
    const row = this.access(id, owner);
    if (!active.includes(row.state)) return this.view(id, owner);
    this.db.transaction(() => {
      this.db.prepare('UPDATE agent_runs SET cancel_requested=1 WHERE id=?').run(id);
      this.state(id, this.running.has(id) ? 'cancelling' : 'cancelled', '已收到停止请求，正在释放本次研究资源。');
    })();
    const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id);
    this.running.get(id)?.controller.abort(new Error('user_cancelled'));
    return this.view(id, owner);
  }
  private pump() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.limits.concurrency) {
        const row = this.db.prepare("SELECT * FROM agent_runs WHERE state='queued' ORDER BY rowid LIMIT 1").get() as RunRow | undefined;
        if (!row) break;
        const timer = this.timers.get(row.id); if (timer) clearTimeout(timer); this.timers.delete(row.id);
        const controller = new AbortController();
        this.state(row.id, 'running', '正在理解需求与已有安排');
        const job = Promise.resolve().then(() => this.run(row.id, controller)).finally(() => { this.running.delete(row.id); queueMicrotask(() => this.pump()); });
        this.running.set(row.id, { controller, promise: job });
        void job.catch(() => undefined); // run records the failure; close also joins every job.
      }
    } finally { this.pumping = false; }
  }
  private async run(id: string, controller: AbortController) {
    const row = this.row(id), scope = JSON.parse(row.scope) as AgentScope;
    const context = JSON.parse(row.context) as { base: Workspace | null; projection: unknown; previousRuns: unknown[]; selectedCandidate?: unknown; researchPlaces?:unknown[]; scopeLabel: string };
    const usage = JSON.parse(row.usage) as AgentUsage;
    const signal = controller.signal;
    let saved: SavedOutput | null = null, rawText = '', failure: unknown;
    const timer = setTimeout(() => controller.abort(new Error('time_limit')), this.limits.runMs);
    const persistUsage = () => this.db.prepare('UPDATE agent_runs SET usage=?,updated=? WHERE id=?').run(JSON.stringify(usage), new Date().toISOString(), id);
    const guard = () => this.check(row, signal);
    const tools: TravelTool[] = [
      { name: 'read_plan_context', description: '读取本次已授权范围、上级约束和已有准备。不会扩大范围。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { guard(); return context.projection || { scope: 'new_workspace', dates: 'unknown' }; } },
      { name: 'read_map_data', description: '按明确名称、城市和类别查询地点；引用已返回 placeId/placeIds 取得真实步行路径、场所轮廓、顺序示意或建议探索范围。每轮最多8次。只返回可引用的资产摘要，几何由应用保管；不导航、不核实营业条件。', parameters: z.toJSONSchema(mapToolInput) as Record<string, unknown>, execute: async (raw, toolSignal) => {
        guard(); const args = mapToolInput.parse(raw);
        ensure(this.options.maps, '地图服务未配置，请保留待定位内容', 503);
        const requestId = args.requestId || randomUUID(), before = Date.now();
        this.event(id, 'map.started', { requestId, action: args.action, text: args.text, context: args.context, placeId: args.placeId, placeIds: args.placeIds });
        try {
          const result = await this.options.maps.query(row.owner_id, { ...args, requestId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) }, { signal: AbortSignal.any([signal, toolSignal]), runId: id });
          this.event(id, 'map.finished', { requestId, queryId: result.queryId, status: result.status, message: result.message, cached: result.cached, estimatedCredits: result.estimatedCredits, assets: result.assets.map(mapSummary), durationMs: Date.now() - before });
          guard(); return { ...result, assets: result.assets.map(mapSummary) };
        } catch (error) {
          this.event(id, 'map.failed', { requestId, status: 'failed', message: error instanceof AppError ? error.message : '地图查询被中断，已取得的结果保留在轨迹中', durationMs: Date.now() - before });
          throw error;
        } finally {
          const rows = this.db.prepare('SELECT q.result FROM map_queries q JOIN agent_map_queries a ON a.query_id=q.id WHERE a.run_id=?').all(id) as { result: string | null }[];
          usage.mapQueries = rows.length;
          const credits = rows.map(r => r.result ? JSON.parse(r.result).estimatedCredits as number | null : null);
          usage.mapEstimatedCredits = credits.some(c => c === null) ? null : credits.reduce<number>((sum, c) => sum + c!, 0);
          persistUsage();
        }
      } },
      { name: 'read_travel_source', description: '用 Chrome 读取正文。首次用 action=read 和 url；截断时用 capture、返回的 pageId 和 startChar。follow 需要 pageId、snapshotId、linkId。引用 queryId 和准确原文。同时采集来源图片，返回稳定mediaId及图片说明。模型未解读像素，失败不是闭馆。', parameters: z.toJSONSchema(sourceToolInput) as Record<string, unknown>, execute: async (raw, toolSignal) => {
        guard(); const args = sourceToolInput.parse(raw);
        // Models sometimes reuse example UUIDs. Idempotency belongs to this run;
        // it must never return another conversation's research by accident.
        const key = args.requestId ? digest(`${id}:${args.requestId}`) : null;
        const requestId = key ? `${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}` : randomUUID();
        const input = browserRequest.parse({ ...args, requestId, context: { destination: context.scopeLabel.slice(0,200), purpose: row.prompt.slice(0,500), dates: context.base ? JSON.stringify(context.base.data.nodes[scope.nodeId!].dates).slice(0,200) : '日期未定' } });
        ensure(['read', 'capture', 'scroll', 'follow'].includes(input.action), '本期仅开放官方文本读取与页面内跟随', 403);
        if (usage.browserQueries >= this.limits.browserQueries) { controller.abort(new Error('browser_budget_limit')); throw new AppError(429, '浏览器查询次数已到上限'); }
        usage.browserQueries++; persistUsage();
        this.event(id, 'research.started', { action: input.action });
        this.state(id, 'running', '正在读取来源并核对条件');
        const started = this.browser.start(row.owner_id, { ...input, maxChars: Math.min(input.maxChars, 9000) }, AbortSignal.any([signal, toolSignal]), `agent:${id}`);
        this.db.prepare('INSERT OR IGNORE INTO agent_browser_queries(query_id,run_id,owner_id) VALUES(?,?,?)').run(started.queryId, id, row.owner_id);
        let result = this.browser.store.get(row.owner_id, started.queryId).result;
        if (!result) result = await this.browser.execute(row.owner_id, { ...input, maxChars: Math.min(input.maxChars, 9000) }, AbortSignal.any([signal, toolSignal]), `agent:${id}`);
        guard(); this.event(id, 'research.finished', { queryId: result.queryId, status: result.status, title: result.data?.title || '', missing: result.missing });
        // Keep the complete query in SQLite. The model needs the text and
        // navigation handles, not repeated media/comment metadata it cannot read.
        const page = result.data;
        const media = await this.media.gather(result.queryId, id, row.owner_id, AbortSignal.any([signal, toolSignal]));
        guard(); this.event(id, 'media.collected', { queryId: result.queryId, media: media.map(m => ({ id: m.id, status: m.status, message: m.message })) });
        return { media, queryId: result.queryId, status: result.status, retrievedAt: result.retrievedAt, message: result.message,
          missing: result.missing, limitations: [...result.limitations, ...(page && page.links.length > 12 ? ['工具视图只列出前12个链接，完整链接保存在原查询中。'] : [])],
          data: page ? { pageId: page.pageId, snapshotId: page.snapshotId, url: page.url, title: page.title, text: page.text, textHash: page.textHash, contentKind: page.contentKind, evidenceId: page.evidenceId, modifiedAt: page.modifiedAt, truncated: page.truncated, textRange: page.textRange, links: page.links.slice(0,12) } : null };
      } },
      { name: 'check_plan_draft', description: '模拟完整产物和提议，检查范围、固定事项、日期、来源。失败时修正，不写正式计划。', parameters: z.toJSONSchema(agentOutput, { io: 'input' }) as Record<string, unknown>, execute: async raw => { guard(); const checked = this.proposals.prepare(row.owner_id, scope, raw, context.base); return { valid: true, changes: checked.proposal?.diffs.map(d => ({ kind: d.kind, title: d.after?.title })) || [] }; } },
      { name: 'publish_result', description: '提交最终回答、候选、问题或提议。必须通过此工具结束，每轮只发布一份完整产物。正式计划仍须用户采用。', parameters: z.toJSONSchema(agentOutput, { io: 'input' }) as Record<string, unknown>, execute: async raw => {
        guard(); ensure(!saved, '本轮产物已保存');
        const prepared = this.proposals.prepare(row.owner_id, scope, raw, context.base);
        guard();
        try {
          this.db.transaction(() => {
            this.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(JSON.stringify(prepared), id);
            this.event(id, 'result.staged', { message: '建议已生成，正在保存研究记录' });
          })();
          saved = prepared;
        } catch (error) {
          // A failed tool result may otherwise be consumed by the model loop.
          // Latch failure before returning so no retry can publish an unsaved draft.
          controller.abort(new Error('结果保存失败，正式计划未修改'));
          throw error;
        }
        return { saved: true, message: '本轮结束；无需继续调用模型。用户查看预览后决定是否采用。' };
      } },
    ];
    const strategy = { context, prompt: row.prompt, browserQueries: this.limits.browserQueries, mapMessage: this.options.maps?.status().message || '未配置，保留待定位内容' };
    // The app supplies authorized facts. Research policy and model prompt live in the worker.
    const prompt = `本次明确选中的候选与已有上下文：${JSON.stringify(context)}\n本次用户需求：${row.prompt}`;
    const runDriver = async (text: string) => this.options.driver!.run({ id, strategy: { ...strategy, repair: text !== prompt }, prompt: text, tools, signal, maxTokens: this.limits.outputTokens,
      request: value => { guard(); this.event(id, 'model.request', redact(value)); },
      beforeModel: estimate => {
        guard();
        if (usage.modelRequests >= this.limits.modelRequests || (usage.tokens !== null && usage.tokens + estimate + this.limits.outputTokens > this.limits.tokenThreshold)) { controller.abort(new Error('budget_limit')); throw new AppError(429, '模型调用或 token 回报阈值已达上限'); }
        usage.modelRequests++; persistUsage(); this.event(id, 'model.started', { count: usage.modelRequests });
      },
      usage: value => {
        if (value.model && !usage.responseModels.includes(value.model)) usage.responseModels.push(value.model);
        for (const [field, received] of [['tokens', value.total], ['inputTokens', value.input], ['outputTokens', value.output], ['cacheTokens', value.cache]] as const) usage[field] = usage[field] === null || received === undefined ? null : usage[field]! + received;
        persistUsage();
      },
      text: text => { rawText += text; }, hasResult: () => !!saved,
    });
    try {
      guard(); await runDriver(prompt);
      if (!saved) { guard(); this.state(id, 'running', '正在修复建议格式'); await runDriver(prompt + '\n上一轮未形成有效产物。请现在调用 publish_result 提交完整结果。这是唯一一次格式修复。'); }
    } catch (error) { failure = error; }
    finally {
      clearTimeout(timer);
      try { await this.options.driver?.release?.(id); } catch (error) { failure ||= error; }
      try { await this.browser.releaseLease(`agent:${id}`); } catch (error) { failure ||= error; }
    }
    try {
      const fresh = this.row(id);
      if (fresh.cancel_requested) this.state(id, 'cancelled', '研究已停止，已取得的资料保留。');
      else if (this.closing) this.state(id, 'interrupted', '应用已停止，可在重新打开后手动继续。');
      else {
        this.access(id, row.owner_id);
        if (failure || signal.aborted) {
          const reason = signal.aborted ? (signal.reason as Error)?.message : failure instanceof AppError ? failure.message : '模型或研究服务暂时不可用';
          this.state(id, saved ? 'partial' : 'failed', `${reason}；已保存内容可查看，继续需要重新提交。`);
        } else if (saved) {
          const ready: SavedOutput = saved;
          this.db.transaction(() => {
            this.check(row);
            if (ready.proposal) this.proposals.insert(id, ready.proposal);
            const reusedPages=context.previousRuns.some(value=>(value as {retainedResearch?:{pages?:unknown[]}}).retainedResearch?.pages?.length);
            const researchStatus=usage.browserQueries ? '本轮已完成；网页读取结果和限制见执行轨迹。' : reusedPages ? '本轮已完成，已提供此前保存的网页摘录；未发起新网页查询，事实与适用条件仍需核对。' : '本轮已完成，未查阅网页；事实条件仍需核对。';
            this.state(id, ready.output.question ? 'needs_input' : 'completed', ready.output.question ? '需要你的答复，当前没有进行中的模型请求。' : researchStatus+(ready.proposal ? '建议采用后才写入计划。' : '行程未改变。'));
            this.event(id, ready.output.question ? 'question.ready' : 'result.ready', { runId: id });
          })();
        } else {
          if (rawText) this.db.prepare('UPDATE agent_runs SET output=? WHERE id=?').run(JSON.stringify({ output: { answer: rawText.slice(-16000), candidates: [], claims: [] }, claims: [], proposal: null }), id);
          this.state(id, 'partial', '回答已保留，但未形成有效修改提议；可以调整要求后重试。');
        }
      }
    } catch (error) {
      this.state(id, 'failed', error instanceof AppError ? error.message : '结果保存失败，正式计划未修改。');
    }
  }
  async wait(id: string) {
    while (this.row(id).state === 'queued' || this.running.has(id)) {
      const job = this.running.get(id); if (job) await job.promise; else await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const job of this.running.values()) job.controller.abort(new Error('app_shutdown'));
    this.closePromise = (async () => {
      await Promise.allSettled([...this.running.values()].map(x => x.promise));
      for (const row of this.db.prepare("SELECT id FROM agent_runs WHERE state='queued'").all() as { id: string }[]) this.state(row.id, 'interrupted', '应用已停止；等待任务未调用模型。');
      await this.options.driver?.close();
    })();
    return this.closePromise;
  }
}

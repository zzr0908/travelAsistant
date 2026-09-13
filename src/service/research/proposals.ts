import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DB } from '../../storage/database.js';
import { Plans } from '../domain/plans.js';
import { AppError, ensure, validateData } from '../domain/validation.js';
import { addNode, editNode, moveNode, putPreparation } from '../domain/operations.js';
import { children, descendants, trail, nodeFields, type Dates, type Workspace, type WorkspaceData } from '../../shared/model.js';
import { agentOutput, type AgentOutput, type AgentScope, type AgentClaim, type AgentDiff, type ProposalView, type PublishedClaim } from '../../shared/agent.js';
import { MediaStore } from './media.js';
import { BrowserStore, digest } from '../../storage/browser.js';
import { MapStore } from '../../maps/store.js';
import { spatialEvidenceText, bindingStale } from '../../shared/maps.js';

export const canonical = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const same = isDeepStrictEqual;
// Match formatting differences only; store the original page span, never a
// paraphrase. Raw model arguments remain in the Harness event ledger.
export function sourceQuote(text: string, quote: string): string | null {
  if (text.includes(quote)) return quote;
  const normalize = (value: string) => {
    let normalized = ''; const offsets: number[] = [];
    for (let i = 0; i < value.length; i++) {
      const c = /\s/u.test(value[i]) ? ' ' : value[i];
      if (c === ' ' && normalized.endsWith(' ')) continue;
      normalized += c; offsets.push(i);
    }
    return { normalized, offsets };
  };
  const page = normalize(text), wanted = normalize(quote.replaceAll('\\n','\n').replaceAll('\\t','\t').replaceAll('\\r','\r')).normalized.trim();
  const index = page.normalized.indexOf(wanted);
  if (index < 0 || wanted.length < 8) return null;
  const found = text.slice(page.offsets[index], page.offsets[index + wanted.length - 1] + 1);
  return found.length <= 1200 ? found : null;
}
export interface PreparedProposal {
  title: string; workspace: Workspace; scope: AgentScope; before: Workspace | null;
  diffs: AgentDiff[]; assumptions: string[]; claims: AgentClaim[];
}
interface ProposalRow { id: string; run_id: string; revision: number; digest: string; base_version: number | null; workspace_id: string; body: string; status: string; change_id: string | null }

// Use civil time plus the explicit zone; ambiguous/nonexistent clock times need user clarification.
export function instant(date: string, time: string, zone: string) {
  const wanted = date + 'T' + time;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (ms: number) => {
    const p = Object.fromEntries(format.formatToParts(ms).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const base = Date.parse(wanted + ':00Z');
  let value = base;
  for (let i = 0; i < 5; i++) value += base - Date.parse(local(value) + ':00Z');
  ensure(local(value) === wanted, '当地时刻不存在，请调整夏令时切换日的安排');
  ensure(local(value - 3600000) !== wanted && local(value + 3600000) !== wanted, '当地时刻存在歧义，请先手动明确安排');
  return value;
}
function timeRange(d: Dates): [number, number] | null {
  if (d.mode !== 'fixed' || !d.startTime || !d.endTime) return null;
  const start = instant(d.start, d.startTime, d.timezone), end = instant(d.end, d.endTime, d.timezone);
  ensure(end > start, '结束时刻不能早于开始时刻');
  return [start, end];
}
function conflictAmounts(data: WorkspaceData) {
  const found = new Map<string, number>();
  const nodes = Object.values(data.nodes);
  for (const n of nodes) {
    if (!['fixed', 'window'].includes(n.dates.mode)) continue;
    for (const p of trail(data, n.id).slice(0, -1)) {
      if (!['fixed', 'window'].includes(p.dates.mode)) continue;
      if (n.dates.start < p.dates.start) found.set(`start:${n.id}:${p.id}`, Date.parse(p.dates.start) - Date.parse(n.dates.start));
      if (n.dates.end > p.dates.end) found.set(`end:${n.id}:${p.id}`, Date.parse(n.dates.end) - Date.parse(p.dates.end));
    }
  }
  const ranges = nodes.map(n => ({ n, range: timeRange(n.dates) })).filter(x => x.range);
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
    const a = ranges[i], b = ranges[j];
    if (trail(data, a.n.id).some(n => n.id === b.n.id) || trail(data, b.n.id).some(n => n.id === a.n.id)) continue;
    const amount = Math.min(a.range![1], b.range![1]) - Math.max(a.range![0], b.range![0]);
    if (amount > 0) found.set(`overlap:${[a.n.id, b.n.id].sort().join(':')}`, amount);
  }
  return found;
}
export function dependencies(data: WorkspaceData, nodeIds: string[]) {
  return Object.fromEntries([...new Set(nodeIds.flatMap(id => trail(data, id).map(n => n.id)))].sort().map(id => [id, { dates: data.nodes[id].dates, location: data.nodes[id].location }]));
}
export class Proposals {
  constructor(public db: DB, public plans: Plans) {}
  prepare(owner: string, scope: AgentScope, raw: unknown, base: Workspace | null): { output: AgentOutput; claims: AgentClaim[]; proposal: PreparedProposal | null } {
    const output = agentOutput.parse(raw);
    ensure(!output.candidates.length || output.candidates.length >= 2, '比较需要至少两个有差异的候选');
    ensure(!(output.question && output.proposal), '请先回答问题，再形成可采用提议');
    ensure(!(output.candidates.length && output.proposal), '请先选择一个候选，再形成修改提议');
    let proposal: PreparedProposal | null = null;
    const mapping = new Map<string, string>();
    const maps = new MapStore(this.db);
    if (output.proposal) {
      if (scope.workspaceId) {
        this.plans.access(scope.workspaceId, owner);
        ensure(base && base.id === scope.workspaceId && base.data.nodes[scope.nodeId!], '计划上下文无效');
      }
      let workspace = base ? structuredClone(base) : null;
      const permitted = new Set(base ? descendants(base.data, scope.nodeId!).map(n => n.id) : []);
      const reserve = (id: string) => {
        ensure(!mapping.has(id) && !workspace?.data.nodes[id] && !workspace?.data.preparations[id], '新增标识必须唯一');
        mapping.set(id, randomUUID()); return mapping.get(id)!;
      };
      const ref = (id: string) => mapping.get(id) || id;
      const allowed = (id: string) => ensure(permitted.has(ref(id)), '提议超出当前规划范围', 403);
      for (const op of output.proposal.operations) {
        const fields = op.kind === 'new_workspace' || op.kind === 'add_node' ? op.node : op.kind === 'update_node' ? op.changes : null;
        if (fields?.location && (fields.location.lat != null || fields.location.lng != null)) {
          const old = op.kind === 'update_node' ? base?.data.nodes[ref(op.nodeId)] : null;
          ensure(old && same(old.location, {...old.location,...fields.location}), '精确坐标必须由已核对的地点服务引用生成，不能由 Agent 填写');
        }
        if (op.kind === 'new_workspace') {
          ensure(!workspace && !scope.workspaceId, '已有计划不能再次创建工作区');
          const id = reserve(op.id);
          workspace = { id: randomUUID(), ownerId: owner, version: 0, deleted: false, data: { rootId: id, kind: op.workspaceKind, nodes: { [id]: { ...op.node, id, parentId: null, order: 0 } }, preparations: {}, progress: {}, sample: false } };
          permitted.add(id);
        } else {
          ensure(workspace, '请先生成新工作区根节点');
          const data = workspace.data;
          if (op.kind === 'add_node') {
            allowed(op.parentId); const id = reserve(op.id);
            addNode(data, id, ref(op.parentId), op.node); permitted.add(id);
          } else if (op.kind === 'update_node') {
            allowed(op.nodeId); const id = ref(op.nodeId), old = data.nodes[id];
            ensure(old && !old.fixed, 'Agent 不允许改写固定安排');
            const { id: _id, parentId: _parent, order: _order, ...fields } = old;
            editNode(data, id, nodeFields.parse({ ...fields, ...op.changes,dates:{...fields.dates,...op.changes.dates},location:{...fields.location,...op.changes.location} }));
          } else if (op.kind === 'set_media') {
            allowed(op.nodeId); const id = ref(op.nodeId);
            ensure(data.nodes[id], '图片关联节点不存在');
            op.mediaIds.forEach(mid => new MediaStore(this.db).usable(mid, owner, scope.workspaceId || undefined));
            data.media ||= {}; data.media[id] = [...new Set(op.mediaIds)];
            for (const b of data.spatial?.[id] || []) b.mediaIds = b.mediaIds.filter(mid => op.mediaIds.includes(mid));
          } else if (op.kind === 'set_spatial') {
            allowed(op.nodeId); const id = ref(op.nodeId);
            ensure(data.nodes[id] && !data.nodes[id].fixed, 'Agent 不允许改写固定安排的地图关联');
            for (const binding of op.bindings) binding.nodeIds.forEach(allowed);
            maps.bind(data, owner, scope.workspaceId || undefined, id, op.bindings.map(b => ({ ...b, nodeIds: b.nodeIds.map(ref) })));
            for (const binding of data.spatial?.[id] || []) binding.nodeIds.forEach(allowed);
          } else if (op.kind === 'move_node') {
            allowed(op.nodeId); allowed(op.parentId);
            ensure(!data.nodes[ref(op.nodeId)]?.fixed, 'Agent 不允许移动固定安排');
            moveNode(data, ref(op.nodeId), ref(op.parentId));
          } else if (op.kind === 'reorder_children') {
            allowed(op.parentId); op.nodeIds.forEach(allowed);
            const ids = op.nodeIds.map(ref), expected = children(data, ref(op.parentId)).map(n => n.id);
            ensure(new Set(ids).size === ids.length && same([...ids].sort(), expected.sort()), '排序必须包含全部子项，不能重复或遗漏');
            ids.forEach((id, index) => { data.nodes[id].order = index; });
          } else if (op.kind === 'preparation') {
            op.nodeIds.forEach(allowed);
            const old = data.preparations[op.id];
            const id = old?.id || reserve(op.id);
            const newSteps = op.steps.map(s => ({ ...s, id: old?.steps.some(x => x.id === s.id) ? s.id : reserve(s.id) }));
            if (old) {
              ensure(old.steps.every(s => newSteps.some(n => same(s, n))), 'Agent 不能删除或改写已有准备步骤');
              if (old.nodeIds.some(n => !permitted.has(n)))
                ensure(old.title === op.title && old.note === op.note && same(old.steps, newSteps), '共用准备影响范围外安排，请明确扩大范围', 403);
            }
            putPreparation(data, { id, title: op.title, note: op.note, nodeIds: [...new Set([...(old?.nodeIds || []), ...op.nodeIds.map(ref)])], steps: newSteps });
          }
        }
      }
      ensure(workspace, '提议没有生成计划');
      validateData(workspace.data);
      maps.validate(workspace.data);
      for (const n of Object.values(workspace.data.nodes)) {
        const old = base?.data.nodes[n.id];
        ensure(!n.fixed || old?.fixed, '新增固定标记请由用户手动确认');
        if (n.location.lat !== null || n.location.lng !== null) {
          const primary = workspace.data.spatial?.[n.id]?.find(b => b.primary);
          ensure(primary || old && same(old.location, n.location), '精确坐标必须来自已核对的地点服务或已有手动位置');
        }
      }
      if (base) {
        for (const n of Object.values(base.data.nodes)) {
          if (!permitted.has(n.id) || n.fixed) {
            ensure(same(n, workspace.data.nodes[n.id]), '固定或范围外安排不能改变', 403);
            ensure(same(base.data.spatial?.[n.id] || [], workspace.data.spatial?.[n.id] || []), '固定或范围外地图关联不能改变', 403);
          }
          if (n.fixed) ensure(same(trail(base.data, n.id).map(x => x.id), trail(workspace.data, n.id).map(x => x.id)), '父级移动会改变固定安排的归属');
        }
        ensure(same(base.data.progress, workspace.data.progress), '不能改变个人办理进度');
        ensure(same(base.data.cards||{}, workspace.data.cards||{}), '提议不能改变卡片事实或关联',403,'CARD_READ_ONLY');
      }
      const oldConflicts = base ? conflictAmounts(base.data) : new Map<string, number>();
      for (const [key, amount] of conflictAmounts(workspace.data)) ensure(amount <= (oldConflicts.get(key) || 0), '提议产生新的日期或时间冲突，请调整建议');
      const diffs: AgentDiff[] = [];
      for (const [id, n] of Object.entries(workspace.data.nodes)) if (!same(base?.data.nodes[id], n)) diffs.push({ kind: base?.data.nodes[id] ? '修改安排' : '新增安排', id, before: base?.data.nodes[id] || null, after: n });
      for (const [id, p] of Object.entries(workspace.data.preparations)) if (!same(base?.data.preparations[id], p)) diffs.push({ kind: base?.data.preparations[id] ? '补充准备' : '新增准备', id, before: base?.data.preparations[id] || null, after: p });
      for (const [id, ids] of Object.entries(workspace.data.media || {})) if (!same(base?.data.media?.[id] || [], ids)) diffs.push({ kind: '修改配图', id: `media:${id}`, before: { id, title: workspace.data.nodes[id].title, mediaIds: base?.data.media?.[id] || [] }, after: { id, title: workspace.data.nodes[id].title, mediaIds: ids } });
      for (const id of new Set([...Object.keys(base?.data.spatial || {}), ...Object.keys(workspace.data.spatial || {})])) {
        const before = base?.data.spatial?.[id] || [], after = workspace.data.spatial?.[id] || [];
        if (!same(before, after)) diffs.push({ kind: '修改地图', id: `spatial:${id}`, before: { id, title: workspace.data.nodes[id].title, bindings: before }, after: { id, title: workspace.data.nodes[id].title, bindings: after } });
      }
      ensure(diffs.length, '提议没有实际变更');
      proposal = { title: output.proposal.title, workspace, scope, before: base, diffs, assumptions: [...output.proposal.assumptions, ...(oldConflicts.size ? ['原计划已有日期冲突；本次不会新增或扩大，请另行处理。'] : [])], claims: [] };
    }
    for (const media of output.media) {
      new MediaStore(this.db).usable(media.mediaId, owner, scope.workspaceId || undefined);
      ensure(!media.candidateId || output.candidates.some(c => c.id === media.candidateId), '配图关联的候选不存在：candidateId 只能指向本次 candidates；选中方向后只生成提议时，省略 media 和 spatial 中的 candidateId，用 nodeId 关联提议节点');
    }
    for (const ref of output.spatial) {
      maps.allowed(ref.assetId, owner, scope.workspaceId || undefined);
      ensure(!ref.candidateId || output.candidates.some(c => c.id === ref.candidateId), '地图关联的候选不存在：candidateId 只能指向本次 candidates；选中方向后只生成提议时，省略 media 和 spatial 中的 candidateId，用 nodeId 关联提议节点');
      if (ref.nodeId) {
        ref.nodeId = mapping.get(ref.nodeId) || ref.nodeId;
        const data = proposal?.workspace.data || base?.data;
        ensure(data?.nodes[ref.nodeId] && (!base?.data.nodes[ref.nodeId] || !scope.nodeId || descendants(base.data, scope.nodeId).some(n => n.id === ref.nodeId)), '地图引用的安排不在当前范围');
      }
      for (const mid of ref.mediaIds) {
        new MediaStore(this.db).usable(mid, owner, scope.workspaceId || undefined);
        const matchingOutput = output.media.some(m => m.mediaId === mid && m.candidateId === ref.candidateId);
        const matchingPlan = !ref.candidateId && !!ref.nodeId && (proposal?.workspace.data.media?.[ref.nodeId] || base?.data.media?.[ref.nodeId] || []).includes(mid);
        ensure(matchingOutput || matchingPlan, '地图配图必须属于同一回答、候选或计划');
      }
    }
    const claims = output.claims.map(c => {
      const claim: AgentClaim = { ...c, nodeIds: c.nodeIds.map(id => mapping.get(id) || id) };
      if (proposal) {
        ensure(claim.nodeIds.every(id => proposal!.workspace.data.nodes[id]), '事实关联的节点不存在');
        if (!claim.nodeIds.length) claim.nodeIds = proposal.diffs.filter(d => 'dates' in (d.after || {})).map(d => d.id);
      }
      if (claim.spatialEvidence) {
        ensure(!claim.queryId && !claim.quote, '地图字段证据不能冒充网页原文');
        const a = maps.evidence(claim.spatialEvidence, owner, scope.workspaceId || undefined);
        ensure(claim.status === (a.source.provider === 'suggestion' || a.source.provider === 'manual' ? 'suggestion' : 'source_supported'), '空间证据状态与来源性质不符');
        if (proposal) ensure(maps.ids(proposal.workspace.data).has(a.id), '采用的地图证据必须关联到本提议正式地图内容');
        claim.text = spatialEvidenceText(a, claim.spatialEvidence);
        Object.assign(claim, { url: a.source.url, retrievedAt: a.source.retrievedAt, appliesTo: a.name, limitations: ['结构化地图字段；不核实开放、预约、票价或体验条件。'] });
      } else if (claim.status === 'source_supported') {
        ensure(claim.queryId && claim.quote, '来源支持需要查询和原文片段');
        const query = new BrowserStore(this.db).get(owner, claim.queryId);
        const page = query.result?.data;
        ensure(query.result && ['ok', 'partial'].includes(query.result.status) && page?.contentKind === 'page' && page.evidenceId, '来源没有可用正文');
        const matched = sourceQuote(page.text, claim.quote);
        ensure(matched, `引用 ${claim.id} 的片段没有出现在保存的正文中。请复制更短的连续原文，不拼接或改写；该条主张仅能包含片段支持的条件。`);
        claim.quote = matched;
        ensure(digest(page.text) === page.textHash, '来源正文哈希无效');
        Object.assign(claim, { url: page.url, retrievedAt: query.result.retrievedAt, textHash: page.textHash, limitations: [...query.result.limitations, ...query.result.missing] });
      } else ensure(!claim.queryId && !claim.quote, '只有来源支持的主张可绑定原文，其余请保留待查状态');
      return claim;
    });
    if (proposal) proposal.claims = claims;
    return { output, claims, proposal };
  }
  insert(runId: string, prepared: PreparedProposal) {
    const id = randomUUID(), body = canonical(prepared);
    const previous = this.db.prepare('SELECT max(p.revision) AS n FROM agent_proposals p JOIN agent_runs r ON r.id=p.run_id WHERE r.session_id=(SELECT session_id FROM agent_runs WHERE id=?)').get(runId) as { n: number | null };
    this.db.prepare("INSERT INTO agent_proposals(id,run_id,revision,digest,base_version,workspace_id,body,status,created) VALUES(?,?,?,?,?,?,?,'ready',?)").run(id, runId, (previous.n || 0) + 1, digest(body), prepared.before?.version ?? null, prepared.workspace.id, body, new Date().toISOString());
    return id;
  }
  row(id: string, owner: string) {
    const row = this.db.prepare('SELECT p.* FROM agent_proposals p JOIN agent_runs r ON r.id=p.run_id WHERE p.id=? AND r.owner_id=?').get(id, owner) as ProposalRow | undefined;
    ensure(row, '找不到本人的提议', 404);
    const body = JSON.parse(row.body) as PreparedProposal;
    ensure(digest(row.body) === row.digest, '提议摘要校验失败');
    if (body.scope.workspaceId) this.plans.access(body.scope.workspaceId, owner, false, true);
    return { row, body };
  }
  view(id: string, owner: string): ProposalView {
    const { row, body } = this.row(id, owner);
    let status = row.status as ProposalView['status'];
    if (row.change_id && (this.db.prepare('SELECT undone_by FROM changes WHERE id=?').get(row.change_id) as { undone_by: string | null })?.undone_by) status = 'undone';
    if (status === 'ready' && body.before && this.plans.get(row.workspace_id, true).version !== row.base_version) status = 'stale';
    const run = this.db.prepare('SELECT state FROM agent_runs WHERE id=?').get(row.run_id) as { state: string };
    const permitted = !body.before || this.plans.role(row.workspace_id, owner) !== 'reader';
    const spatial = (data?: WorkspaceData) => data ? descendants(data, body.scope.nodeId || data.rootId).flatMap((n, i) => (data.spatial?.[n.id] || []).map(b => ({ assetId: b.assetId, nodeId: n.id, mediaIds: b.mediaIds, optional: b.optional, stale: bindingStale(data, b), title: n.title, label: String(i + 1) }))) : [];
    return { id, revision: row.revision, digest: row.digest, baseVersion: row.base_version, title: body.title, status, workspaceId: row.workspace_id, changeId: row.change_id, diffs: body.diffs, assumptions: body.assumptions, claims: body.claims, canApply: status === 'ready' && permitted && ['completed', 'partial'].includes(run.state), shared: body.workspace.data.kind === 'trip', spatialBefore: spatial(body.before?.data), spatialAfter: spatial(body.workspace.data), warning: status === 'stale' ? '计划已更新，请对照最新内容重新生成建议。' : !permitted ? '当前为只读权限，可以研究但不能采用。' : null };
  }
  reject(id: string, owner: string) {
    const { row } = this.row(id, owner);
    ensure(!row.change_id, '已采用的修改请从历史撤销', 409);
    this.db.prepare("UPDATE agent_proposals SET status='rejected' WHERE id=?").run(id);
    return this.view(id, owner);
  }
  apply(id: string, owner: string, input: { revision: number; digest: string; baseVersion: number | null; requestId: string }) {
    return this.db.transaction(() => {
      const { row, body } = this.row(id, owner);
      if (body.before) this.plans.access(row.workspace_id, owner, true, true);
      const requestHash = digest(canonical({ id, ...input }));
      const prior = this.db.prepare('SELECT * FROM agent_apply_requests WHERE owner_id=? AND request_id=?').get(owner, input.requestId) as { request_hash: string; result: string } | undefined;
      if (prior) { ensure(prior.request_hash === requestHash, '同一请求标识不能用于不同修改', 409); return JSON.parse(prior.result) as { workspaceId: string; changeId: string }; }
      ensure(row.revision === input.revision && row.digest === input.digest && row.base_version === input.baseVersion, '预览版本与采用内容不一致', 409);
      let result: { workspaceId: string; changeId: string };
      if (row.change_id) result = { workspaceId: row.workspace_id, changeId: row.change_id };
      else {
        ensure(this.view(id, owner).canApply, '提议已过期、已放弃或尚未完成，请重新生成', 409);
        if (body.before) ensure(this.plans.get(row.workspace_id).version === row.base_version, '计划已更新，请重新生成建议', 409);
        const workspace = structuredClone(body.workspace);
        workspace.version = (row.base_version || 0) + 1;
        const maps = new MapStore(this.db);
        maps.readMany([...maps.ids(workspace.data)], owner, body.scope.workspaceId || undefined);
        for (const claim of body.claims) if (claim.spatialEvidence) maps.evidence(claim.spatialEvidence, owner, body.scope.workspaceId || undefined);
        this.plans.save(workspace);
        if (!body.before) this.db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')").run(workspace.id, owner);
        const changeId = randomUUID(); result = { workspaceId: workspace.id, changeId };
        this.db.prepare('INSERT INTO changes(id,user_id,request_id,request_body,label,before_data,after_versions,result,created) VALUES(?,?,?,?,?,?,?,?,?)').run(changeId, owner, input.requestId, canonical({ kind: 'agent_apply', proposalId: id, ...input }), `采用 AI 建议：${body.title}`, JSON.stringify({ [workspace.id]: body.before }), JSON.stringify({ [workspace.id]: workspace.version }), JSON.stringify(result), new Date().toISOString());
        for (const claim of body.claims) this.db.prepare('INSERT INTO agent_published_claims(id,proposal_id,workspace_id,query_id,body,dependencies,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, workspace.id, claim.queryId || null, JSON.stringify(claim), JSON.stringify(dependencies(workspace.data, claim.nodeIds)), new Date().toISOString());
        this.db.prepare("UPDATE agent_proposals SET status='applied',change_id=? WHERE id=?").run(changeId, id);
        const seq = (this.db.prepare('SELECT coalesce(max(seq),-1)+1 AS n FROM agent_events WHERE run_id=?').get(row.run_id) as { n: number }).n;
        this.db.prepare('INSERT INTO agent_events(run_id,seq,type,data,created) VALUES(?,?,?,?,?)').run(row.run_id, seq, 'proposal.applied', JSON.stringify(result), new Date().toISOString());
      }
      this.db.prepare('INSERT INTO agent_apply_requests(owner_id,request_id,request_hash,proposal_id,result) VALUES(?,?,?,?,?)').run(owner, input.requestId, requestHash, id, JSON.stringify(result));
      return result;
    })();
  }
  published(workspaceId: string, owner: string): PublishedClaim[] {
    const w = this.plans.access(workspaceId, owner);
    const rows = this.db.prepare('SELECT c.id,c.body,c.dependencies FROM agent_published_claims c JOIN agent_proposals p ON p.id=c.proposal_id JOIN changes h ON h.id=p.change_id WHERE c.workspace_id=? AND h.undone_by IS NULL ORDER BY c.rowid DESC').all(workspaceId) as { id: string; body: string; dependencies: string }[];
    return rows.map(row => {
      const claim = JSON.parse(row.body) as AgentClaim;
      const changed = claim.dynamic && !same(JSON.parse(row.dependencies), dependencies(w.data, claim.nodeIds));
      // Published excerpts intentionally omit the private query identifier.
      const { queryId: _query, ...publicClaim } = claim;
      return { ...publicClaim, publishedId: row.id, status: changed ? 'conditions_changed' : claim.status };
    });
  }
}

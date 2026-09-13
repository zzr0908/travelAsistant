import { SaveResearchNote } from './SaveResearchNote';
import { friendly } from './friendly';
import { RichContent } from './RichContent';
import { MediaGallery } from './MediaGallery';
import { AgentMap } from './AgentMap';
import { agentMediaTargets } from './map-media';
import type { SpatialSummary } from '../../shared/maps';
import { Trajectory } from './Trajectory';
import type { MediaAsset, MediaRecord, SpatialRecord } from '../../shared/agent';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles, X, ArrowUp, Square, ExternalLink, RefreshCw, Check, Undo2 } from 'lucide-react';
import { api, post, uid, ApiError } from './api';
import { dateLabel, type PlanNode, type Preparation } from '../../shared/model';
import type { AgentCapability, AgentRunView, AgentSessionView, AgentClaim, PublishedClaim, AgentScope, ProposalView } from '../../shared/agent';
import { ErrorNotice } from './Forms';

const labels = { user_provided: '用户提供', source_supported: '来源支持', suggestion: '建议／估计', unknown: '待核对', conflict: '来源冲突', conditions_changed: '条件已变，需复核' };
const runLabels = { queued: '等待中', running: '研究中', needs_input: '等待答复', completed: '本轮完成', partial: '部分结果', cancelling: '正在停止', cancelled: '已停止', failed: '未完成', interrupted: '已中断' };
const intro = (text: string) => { const blocks = text.replaceAll('\\n','\n').split(/\n\s*\n/); const first = blocks.slice(0,2).join('\n\n'); return first.length > 400 ? first.slice(0,400) + '…' : first; };
const isActive = (run?: AgentRunView) => !!run && ['queued','running','cancelling'].includes(run.state);
export function AgentEntry({ onOpen }: { onOpen(): void }) {
  return <button className="agent-entry-compact" onClick={onOpen}><Sparkles size={17}/>问问 AI</button>;
}
function Claims({ claims }: { claims: (AgentClaim | PublishedClaim)[] }) {
  if (!claims.length) return null;
  return <div className="agent-claims">{claims.map((claim, i) => <details className="agent-source" key={'publishedId' in claim ? claim.publishedId : `${claim.id}-${i}`}>
    <summary><span className={`claim-label ${claim.status}`}>{labels[claim.status]}</span><span>{claim.text}</span></summary>
    {claim.appliesTo && <p>适用条件：{claim.appliesTo}</p>}
    {claim.spatialEvidence && <p className="subtle">结构化地图字段证据 · {claim.spatialEvidence.field}</p>}{claim.quote && <blockquote>{claim.quote}</blockquote>}
    {claim.url && /^https:\/\//.test(claim.url) && <a href={claim.url} target="_blank" rel="noreferrer">打开原始来源 <ExternalLink size={13}/></a>}
    {claim.retrievedAt && <p className="subtle">查阅于 {new Date(claim.retrievedAt).toLocaleString()}</p>}
    {!!claim.limitations?.length && <p className="subtle">读取限制：{claim.limitations.map(friendly).join('；')}</p>}
  </details>)}</div>;
}
export function SharedEvidence({ workspaceId, version, onReview }: { workspaceId: string; version: number; onReview(): void }) {
  const [claims, setClaims] = useState<PublishedClaim[]>([]);
  useEffect(() => { let live = true; api<{ claims: PublishedClaim[] }>(`/api/workspaces/${workspaceId}/agent-evidence`).then(r => { if (live) setClaims(r.claims); }).catch(() => { if (live) setClaims([]); }); return () => { live = false; }; }, [workspaceId, version]);
  if (!claims.length) return null;
  return <section className="panel published-evidence"><h3>安排的依据与待查事项</h3><p className="subtle">采用时保存的来源摘要，旅行成员均可查看。</p><Claims claims={claims}/>{claims.some(c => c.status === 'conditions_changed') && <button onClick={onReview}><RefreshCw size={15}/>请 AI 重新核对</button>}</section>;
}
function RecordPreview({ record, names, media = [], spatial = [] }: { record: PlanNode | Preparation | MediaRecord | SpatialRecord | null; names: Record<string,string>; media?: MediaAsset[]; spatial?: SpatialSummary[] }) {
  if (!record) return <p className="subtle">尚无这项内容</p>;
  if ('bindings' in record) return <><strong>{record.title}</strong>{record.bindings.length ? <ul>{record.bindings.map(b => <li key={b.assetId}>{spatial.find(a => a.id === b.assetId)?.name || '位置当前不可访问'}{b.primary ? ' · 主地点' : ''}{b.optional ? ' · 可选停留' : ''}{b.nodeIds.length ? ` · ${b.nodeIds.map(id => names[id] || '安排').join(' → ')}` : ''}{b.mediaIds.length ? ` · ${b.mediaIds.length} 张配图` : ''}</li>)}</ul> : <p>没有地图关联</p>}</>;
  if ('mediaIds' in record) return <><strong>{record.title}</strong><p>{record.mediaIds.length} 张配图</p><MediaGallery images={media.filter(m => record.mediaIds.includes(m.id))} empty/></>;
  if ('steps' in record) return <><strong>{record.title}</strong><p>{record.note || '无补充说明'}</p><p className="subtle">关联：{record.nodeIds.map(id => names[id] || '已有安排').join('、')}</p><ol>{record.steps.map(s => <li key={s.id}>{s.text}</li>)}</ol></>;
  return <><strong>{record.title}</strong><p>{dateLabel(record.dates)} · {record.dates.timezone}</p><p className="subtle">{record.kind === 'free' ? '自由安排' : record.kind === 'activity' ? '活动' : '计划'} · {record.fixed ? '固定事项' : '可调整'} · 顺序 {record.order + 1} · {record.parentId ? names[record.parentId] || '已有上级计划' : '根计划'}</p>{record.description && <p>{record.description}</p>}{record.preference && <p>偏好：{record.preference}</p>}{record.notes && <p>备注：{record.notes}</p>}{record.location.name && <p>地点：{record.location.name}{record.location.address ? ` · ${record.location.address}` : ''}{record.location.lat !== null ? `（${record.location.lat}, ${record.location.lng}）` : ' · 坐标待补充'}</p>}</>;
}
export function AgentPanel(props: { userId: string; scope: AgentScope; title: string; names: Record<string,string>; initialPrompt?: string; researchKey?: string; onClose(): void; onApplied(workspaceId: string): Promise<void>; onNoteSaved(workspaceId:string):Promise<void>; onUndo(changeId: string): Promise<unknown> }) {
  const [savingNote,setSavingNote]=useState<AgentRunView>();
  const initialScopeKey = `${props.userId}:${props.scope.workspaceId || 'new'}:${props.scope.nodeId || 'root'}${props.researchKey ? ':'+props.researchKey : ''}`;
  const binding = useRef((() => {try {const value=JSON.parse(sessionStorage.getItem(`agent-binding:${initialScopeKey}`) || 'null');return value?.scope && typeof value.title==='string' && typeof value.sessionId==='string' ? value as {scope:AgentScope;title:string;sessionId:string}:null;}catch{return null;}})()).current;
  const [scope, setScope] = useState(binding?.scope || props.scope), [bindingTitle, setBindingTitle] = useState(binding?.title || props.title);
  const scopeKey = `${props.userId}:${scope.workspaceId || 'new'}:${scope.nodeId || 'root'}${props.researchKey ? ':'+props.researchKey : ''}`;
  const [sessions, setSessions] = useState<AgentSessionView[]>([]), [sessionId, setSessionId] = useState(() => binding?.sessionId || sessionStorage.getItem(`agent-session:${scopeKey}`) || '');
  const [runs, setRuns] = useState<AgentRunView[]>([]), [capability, setCapability] = useState<AgentCapability | null>(null);
  const [draft, setDraft] = useState(() => props.researchKey ? (sessionStorage.getItem(`agent-draft:${scopeKey}`) ?? props.initialPrompt ?? '') : (props.initialPrompt || sessionStorage.getItem(`agent-draft:${scopeKey}`) || '')), [error, setError] = useState(''), [busy, setBusy] = useState(false), [connection, setConnection] = useState('');
  const [mapView, setMapView] = useState<{runId: string; tab: string; focus?: {itemId:string;key:string}} | null>(null);
  const mapOpener = useRef<HTMLButtonElement | null>(null);
  const mapOriginTop = useRef(0);
  const openMap = (runId: string, tab: string, button: HTMLButtonElement, itemId?: string) => { mapOpener.current = button; mapOriginTop.current=button.getBoundingClientRect().top; setMapView({runId,tab,...(itemId?{focus:{itemId,key:uid()}}:{})}); };
  const closeMap = () => { setMapView(null); requestAnimationFrame(() => {const button=mapOpener.current;if(button?.isConnected){button.focus({preventScroll:true});if(bodyRef.current)bodyRef.current.scrollTop+=button.getBoundingClientRect().top-mapOriginTop.current;}}); };
  const [preview, setPreview] = useState<string | null>(null), [answer, setAnswer] = useState('');
  const requestIds = useRef(new Map<string,string>()), cursor = useRef(new Map<string,number>()), liveSession = useRef(sessionId), textarea = useRef<HTMLTextAreaElement>(null);
  liveSession.current = sessionId;
  const bodyRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null), restored = useRef(''), restoring = useRef(false);
  useEffect(() => {
    const body=bodyRef.current,content=contentRef.current;
    if(!runs.length || restored.current === sessionId || !body || !content)return;
    const target=Number(sessionStorage.getItem(`agent-scroll:${props.userId}:${sessionId}`) || 0);restoring.current=true;
    const place=()=>{if(restoring.current)body.scrollTop=target;};
    const finish=()=>{restoring.current=false;restored.current=sessionId;observer.disconnect();};
    const observer=new ResizeObserver(place);observer.observe(content);place();
    const timer=setTimeout(finish,1200);
    body.addEventListener('wheel',finish,{once:true});body.addEventListener('touchstart',finish,{once:true});body.addEventListener('keydown',finish,{once:true});body.addEventListener('pointerdown',finish,{once:true});
    return()=>{clearTimeout(timer);observer.disconnect();body.removeEventListener('wheel',finish);body.removeEventListener('touchstart',finish);body.removeEventListener('keydown',finish);body.removeEventListener('pointerdown',finish);restoring.current=false;};
  }, [runs.length > 0,sessionId]);
  const last = runs.at(-1), active = isActive(last);
  const requestId = (key: string) => { if (!requestIds.current.has(key)) requestIds.current.set(key, uid()); return requestIds.current.get(key)!; };
  const refreshSequence = useRef(0), appliedSequence = useRef(0);
  const refresh = async (id = liveSession.current) => {
    if (!id) return;
    const sequence=++refreshSequence.current;
    const data = await api<{ runs: AgentRunView[] }>(`/api/agent/sessions/${id}`);
    if (id === liveSession.current && sequence >= appliedSequence.current) { appliedSequence.current=sequence;setRuns(data.runs); setConnection(''); }
  };
  const refreshSessions = () => api<{ sessions: AgentSessionView[] }>('/api/agent/sessions').then(r => setSessions(r.sessions));
  useEffect(() => { let alive=true; const refreshCapability=()=>void api<AgentCapability>('/api/agent/status').then(value=>{if(alive)setCapability(value);}).catch(()=>{}); refreshCapability(); const timer=setInterval(refreshCapability,5000); void refreshSessions().catch(e => setError(e.message)); textarea.current?.focus(); return ()=>{alive=false;clearInterval(timer);}; }, []);
  useEffect(() => {sessionStorage.setItem(`agent-binding:${initialScopeKey}`,JSON.stringify({scope,title:bindingTitle,sessionId}));},[scope,bindingTitle,sessionId]);
  useEffect(() => { sessionStorage.setItem(`agent-draft:${scopeKey}`, draft); }, [draft, scopeKey]);
  useEffect(() => { if (!sessionId) { sessionStorage.removeItem(`agent-session:${scopeKey}`); setRuns([]); return; } sessionStorage.setItem(`agent-session:${scopeKey}`, sessionId); void refresh(sessionId).catch(e => setError(e.message)); }, [sessionId]);
  useEffect(() => {
    if (!last) return;
    const id = last.id;
    const stream = new EventSource(`/api/agent/runs/${id}/events?after=${cursor.current.get(id) ?? -1}`);
    const receive = (event: MessageEvent) => { const seq = Number(event.lastEventId); if (seq <= (cursor.current.get(id) ?? -1)) return; cursor.current.set(id, seq); void refresh().catch(e => setConnection(e.message)); };
    for (const name of ['run.status','research.started','research.finished','map.finished','map.failed','result.ready','question.ready','question.answered','proposal.applied','result.staged']) stream.addEventListener(name, receive as EventListener);
    stream.onerror = () => setConnection('连接中断，正在重连；已保存内容仍可查看。');
    const timer = setInterval(() => void refresh().catch(e => setConnection(e.message)), 2500);
    return () => { stream.close(); clearInterval(timer); };
  }, [last?.id, sessionId]);
  async function send(text = draft, parentRunId?: string, selectedCandidateId?: string) {
    if (!text.trim() || active || busy || !capability?.available) return;
    setBusy(true); setError('');
    const body = { ...scope, ...(props.researchKey ? {researchPlaceIds:[props.researchKey]} : {}), prompt: text.trim(), ...(sessionId ? { sessionId } : {}), ...(parentRunId ? { parentRunId } : {}), ...(selectedCandidateId ? { selectedCandidateId } : {}) }, key = JSON.stringify(body);
    try {
      const run = await post<AgentRunView>('/api/agent/runs', { ...body, requestId: requestId(key) });
      requestIds.current.delete(key); liveSession.current = run.sessionId; setSessionId(run.sessionId); setRuns(old => [...old.filter(r => r.id !== run.id), run]); setDraft(''); setPreview(null); setMapView(null); await refreshSessions();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function submitAnswer(run: AgentRunView, text: string, selectedCandidateId?: string) {
    if (active || busy || !capability?.available) return;
    setBusy(true); setError(''); const key = `answer:${run.id}:${selectedCandidateId || ""}:${text}`;
    try { const next = await post<AgentRunView>(`/api/agent/questions/${run.id}/answer`, { answer: text, selectedCandidateId, requestId: requestId(key) }); requestIds.current.delete(key); setAnswer(''); setRuns(old => [...old.filter(r => r.id !== next.id), next]); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function apply(proposal: ProposalView) {
    setBusy(true); setError(''); const key = `apply:${proposal.id}:${proposal.revision}`;
    try {
      const result = await post<{ workspaceId: string; changeId: string }>(`/api/agent/proposals/${proposal.id}/apply`, { requestId: requestId(key), revision: proposal.revision, digest: proposal.digest, baseVersion: proposal.baseVersion });
      requestIds.current.delete(key); await refresh(); await props.onApplied(result.workspaceId);
    } catch (e) { setError((e as Error).message); if ((e as ApiError).status === 409) await refresh(); } finally { setBusy(false); }
  }
  async function cancel() { if (!last) return; setBusy(true); try { await post(`/api/agent/runs/${last.id}/cancel`, {}); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const names = { ...props.names, ...Object.fromEntries(runs.flatMap(r => r.proposal?.diffs.filter(d => d.after).map(d => [d.id, d.after!.title]) || [])) };
  return <aside className="agent-panel" aria-label="AI 规划助手">
    <header className="agent-panel-header"><div><p className="overline"><Sparkles size={14}/> AI 规划助手</p><h2>{bindingTitle}</h2><p className="subtle">{capability?.message || '正在读取模型状态'}</p></div><button className="icon-button" aria-label="关闭 AI 面板" onClick={props.onClose}><X size={21}/></button></header>
    <div className="agent-session-select"><label htmlFor="agent-history">研究记录</label><select id="agent-history" value={sessionId} onChange={e => { if (e.target.value === sessionId) return; const session = sessions.find(s => s.id === e.target.value); const nextScope = session?.scope || props.scope; setDraft(sessionStorage.getItem(`agent-draft:${props.userId}:${nextScope.workspaceId || 'new'}:${nextScope.nodeId || 'root'}${props.researchKey ? ':'+props.researchKey : ''}`) || ''); setRuns([]); setSessionId(e.target.value); setPreview(null); setMapView(null); if (session) { setScope(session.scope); setBindingTitle(session.title); } else { setScope(props.scope); setBindingTitle(props.title); } }}><option value="">开始新讨论</option>{sessions.map(s => <option value={s.id} key={s.id}>{s.title} · {new Date(s.updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</option>)}</select></div>
    <div className="agent-panel-body" ref={bodyRef} onScroll={e => { if (sessionId && !restoring.current) sessionStorage.setItem(`agent-scroll:${props.userId}:${sessionId}`, String(e.currentTarget.scrollTop)); }}><div ref={contentRef}>
      <ErrorNotice error={error}/>{connection && <p className="alert warning" role="status">{connection}</p>}
      {!runs.length && sessionId && !error && <p role="status">正在打开这次讨论…</p>}
      {!runs.length && (!sessionId || !!error) && <div className="agent-intro"><h3>{props.researchKey ? "了解这处看点" : "从你现在的想法开始"}</h3><p>{props.researchKey ? "已带入地点资料。可以补充你的兴趣或问题，再开始研究。" : "可以先起草两天的安排，也可以只细化当前这部分。日期和地点还不完整也没关系。"}</p>{!props.researchKey && <div className="agent-shortcuts">{['起草安排','细化这部分','核对开放与预约','整理准备'].map(text => <button key={text} onClick={() => { setDraft(text); textarea.current?.focus(); }}>{text}</button>)}</div>}<p className="subtle">研究与草案默认仅本人可见。采用到共同计划前，会列明要公开的安排及来源摘要。</p></div>}
      {runs.map(run => <article className="agent-turn" key={run.id}>
        {run.prompt.length > 180 ? <details className="agent-user-message agent-prompt"><summary><span>{run.prompt.slice(0,70)}…</span><span className="prompt-disclosure">查看完整需求</span></summary><p>{run.prompt}</p></details> : <div className="agent-user-message">{run.prompt}</div>}
        <div className="agent-run-status" role="status"><span className={isActive(run) ? 'status-dot active' : 'status-dot'}/>{run.questionAnswered ? '已答复' : runLabels[run.state]}<span className="subtle">{run.scopeLabel}</span></div>
        <p className="subtle">{run.questionAnswered ? '答复已保存，后续结果见下方。' : friendly(run.message)}</p>
        {mapView?.runId === run.id && <AgentMap run={run} tab={mapView.tab} focus={mapView.focus} onTab={tab => setMapView({runId:run.id,tab})} onClose={closeMap}/>}
        {!!run.output?.spatial.length && !run.output.candidates.length && mapView?.runId !== run.id && <button onClick={e => openMap(run.id, 'answer', e.currentTarget)}>查看回答地图</button>}
        {run.output && <><div className="agent-answer"><RichContent text={run.output.candidates.length ? intro(run.output.answer) : run.output.answer}/></div>{!run.output.candidates.length && <MediaGallery images={run.media} empty={run.usage.browserQueries > 0} title="相关来源图片" onRetry={() => void refresh()} mapTargets={agentMediaTargets(run)} onLocate={(target,button)=>openMap(run.id,target.tab!,button,target.itemId)}/>}
          {!!run.output.candidates.length && <div className="agent-candidates">{run.output.candidates.map(c => <div className="agent-candidate" key={c.id}><h3>{c.title}</h3>{run.output!.spatial.some(r => r.candidateId === c.id) && <button onClick={e => openMap(run.id, `candidate:${c.id}`, e.currentTarget)}>在地图上查看</button>}<MediaGallery images={run.media.filter(m => run.output!.media.some(ref => ref.mediaId === m.id && ref.candidateId === c.id))} title="候选配图" mapTargets={agentMediaTargets(run,c.id)} onLocate={(target,button)=>openMap(run.id,target.tab!,button,target.itemId)}/><RichContent text={c.description}/><div className="subtle"><strong>取舍</strong><RichContent text={c.tradeoffs}/></div><button disabled={active || busy || !capability?.available} onClick={() => { const choice = `我选择“${c.title}”。${c.description}\n请按这个方向细化并生成完整变更提议。`; void (run.state === 'needs_input' && run.output?.question && !run.questionAnswered ? submitAnswer(run, choice, c.id) : send(choice, run.id, c.id)); }}>选择并细化</button></div>)}</div>}
          {!!run.output.candidates.length && <MediaGallery images={run.media.filter(m => m.status === "ready" && !run.output!.media.some(ref => ref.mediaId === m.id && ref.candidateId))} title="补充来源图片"/>}
          {!!run.output.candidates.length && <details className="agent-comparison"><summary>完整比较与待查条件</summary><RichContent text={run.output.answer}/></details>}<Claims claims={run.output.claims}/>{!isActive(run) && <button onClick={()=>setSavingNote(run)}>保存为笔记</button>}{!!run.output.candidates.length && run.media.some(m => m.status === "failed" || m.status === "reference_only") && <MediaGallery images={run.media.filter(m => m.status === "failed" || m.status === "reference_only")} title="尚未取得的图片" onRetry={() => void refresh()}/>}
          {run.state === 'needs_input' && run.output.question && !run.questionAnswered && <section className="agent-question"><h3>{run.output.question.text}</h3>{run.output.question.options.map(option => <button disabled={busy || active || !capability?.available} key={option} onClick={() => void submitAnswer(run, option)}>{option}</button>)}<label>你的答复<textarea value={answer} onChange={e => setAnswer(e.target.value)} rows={2}/></label><button disabled={busy || active || !capability?.available || (!answer.trim() && run.output.question.required)} onClick={() => void submitAnswer(run, answer)}>提交答复</button>{!run.output.question.required && <button disabled={busy || active || !capability?.available} onClick={() => void submitAnswer(run, '')}>跳过，保留未知</button>}</section>}
        </>}
        {run.proposal && <section className="agent-proposal"><div className="agent-proposal-heading"><h3>{run.proposal.title}</h3><span className="subtle">{run.proposal.diffs.length} 项变更</span></div>
          {run.proposal.status === 'applied' || run.proposal.status === 'undone' ? <div className="button-row"><span><Check size={15}/> {run.proposal.status === 'undone' ? '本笔采用已撤销' : '已采用到计划'}</span>{run.proposal.status === 'applied' && <button disabled={busy} onClick={async () => { setBusy(true); try { await props.onUndo(run.proposal!.changeId!); await refresh(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><Undo2 size={15}/>撤销本笔采用</button>}</div> : run.proposal.status === 'rejected' ? <p className="subtle">已放弃，正式计划未改变。</p> : <>
            {run.proposal.warning && <p className="alert warning">{run.proposal.warning}</p>}
            <button onClick={() => setPreview(preview === run.proposal!.id ? null : run.proposal!.id)}>{preview === run.proposal.id ? '收起变更' : '查看完整变更'}</button>
            {preview === run.proposal.id && <div className="agent-diffs">{((run.proposal.spatialBefore?.length || 0) + (run.proposal.spatialAfter?.length || 0) > 0) && <button onClick={e => openMap(run.id, 'after', e.currentTarget)}>在地图上比较变更</button>}{run.proposal.diffs.map(diff => <details key={diff.id} open><summary>{diff.kind}：{diff.after?.title}</summary><div className="agent-diff-columns"><div><span className="overline">修改前</span><RecordPreview record={diff.before} names={names} media={run.media} spatial={run.spatial}/></div><div><span className="overline">采用后</span><RecordPreview record={diff.after} names={names} media={run.media} spatial={run.spatial}/></div></div></details>)}
              {!!run.proposal.assumptions.length && <div><h4>假设与待查项</h4><ul>{run.proposal.assumptions.map((s,i) => <li key={i}>{s}</li>)}</ul></div>}
              {run.proposal.shared && <div className="agent-share-notice"><strong>采用后向旅行成员公开</strong><p>上方全部安排、准备内容、地图关联、所选配图，以及以下来源摘要；私人对话保持私有。</p><Claims claims={run.proposal.claims}/></div>}
              <div className="button-row"><button className="primary" disabled={busy || !run.proposal.canApply} onClick={() => void apply(run.proposal!)}>采用全部</button><button disabled={busy || active} onClick={() => { setDraft('请调整这份建议：'); textarea.current?.focus(); }}>调整建议</button><button disabled={busy} onClick={async () => { setBusy(true); try { await post(`/api/agent/proposals/${run.proposal!.id}/reject`, {}); await refresh(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>放弃</button></div>
            </div>}
            {run.proposal.status === 'stale' && <button disabled={busy || active || !capability?.available} onClick={() => void send(`请按最新计划重新检查这份建议并生成新版本。原需求：${run.prompt}`, run.id)}><RefreshCw size={15}/>按最新计划重新生成</button>}
          </>}
        </section>}
        {['cancelled','failed','interrupted','partial'].includes(run.state) && !active && <button disabled={busy || !capability?.available} onClick={() => void send(`继续处理以下需求，先重新检查最新计划与已有缺口：${run.prompt}`, run.id)}>继续这项研究</button>}
        <Trajectory run={run}/><details className="agent-usage"><summary>本次用量</summary><p>{run.usage.modelRequests} 次模型请求 · {run.usage.browserQueries} 次网页查询 · {run.usage.mapQueries || 0} 次地图查询（估算 {run.usage.mapEstimatedCredits == null ? '未知' : run.usage.mapEstimatedCredits} credits，底图资源另计） · {run.usage.tokens === null ? 'token 用量未知' : `${run.usage.tokens.toLocaleString()} tokens（含缓存）`} · 费用未计量</p>{!!run.usage.responseModels.length && <p>响应模型：{run.usage.responseModels.join('、')}</p>}</details>
      </article>)}
    </div></div>
    {savingNote && <SaveResearchNote run={savingNote} onClose={()=>setSavingNote(undefined)} onSaved={props.onNoteSaved}/>}
    <form className="agent-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}><label htmlFor="agent-input">{active ? '研究进行中，可先保留下一条想法' : props.researchKey ? '想了解什么？' : '你想怎样规划？'}</label><textarea id="agent-input" ref={textarea} rows={3} value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} placeholder="例如：佛罗伦萨两天，喜欢艺术和散步，日期未定。"/><div className="agent-composer-actions"><span className="subtle">采用前不会修改计划</span>{active ? <button type="button" disabled={busy || last?.state === 'cancelling'} onClick={() => void cancel()}><Square size={14}/>停止研究</button> : <button className="primary" type="submit" disabled={busy || !draft.trim() || !capability?.available}>开始研究 <ArrowUp size={16}/></button>}</div></form>
  </aside>;
}

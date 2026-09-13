import { friendly } from './friendly';
import { TraceInspector } from './TraceInspector';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, ChevronDown, Copy, Download, Search } from 'lucide-react';
import { api } from './api';
import type { AgentRunView } from '../../shared/agent';
import type { TraceItem, TracePage } from '../../shared/trajectory';
const duration = (ms: number) => ms < 1000 ? `${ms} 毫秒` : ms < 60000 ? `${(ms/1000).toFixed(1)} 秒` : `${Math.floor(ms/60000)} 分 ${Math.round(ms%60000/1000)} 秒`;
const time = (value: string) => new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const storage = <T,>(key: string, fallback: T): T => { try { return JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
function TraceRow({runId, item, expanded, onToggle}: {runId:string; item:TraceItem; expanded:boolean; onToggle():void}) {
  const [wide,setWide] = useState(false), wideTrigger=useRef<HTMLButtonElement|null>(null);
  const [detail, setDetail] = useState<unknown>(null), [error,setError] = useState(''), [copied,setCopied] = useState(false), [loading,setLoading] = useState(false);
  async function fetchDetail() {setLoading(true);setError('');try {setDetail(await api(`/api/agent/runs/${runId}/trajectory/${encodeURIComponent(item.id)}`));} catch(e) {setError((e as Error).message);} finally {setLoading(false);}}
  useEffect(() => {if (expanded && !detail) void fetchDetail();}, [expanded]);
  return <li className={`trace-row ${item.status}`} id={`trace-${runId}-${item.id.replace(':','-')}`}>
    <span className="trace-marker" aria-hidden="true">{item.status === 'error' || item.status === 'warning' ? <AlertCircle size={14}/> : item.status === 'success' ? <CheckCircle2 size={14}/> : <span/>}</span>
    <button className="trace-row-heading" aria-expanded={expanded} aria-controls={`trace-detail-${runId}-${item.id}`} onClick={onToggle}>
      <span className="trace-row-title"><span>{item.title}</span><span className="trace-row-meta">{item.step ? `步骤 ${item.step} · ` : ''}{time(item.time)}{item.durationMs !== null ? ` · ${duration(item.durationMs)}` : ''} · {item.origin === 'harness' ? 'Harness' : item.origin === 'change' ? '计划修改' : '应用'} {item.seq !== null ? `#${item.seq}` : ''}</span>{item.summary && <span className="trace-row-description">{friendly(item.summary)}</span>}</span><ChevronDown size={16} className={expanded ? 'is-open' : ''}/>
    </button>
    {expanded && <div className="trace-detail" id={`trace-detail-${runId}-${item.id}`}>
      {loading && <p role="status">正在读取完整记录…</p>}{error && <div role="alert"><p>{error}</p><button onClick={() => void fetchDetail()}>重试读取详情</button></div>}
      {detail !== null && <><div className="trace-detail-toolbar"><span>原始详情 · {Math.ceil(item.detailBytes/1024)} KB</span><button onClick={e=>{wideTrigger.current=e.currentTarget;setWide(true);}}>展开宽视图</button><button onClick={async () => {try {await navigator.clipboard.writeText(JSON.stringify(detail,null,2));setCopied(true);setTimeout(()=>setCopied(false),2000);} catch {setError('复制失败，可选中详情复制或导出完整轨迹。');}}}><Copy size={14}/>{copied ? '已复制' : '复制详情'}</button></div><pre tabIndex={0} aria-label={`${item.title}的完整原始记录`}>{JSON.stringify(detail,null,2)}</pre><p className="subtle">已隐藏凭据与敏感 URL 参数。若存在提供方返回的 reasoning 字段，它属于原始记录；未返回时不补写。</p></>}
    </div>}{wide && <TraceInspector title={item.title} value={detail} onClose={()=>{setWide(false);requestAnimationFrame(()=>{if(document.activeElement && ![document.body,document.documentElement,wideTrigger.current].includes(document.activeElement as HTMLElement))return;wideTrigger.current?.focus({preventScroll:true});});}}/>}
  </li>;
}
export function Trajectory({run}: {run: AgentRunView}) {
  const key = `trajectory:${run.id}`, saved = useRef(storage(key,{open:false,filter:'key',q:'',expanded:[] as string[]})).current;
  const [open,setOpen] = useState(saved.open), [filter,setFilter] = useState(saved.filter), [q,setQ] = useState(saved.q), [query,setQuery] = useState(saved.q), [expanded,setExpanded] = useState<string[]>(saved.expanded);
  const [page,setPage] = useState<TracePage | null>(null), [items,setItems] = useState<TraceItem[]>([]), [next,setNext] = useState<number|null>(null), [loading,setLoading] = useState(false), [error,setError] = useState(''), [exporting,setExporting] = useState(false), [message,setMessage] = useState(''), [newEvents,setNewEvents]=useState(0);
  const [errorAction,setErrorAction] = useState<'read'|'export'>('read');
  const generation = useRef(0), count = useRef(40), previousTotal = useRef<number|null>(null), container = useRef<HTMLElement>(null);
  const active = ['queued','running','cancelling'].includes(run.state);
  useEffect(() => {sessionStorage.setItem(key,JSON.stringify({open,filter,q,expanded}));}, [open,filter,q,expanded]);
  useEffect(() => {const t=setTimeout(()=>setQuery(q),180);return()=>clearTimeout(t);},[q]);
  async function load(append = false, quiet = false) {
    const current = ++generation.current; if(!quiet)setLoading(true);setError('');
    try {
      const limit = append ? (next || 0) + 40 : count.current, all: TraceItem[] = [];
      let result:TracePage | null = null, offset = append ? next || 0 : 0;
      do {result=await api<TracePage>(`/api/agent/runs/${run.id}/trajectory?offset=${offset}&filter=${filter}&q=${encodeURIComponent(query)}`);if (current !== generation.current) return;all.push(...result.items);offset=result.nextOffset || 0;} while(!append && offset && offset < limit);
      if(quiet && previousTotal.current !== null && result!.total > previousTotal.current) {const added=result!.total-previousTotal.current;setNewEvents(n=>n+added);}previousTotal.current=result!.total;
      setPage(result);setNext(result!.nextOffset);setItems(previous => append ? [...previous,...all.filter(a=>!previous.some(b=>a.id===b.id))] : all);count.current=limit;
    } catch(e) {if(current===generation.current){setError((e as Error).message);setErrorAction('read');}} finally {if(current===generation.current)setLoading(false);}
  }
  useEffect(() => {count.current=40;setMessage('');void load();return()=>{generation.current++;};},[filter,query]);
  useEffect(() => {if(!open || !active)return;const t=setInterval(()=>void load(false,true),3000);return()=>clearInterval(t);},[open,active,filter,query]);
  useEffect(() => {void load(false,true);},[run.state,run.proposal?.status,run.trajectoryRevision]);
  const counts = page?.counts;
  async function exportTrace() {
    setExporting(true);setError('');setMessage('');
    try {
      const response=await fetch(`/api/agent/runs/${run.id}/trajectory-export`,{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('导出失败，请确认研究访问权限与连接后重试。');
      const blob=await response.blob();JSON.parse(await blob.text());
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`travel-trajectory-${run.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('完整轨迹已导出，包含本次全部已保存事件与关联资料。');
    } catch(e) {setError(e instanceof Error && e.message.startsWith('导出失败') ? e.message : '导出失败，请检查与部署电脑的连接后重试。');setErrorAction('export');} finally {setExporting(false);}
  }
  return <section ref={container} className="trajectory" aria-label="执行轨迹">
    <button className="trajectory-toggle" aria-expanded={open} aria-controls={`trajectory-body-${run.id}`} onClick={() => {setOpen(x=>!x);if(!open)void load();}}><Activity size={17}/><strong>执行轨迹</strong><span>{run.usage.modelRequests} 次模型 · {run.usage.browserQueries ? `${counts?.pages ?? '…'} 页正文` : '未查阅网页'}{run.usage.mapQueries ? ` · ${run.usage.mapQueries} 次地图查询` : ''}{counts?.errors ? ` · ${counts.errors} 条异常` : ''}</span><ChevronDown size={16} className={open ? 'is-open' : ''}/></button>
    {open && <div className="trajectory-body" id={`trajectory-body-${run.id}`}>
      <div className="trace-overview"><div><span>执行耗时</span><strong>{page ? duration(page.durationMs) : '读取中'}</strong></div><div><span>网页查阅</span><strong>{run.usage.browserQueries ? `${counts?.pages ?? '…'} 页正文 / ${run.usage.browserQueries} 次查询` : '未查阅网页'}</strong></div><div><span>地图查阅</span><strong>{run.usage.mapQueries ?? 0} 次查询</strong></div><div><span>来源支持</span><strong>{counts?.claims ?? 0} 条主张</strong></div><div><span>来源图片</span><strong>{counts?.media ?? 0} 张已保存</strong></div></div>
      {!!counts?.failedQueries && <p className="trace-warning">{counts.failedQueries} 次网页查询未取得有效正文；读取失败不代表已核实事实。</p>}
      {!!page?.gaps.length && <div className="trace-warning" role="status"><strong>记录完整性提示</strong>{page.gaps.map(g=><p key={g}>{g}</p>)}</div>}
      {page && !page.hasRequestSnapshot && <p className="subtle">此历史记录没有逐次请求快照。可查看已保存的请求配置和有序消息，无法确认未记录的请求字段。</p>}
      <div className="trace-toolbar"><label className="trace-search"><Search size={16}/><input aria-label="搜索本次全部轨迹" type="search" placeholder="搜索本次全部记录与参数" value={q} onChange={e=>setQ(e.target.value)}/></label><select aria-label="轨迹筛选" value={filter} onChange={e=>setFilter(e.target.value)}><option value="key">关键过程</option><option value="all">全部记录</option><option value="errors">异常记录</option><option value="model">模型请求与返回</option><option value="tools">工具与资料</option><option value="changes">计划修改</option></select></div>
      <div className="trace-actions">{newEvents > 0 && <button onClick={()=>{setNewEvents(0);setMessage("新记录已按时间顺序加入，下方可继续查看。");}}>新增 {newEvents} 条记录</button>}<button onClick={()=>{setFilter('errors');setQ('');setMessage('已显示异常记录，按时间顺序定位。');}}><AlertCircle size={15}/>定位异常</button><button disabled={exporting} onClick={()=>void exportTrace()}><Download size={15}/>{exporting ? '正在导出全部…' : '导出完整轨迹'}</button>{expanded.length > 0 && <button onClick={()=>setExpanded([])}>收起所有详情</button>}</div>
      {loading && <p className="trace-feedback" role="status">正在读取轨迹…</p>}{error && <div className="trace-warning" role="alert">{error}<button disabled={exporting} onClick={()=>void(errorAction==='export'?exportTrace():load())}>{errorAction==='export'?'重试导出':'重试读取'}</button></div>}{message && <p role="status" className="subtle">{message}</p>}
      {page && <p className="trace-count">显示 {items.length} / {page.matching} 条匹配记录 · 本次共 {page.total} 条（Harness {page.counts.harness} · 应用 {page.counts.application} · 修改 {page.counts.changes}）</p>}
      {!loading && !items.length && <p className="trace-empty">{query ? '本次全部已保存记录中没有匹配内容。' : filter === 'errors' ? '尚未记录异常。' : '尚无符合筛选条件的记录。'}</p>}
      <ol className="trace-list">{items.map((item,index)=><Fragment key={item.id}>{item.step && item.step !== items[index-1]?.step && <li className="trace-step-heading">第 {item.turn || 1} 轮 · 步骤 {item.step}<span>模型请求与工具执行</span></li>}<TraceRow runId={run.id} item={item} expanded={expanded.includes(item.id)} onToggle={()=>setExpanded(ids=>ids.includes(item.id)?ids.filter(id=>id!==item.id):[...ids,item.id])}/></Fragment>)}</ol>
      {next !== null && <button className="trace-load-more" disabled={loading} onClick={()=>void load(true)}>加载后续记录（检索与导出覆盖全部）</button>}
      <p className="trace-footnote">运行标识 <code>{run.id}</code> · 查看记录不会重新执行工具。</p>
    </div>}
  </section>;
}

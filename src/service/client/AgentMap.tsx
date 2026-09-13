import { lazy, Suspense, useEffect, useMemo, useState, useRef } from 'react';
import { X } from 'lucide-react';
import type { AgentRunView } from '../../shared/agent';
import type { MapStatus, SpatialAsset, SpatialPresentation } from '../../shared/maps';
import { api } from './api';
import { RichContent } from './RichContent';
import { MediaGallery } from './MediaGallery';
import type { MapItem } from './MapCanvas';
import { agentMapRefs, mapItemId } from './map-media';
import './maps.css';

const MapCanvas = lazy(() => import('./MapCanvas'));
const describe = (asset: SpatialAsset, ref: SpatialPresentation) => ref.stale ? '路径待更新，旧里程与时间已停用' : asset.kind === 'route' ? asset.route?.mode === 'schematic' ? '顺序示意 · 非道路路径 · 不估计真实耗时' : `${((asset.route?.distanceMeters || 0)/1000).toFixed(2)} 公里 · 移动约 ${Math.ceil((asset.route?.movingSeconds || 0)/60)} 分钟，不含停留` : asset.kind === 'area' ? ({ suggested: '建议探索范围', building: '建筑轮廓', boundary: '真实区域边界' })[asset.areaNature!] : asset.precision === 'street' ? '街道／广场代表位置' : asset.precision === 'place' ? '已匹配地点' : '城市／区域概览';

export function AgentMap({ run, tab, focus, onTab, onClose }: { run: AgentRunView; tab: string; focus?: { itemId: string; key: string }; onTab(tab: string): void; onClose(): void }) {
  const [assets, setAssets] = useState<SpatialAsset[]>([]), [status, setStatus] = useState<MapStatus | null>(null), [error, setError] = useState(''), [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false), root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.focus({preventScroll:true}); root.current?.scrollIntoView({block:'start',behavior:'smooth'}); }, [run.id]);
  const ids = JSON.stringify(run.spatial?.map(a => a.id) || []);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setAssets([]); setLoaded(false);
    const timer = setTimeout(() => { setError('读取地图内容超时，文字与图文仍可浏览。'); setLoaded(true); controller.abort(); }, 10000);
    Promise.all([api<{assets: SpatialAsset[]}>(`/api/agent/runs/${run.id}/spatial`, { signal: controller.signal }), api<MapStatus>('/api/maps/status', { signal: controller.signal })]).then(([data, state]) => { if (!controller.signal.aborted) { clearTimeout(timer); setAssets(data.assets); setStatus(state); setLoaded(true); } }).catch(e => { if (!controller.signal.aborted) { clearTimeout(timer); setError(e.message); setLoaded(true); } });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [run.id, ids]);
  useEffect(() => { setSelected(''); }, [tab]);
  useEffect(() => { if (focus) { setSelected(focus.itemId); root.current?.focus({preventScroll:true}); root.current?.scrollIntoView({block:'start',behavior:'smooth'}); } }, [focus?.key]);
  const answer = run.output?.spatial || [];
  const refs = agentMapRefs(run,tab);
  const byId = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets]);
  const items: MapItem[] = useMemo(() => refs.flatMap((ref, i) => { const a = byId.get(ref.assetId); return a ? [{ id: mapItemId(ref,i), title: ref.title || a.name, geometry: a.geometry, precision: a.precision, label: ref.label || String(i + 1), optional: ref.optional, stale: ref.stale, suggested: a.areaNature === 'suggested', schematic: a.route?.mode === 'schematic' }] : []; }), [JSON.stringify(refs), byId]);
  const extent = useMemo(() => assets.map(a => a.geometry), [assets]);
  const index = refs.findIndex((ref, i) => mapItemId(ref,i) === selected), active = refs[index], asset = active && byId.get(active.assetId);
  const candidate = run.output?.candidates.find(c => tab === `candidate:${c.id}`);
  return <section className="agent-map-view" aria-label="回答与候选地图" ref={root} tabIndex={-1}>
    <div className="map-detail-heading"><h3>{run.proposal && (tab === 'before' || tab === 'after') ? '地图变更预览' : '在地图上理解方案'}</h3><button className="icon-button" aria-label="关闭回答地图" onClick={onClose}><X size={18}/></button></div>
    <div className="agent-map-tabs" aria-label="切换地图内容">
      {(!run.output?.candidates.length || answer.some(r => !r.candidateId)) && <button aria-pressed={tab === 'answer'} onClick={() => onTab('answer')}>回答地图</button>}
      {run.output?.candidates.map(c => <button key={c.id} aria-pressed={tab === `candidate:${c.id}`} onClick={() => onTab(`candidate:${c.id}`)}>{c.title}</button>)}
      {!!run.proposal && <><button aria-pressed={tab === 'before'} onClick={() => onTab('before')}>修改前</button><button aria-pressed={tab === 'after'} onClick={() => onTab('after')}>采用后</button></>}
    </div>
    <p className="subtle">{candidate ? '候选内容 · 尚未采用。切换只改变地图展示，取景范围保持一致。' : tab === 'before' || tab === 'after' ? '此处展示保存的变更预览，采用前不会修改计划。' : '回答中的地点与范围；查看不会修改计划。'}</p>
    {items.length && status?.available ? <Suspense fallback={<p role="status">正在准备地图…</p>}><MapCanvas items={items} selectedId={selected} onSelect={setSelected} viewKey={`agent:${run.id}`} style={status.style} extent={extent}/></Suspense> : <p className="map-empty" role="status">{items.length ? status?.message || '正在读取地图状态，地点与图文仍可查看。' : refs.length ? error || (loaded ? '地图内容当前不可访问，仍可阅读文字与图文。' : '正在读取已保存位置…') : '这部分还没有已匹配的位置，可继续阅读文字内容。'}</p>}
    {error && <p className="alert warning" role="alert">{error}</p>}
    {candidate && <details className="agent-map-description" key={candidate.id}><summary>查看方案说明与取舍</summary><RichContent text={candidate.description}/><p>{candidate.tradeoffs}</p></details>}
    <div className="agent-map-places" aria-label="地图内容列表">{refs.map((ref, i) => { const a = byId.get(ref.assetId), id = mapItemId(ref,i); return <button key={id} aria-pressed={selected === id} onClick={() => setSelected(id)}><strong>{ref.label || i + 1}. {ref.title || a?.name || '位置待确认'}</strong><span>{a ? `${ref.optional ? '可选内容 · ' : ''}${describe(a, ref)}` : '地图内容当前不可访问，未自动替换'}</span></button>; })}</div>
    {asset && <article className="map-place-detail"><h4>{active.title || asset.name}</h4>{active.description && <RichContent text={active.description}/>}<p>{asset.address}</p><p>{describe(asset, active)}</p><a href={asset.source.url} target="_blank" rel="noreferrer">地图数据来源</a><p className="subtle">取得于 {new Date(asset.source.retrievedAt).toLocaleString()}</p><MediaGallery key={selected} images={run.media.filter(m => active.mediaIds.includes(m.id))} title="这处地点的相关配图"/>{active.mediaIds.length>0&&!run.media.some(m=>active.mediaIds.includes(m.id))&&<p className="subtle">关联配图当前不可访问，地点说明仍可查看。</p>}</article>}
  </section>;
}

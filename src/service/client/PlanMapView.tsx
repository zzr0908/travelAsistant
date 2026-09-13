import {z} from 'zod';
import {SessionMap} from './session-map';
import { notesForPlace } from '../../shared/notes';
import { noteExcerpt, noteReadingBody } from '../../shared/note-groups';
import { routeNearby, routeSearchCenters } from '../../shared/route-nearby';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MapPin, Search, ArrowLeft, ArrowUpRight, Route, Layers, List, Map as MapIcon, X } from 'lucide-react';
import { trail, type WorkspaceView, type PlanNode } from '../../shared/model';
import { walkingGroups } from '../../shared/walking';
import { itineraryNodes } from '../../shared/itinerary';
import { bindingStale, type MapQueryResult, type MapStatus, type SpatialAsset, type SpatialBinding } from '../../shared/maps';
import type { MapItem } from './MapCanvas';
import { api, uid } from './api';
import { PlaceAdoptionPreview } from './PlaceAdoptionPreview';
import { RichContent } from './RichContent';
import { WorkspaceMedia, PlaceMedia } from './MediaGallery';
import { workspaceMediaTargets } from './map-media';
import { restoreMapReading, type MapReadingPosition } from './map-reading';
import './maps.css';
const MapCanvas = lazy(() => import('./MapCanvas'));
const remembered = new SessionMap('map-selection-v1',z.string().max(200),100);
const nearbyPreferences=new SessionMap('map-preferences-v1',z.object({category:z.enum(['museum','park','cafe']),expanded:z.boolean()}));
const alongResults = new SessionMap('map-candidates-v1',z.object({kind:z.literal('nearby').optional(),at:z.number().finite(),completed:z.array(z.string().max(200)).max(2000),assetIds:z.array(z.string().uuid()).max(10000),coverage:z.string().max(1000)}));
const describeAsset = (asset: SpatialAsset, stale = false) => asset.kind === 'place' ? asset.precision === 'street' ? '街道／广场代表位置' : asset.precision === 'place' ? '已匹配地点' : '城市／区域概览' : asset.kind === 'area' ? asset.areaNature === 'suggested' ? '建议探索范围' : asset.areaNature === 'building' ? '建筑轮廓' : '真实区域边界' : stale ? '路径待更新 · 旧估计已停用' : asset.route?.mode === 'schematic' ? '顺序示意 · 非道路路径' : `${((asset.route?.distanceMeters || 0) / 1000).toFixed(2)} 公里 · 移动约 ${Math.ceil((asset.route?.movingSeconds || 0) / 60)} 分钟，不含停留`;
const assetText = (asset: SpatialAsset, stale = false, optional = false) => `${optional ? '可选内容 · ' : ''}${describeAsset(asset, stale)}`;
interface Props { workspace: WorkspaceView; nodeId: string; userId: string; focus?: {itemId:string;key:string}; onFocusDone?(): void; onBackToMedia?(): void; restore?: MapReadingPosition & {key:string}; onRestored?(): void; onOpen(id: string, position: MapReadingPosition): void; onOpenNote(id:string,position:MapReadingPosition):void; onResearchPlace(asset:SpatialAsset):void; onSavePlace(assetId:string,version:number):Promise<unknown>; onAdopt(assetId: string, version: number, beforeNodeId?: string): Promise<unknown>; onBind(nodeId: string, bindings: SpatialBinding[], version: number): Promise<unknown>; }
interface Draft { asset: SpatialAsset; nodeId: string; nodeIds: string[]; version: number }
export function PlanMapView({ workspace: w, nodeId, userId, focus, onFocusDone, onBackToMedia, restore, onRestored, onOpen, onOpenNote, onResearchPlace, onBind, onAdopt, onSavePlace }: Props) {
  const viewKey = `${userId}:${w.id}:${nodeId}`, nodes = useMemo(() => itineraryNodes(w.data, nodeId), [w.data, nodeId]);
  const [showAllNearby,setShowAllNearby]=useState(()=>nearbyPreferences.get(viewKey)?.expanded || false);
  const [nearbyCoverage,setNearbyCoverage]=useState('');
  const [savedMessage,setSavedMessage] = useState('');
  const [adopting,setAdopting] = useState<SpatialAsset>();
  const [nearby, setNearby] = useState<SpatialAsset[]>([]), [nearbyVersion,setNearbyVersion] = useState(w.version), [nearbyCategory,setNearbyCategory] = useState(()=>nearbyPreferences.get(viewKey)?.category || 'museum');
  const [selected, setSelected] = useState(() => remembered.get(viewKey) || ''), [assets, setAssets] = useState<SpatialAsset[]>([]), [status, setStatus] = useState<MapStatus | null>(null), [assetsLoaded, setAssetsLoaded] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [mobileTab, setMobileTab] = useState<'map'|'list'>('map'), [searching, setSearching] = useState(false), [text, setText] = useState(''), [context, setContext] = useState('');
  const [results, setResults] = useState<MapQueryResult | null>(null), [resultVersion, setResultVersion] = useState(w.version), [draft, setDraft] = useState<Draft | null>(null), [confirm, setConfirm] = useState(false);
  const [searchType, setSearchType] = useState<'place'|'street'|'city'>('place'), [searchTargetId, setSearchTargetId] = useState('');
  const searchInput = useRef<HTMLInputElement>(null), preview = useRef<HTMLDivElement>(null), layout = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  const openButton = useRef<HTMLButtonElement>(null), restoreCleanup = useRef<(() => void) | undefined>(undefined), restoredKey = useRef('');
  useEffect(() => () => restoreCleanup.current?.(), []);
  const controller = useRef<AbortController | null>(null), list = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const bindingsKey = JSON.stringify(nodes.flatMap(n => w.data.spatial?.[n.id] || []));
  useEffect(() => { setNearby([]); setSelected(remembered.get(viewKey) || ''); setDraft(null); setResults(null); setSearching(false); setBusy(false); setError(''); return () => controller.current?.abort(); }, [viewKey]);
  useEffect(() => {
    const request=new AbortController();
    const timer=setTimeout(()=>{setError('读取地图状态超时，地点和图文仍可浏览。');request.abort();},10000);
    api<MapStatus>('/api/maps/status',{signal:request.signal}).then(v=>{if(!request.signal.aborted)setStatus(v);}).catch(e=>{if(!request.signal.aborted)setError(e.message);}).finally(()=>clearTimeout(timer));
    return()=>{clearTimeout(timer);request.abort();};
  }, []);
  useEffect(() => {
    const request = new AbortController();
    const ids = [...new Set(nodes.flatMap(n => (w.data.spatial?.[n.id] || []).map(b => b.assetId)))];
    setAssets([]);setAssetsLoaded(false);
    if (!ids.length) {setAssetsLoaded(true);return;}
    const timer=setTimeout(()=>{setError('读取地图内容超时，安排文字和图文仍可浏览。');setAssetsLoaded(true);request.abort();},10000);
    api<{ assets: SpatialAsset[] }>('/api/maps/asset-set', { method: 'POST', body: JSON.stringify({ ids, workspaceId: w.id }), signal: request.signal }).then(r => {if(!request.signal.aborted){setAssets(r.assets);setAssetsLoaded(true);}}).catch(e => { if (!request.signal.aborted) {setError(e.message);setAssetsLoaded(true);} }).finally(()=>clearTimeout(timer));
    return () => {clearTimeout(timer);request.abort();};
  }, [w.id, bindingsKey]);
  const [computedRoutes, setComputedRoutes] = useState<SpatialAsset[]>([]), [routeError, setRouteError] = useState(''), [routing, setRouting] = useState(false), [routeAttempt,setRouteAttempt] = useState(0);
  const byId = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets]);
  const listedNodes = useMemo(() => nodes.filter(n => !nodes.some(child => child.parentId === n.id) || n.location.lat !== null || (w.data.spatial?.[n.id] || []).some(binding => byId.get(binding.assetId)?.geometry.type === 'Point')), [nodes,w.data,byId]);
  const entries = useMemo(() => nodes.flatMap(n => {
    const index = listedNodes.findIndex(item => item.id === n.id);
    const refs = w.data.spatial?.[n.id] || [];
    const mapped = refs.flatMap(b => { const a = byId.get(b.assetId); return a ? [{ id: `${n.id}:${a.id}`, node: n, asset: a, binding: b, title: a.name, geometry: a.geometry, precision: a.precision, label: index >= 0 ? String(index + 1) : '', optional: b.optional, stale: bindingStale(w.data, b), schematic: a.route?.mode === 'schematic', suggested: a.areaNature === 'suggested' }] : []; });
    if (!refs.some(b => b.primary) && n.location.lat !== null && n.location.lng !== null) mapped.unshift({ id: n.id, node: n, asset: undefined as unknown as SpatialAsset, binding: undefined as unknown as SpatialBinding, title: n.location.name || n.title, geometry: { type: 'Point', coordinates: [n.location.lng, n.location.lat] }, precision: 'manual', label: index >= 0 ? String(index + 1) : '', optional: false, stale: false, schematic: false, suggested: false });
    return mapped;
  }), [nodes, listedNodes, byId, w.data]);
  const activeEntry = entries.find(e => e.id === selected), activeNode = activeEntry?.node || nodes.find(n => n.id === selected);
  const activeAddress = activeEntry?.asset ? activeEntry.asset.address : activeNode?.location.address;
  const activeEntries = entries.filter(e => e.node.id === activeNode?.id);
  const items = useMemo(() => {
    const next: MapItem[] = [...entries, ...computedRoutes.filter(a => !entries.some(e => e.asset?.id===a.id)).map(a => ({id:`computed:${a.id}`,title:a.name,geometry:a.geometry,precision:a.precision,label:'',optional:false})), ...nearby.filter(a => !entries.some(e => e.asset?.entityId === a.entityId)).map(a => ({id:`nearby:${a.id}`,title:a.name,geometry:a.geometry,precision:a.precision,label:'+',optional:true}))];
    if (draft) {
      if (draft.asset.kind === 'place') for (let i = next.length - 1; i >= 0; i--) if (entries[i]?.node.id === draft.nodeId && next[i].geometry.type === 'Point') next.splice(i, 1);
      next.push({ id: 'preview', title: draft.asset.name, geometry: draft.asset.geometry, precision: draft.asset.precision, label: '新', schematic: draft.asset.route?.mode === 'schematic', suggested: draft.asset.areaNature === 'suggested' });
    }
    return next;
  }, [entries, draft, nearby, computedRoutes]);
  const showPreview = () => { preview.current?.focus({ preventScroll: true }); layout.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  const clearQuery = () => { controller.current?.abort(); controller.current = null; setBusy(false); setResults(null); setDraft(null); setConfirm(false); };
  const select = (id: string, fromMap = false) => {
    if (id === 'preview') return;
    const targetId = entries.find(e => e.id === id)?.node.id || id;
    if (searching && targetId !== searchTargetId) { clearQuery(); setSearching(false); }
    setSelected(id); remembered.set(viewKey, id);
    if (remembered.size > 100) remembered.delete(remembered.keys().next().value!);
    if (fromMap) requestAnimationFrame(() => buttons.current.get(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const chooseNode = (n: PlanNode) => select(entries.find(e => e.node.id === n.id)?.id || n.id);
  const focused = useRef('');
  useEffect(()=>{
    if(focus && focused.current!==focus.key && entries.some(e=>e.id===focus.itemId)) {
      focused.current=focus.key;select(focus.itemId);setMobileTab('map');
      requestAnimationFrame(()=>{root.current?.focus({preventScroll:true});root.current?.scrollIntoView({block:'start',behavior:'smooth'});});onFocusDone?.();
    }
  },[focus?.key,entries]);
  const search = (n: PlanNode) => {
    clearQuery(); chooseNode(n); setSearchTargetId(n.id); setSearchType('place'); setText(n.location.name || n.title); setContext(trail(w.data, n.id).slice(0, -1).reverse().find(p => p.location.name)?.location.name || ''); setSearching(true); setError('');
    requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  };
  const query = async (input: Record<string, unknown>, target: PlanNode, nodeIds: string[] = []) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setBusy(true); setError(''); setConfirm(false);
    const version = w.version;
    const timer = setTimeout(() => {
      if (controller.current !== request || request.signal.aborted) return;
      setError('地图查询超时，请稍后重试；计划未修改。'); setBusy(false); request.abort();
    }, 10000);
    try {
      const result = await api<MapQueryResult>('/api/maps/queries', { method: 'POST', body: JSON.stringify({ ...input, workspaceId: w.id, requestId: uid() }), signal: request.signal });
      if (request.signal.aborted) return;
      if (input.action === 'nearby') {
        if(result.status==='ok'||result.status==='no_match'){
          alongResults.set(alongKey,{kind:'nearby',at:Date.now(),completed:[],assetIds:result.assets.map(a=>a.id),coverage:'地点附近的查询结果，尚未加入行程。'});
          if(alongResults.size>50)alongResults.delete(alongResults.keys().next().value!);
        }
        setNearbyCoverage('地点附近的查询结果，尚未加入行程。');setQueriedCenters([]);setRouteCandidates([]); setNearby(result.assets); setNearbyVersion(version); if (!result.assets.length) setError(result.message); }
      else if (input.action === 'search') { setResults(result); setResultVersion(version); }
      else if (result.assets.length === 1) { setDraft({ asset: result.assets[0], nodeId: target.id, nodeIds, version }); setMobileTab('map'); requestAnimationFrame(() => showPreview()); }
      else setError(result.message);
      if (result.status === 'failed') setError(result.message);
    } catch (e) { if (!request.signal.aborted) setError((e as Error).message); }
    finally { clearTimeout(timer); if (controller.current === request) setBusy(false); }
  };
  const searchTarget = w.data.nodes[searchTargetId];
  const submit = (e: FormEvent) => { e.preventDefault(); if (searchTarget) void query({ action: 'search', searchType, text, ...(context.trim() ? { context } : {}) }, searchTarget); };
  const stops = entries.filter(e => e.binding?.primary && e.asset && ['place','street'].includes(e.asset.precision));
  const groups = walkingGroups(w.data, stops.filter(e => e.asset.geometry.type==='Point').map(e => ({nodeId:e.node.id,assetId:e.asset.id,coordinates:e.asset.geometry.type==='Point' ? e.asset.geometry.coordinates : [0,0]})));
  const routeGroups = groups.filter(group => group.stops.length >= 2 && group.stops.length <= 12);
  const routeKey = JSON.stringify(routeGroups.map(group => ({key:group.key,stops:group.stops})));
  const [queriedCenters,setQueriedCenters]=useState<string[]>([]),[routeCandidates,setRouteCandidates]=useState<SpatialAsset[]>([]);
  const realRoutes=[...computedRoutes,...entries.filter(entry=>!entry.stale&&entry.asset?.route?.mode==='walk').map(entry=>entry.asset)];
  const centerResult=useMemo(()=>{
    try{return {centers:[...new Map(realRoutes.map(route=>[route.id,route])).values()].flatMap(route=>routeSearchCenters(route).map((_,index)=>({id:`${route.id}:${index}`,routeId:route.id,index,name:`${route.name} · 第 ${index+1} 段`}))),error:''};}
    catch(e){return {centers:[],error:(e as Error).message};}
  },[JSON.stringify(realRoutes)]);
  const centers=centerResult.centers;
  const centersKey=centers.map(center=>center.id).join(',');
  const [hydratedKey,setHydratedKey]=useState('');
  const alongKey=JSON.stringify([viewKey,w.version,routeKey,centersKey,nearbyCategory]);
  useEffect(()=>{
    controller.current?.abort();setBusy(false);setNearby([]);setQueriedCenters([]);setRouteCandidates([]);setNearbyCoverage('');setShowAllNearby(nearbyPreferences.get(viewKey)?.expanded || false);
    const cached=alongResults.get(alongKey);
    if(!cached||Date.now()-cached.at>15*60*1000){if(cached){alongResults.delete(alongKey);setNearbyCoverage('上次查询已过期，请重新查找附近或沿途地点。');}setHydratedKey(alongKey);return;}
    const request=new AbortController();controller.current=request;
    const timer=setTimeout(()=>{request.abort();alongResults.delete(alongKey);setHydratedKey(alongKey);setNearbyCoverage('读取上次查询超时，请重新查找附近或沿途地点。');},10000);
    // Recheck current access before displaying cached private or shared assets.
    const read=(async()=>{
      const ids=[...new Set(cached.assetIds)],assets:SpatialAsset[]=[];
      for(let offset=0;offset<ids.length;offset+=600){
        const result=await api<{assets:SpatialAsset[]}>('/api/maps/asset-set',{method:'POST',body:JSON.stringify({ids:ids.slice(offset,offset+600),workspaceId:w.id}),signal:request.signal});
        assets.push(...result.assets);
      }
      return {assets};
    })();
    void read.then(result=>{
      if(request.signal.aborted)return;
      setRouteCandidates(result.assets);setQueriedCenters(cached.completed);setNearby(cached.kind==='nearby'?result.assets:routeNearby(result.assets,realRoutes,stops.map(stop=>stop.asset)));setNearbyVersion(w.version);setNearbyCoverage(cached.coverage);
    }).catch(()=>{if(!request.signal.aborted){alongResults.delete(alongKey);setNearbyCoverage('无法恢复上次查询，可能是网络或访问权限发生变化。请重新查找附近或沿途地点。');}}).finally(()=>{clearTimeout(timer);if(!request.signal.aborted)setHydratedKey(alongKey);});
    return()=>{clearTimeout(timer);request.abort();};
  },[alongKey]);
  useEffect(() => {
    if (!restore || !assetsLoaded || restoredKey.current === restore.key) return;
    if(restore.itemId.startsWith('nearby:') && (hydratedKey!==alongKey || routing))return;
    restoredKey.current = restore.key;
    restoreCleanup.current?.();
    const originalNodeId = restore.itemId.split(':')[0];
    const id = items.some(e => e.id === restore.itemId) ? restore.itemId : nodes.some(n => n.id === originalNodeId) ? originalNodeId : '';
    select(id);setMobileTab(restore.mobileTab);
    if (id !== restore.itemId) setError('原地图对象已变更，已返回原范围；请从列表核对当前内容。');
    const frame = requestAnimationFrame(() => {
      if (root.current) restoreCleanup.current = restoreMapReading(root.current, restore, () => restore.itemId.startsWith('nearby:') ? buttons.current.get(restore.itemId)||null : openButton.current, list.current);
      onRestored?.();
    });
    restoreCleanup.current = () => cancelAnimationFrame(frame);
  }, [restore?.key, assetsLoaded, entries, items, hydratedKey, alongKey, routing]);
  const queryAlongRoute=async()=>{
    controller.current?.abort();const request=new AbortController();controller.current=request;setBusy(true);setError('');
    const previous=queriedCenters.length===centers.length?[]:queriedCenters;
    const batch=centers.filter(center=>!previous.includes(center.id)).slice(0,4),completed=[...previous],found=previous.length?[...routeCandidates]:[],failures:string[]=[];
    const version=w.version;
    try {
      for(const center of batch) {
        if(request.signal.aborted)return;
        try {
          const result=await api<MapQueryResult>('/api/maps/queries',{method:'POST',body:JSON.stringify({action:'nearby',nearRouteId:center.routeId,routeCenterIndex:center.index,category:nearbyCategory,radiusMeters:1000,workspaceId:w.id,requestId:uid()}),signal:request.signal});
          if(request.signal.aborted)return;
          if(result.status!=='ok' && result.status!=='no_match')throw new Error(result.message);
          found.push(...result.assets);completed.push(center.id);
        }catch(e){if(request.signal.aborted)return;failures.push(`${center.name}：${e instanceof Error ? e.message : '暂时无法查询'}`);}
        setRouteCandidates([...found]);setQueriedCenters([...completed]);setNearby(routeNearby(found,realRoutes,stops.map(stop=>stop.asset)));setNearbyVersion(version);
        const coverage=`已查询 ${completed.length}/${centers.length} 个沿路位置；每次最多查询 4 处。结果距已计算步行路径约 300 米内，仅显示服务返回的候选。`;
        setNearbyCoverage(coverage);
        alongResults.set(alongKey,{at:Date.now(),completed:[...completed],assetIds:[...new Set(found.map(a=>a.id))],coverage});
        if(alongResults.size>50)alongResults.delete(alongResults.keys().next().value!);
      }
      if(failures.length)setError(`未完成查询：${failures.join('；')}`);
    }finally{if(controller.current===request)setBusy(false);}
  };

  useEffect(() => {
    if (!assetsLoaded || !status?.available) return;
    const controller = new AbortController();
    setComputedRoutes([]); setRouteError('');
    if (!routeGroups.length) {setRouting(false);return;}
    setRouting(true);
    const timer = setTimeout(() => {setRouteError('路线更新超时，地点仍可查看。');setRouting(false);controller.abort();},30000);
    const run = async () => {
      const routes:SpatialAsset[]=[];
      try {
        for (const group of routeGroups.slice(0,6)) {
          if (controller.signal.aborted) return;
          const ids = group.stops.map(stop => stop.assetId);
          const existing = entries.find(e => !e.stale && e.asset?.route?.mode==='walk' && JSON.stringify(e.asset.route.placeIds)===JSON.stringify(ids));
          if (existing) continue;
          const result=await api<MapQueryResult>('/api/maps/queries',{method:'POST',body:JSON.stringify({action:'route',placeIds:ids,name:`${group.label} · 步行路线`,workspaceId:w.id,requestId:uid()}),signal:controller.signal});
          if (controller.signal.aborted) return;
          if (result.status!=='ok' || !result.assets[0]?.route) throw new Error(result.message);
          routes.push(result.assets[0]);setComputedRoutes([...routes]);
        }
        if (routeGroups.length>6) setRouteError('已更新前6个步行片段；进入子计划查看其余路线。');
      } catch (e) {if (!controller.signal.aborted) setRouteError((e as Error).message);}
      finally {clearTimeout(timer);if (!controller.signal.aborted) setRouting(false);}
    };
    void run();
    return () => {clearTimeout(timer);controller.abort();};
  },[w.id,nodeId,routeKey,assetsLoaded,status?.available,routeAttempt]);
  const node = w.data.nodes[nodeId], editable = w.role !== 'reader';
  const missing = listedNodes.filter(n => !entries.some(e => e.node.id === n.id));
  const previewTarget = draft && w.data.nodes[draft.nodeId];
  const movedFar = draft?.asset.kind === 'place' && previewTarget?.location.lat != null && draft.asset.geometry.type === 'Point' && Math.abs(draft.asset.geometry.coordinates[1] - previewTarget.location.lat) + Math.abs(draft.asset.geometry.coordinates[0] - (previewTarget.location.lng || 0)) > 1;
  const candidateNotes=useMemo(()=>new Map(nearby.map(asset=>[asset.id,notesForPlace(w.data,[asset.id]).find(note=>note.body.trim())])),[nearby,w.data]);
  const candidateSummary=(assetId:string)=>{
    const note=candidateNotes.get(assetId);
    return note ? <span className="candidate-note-preview"><span>笔记 · {note.title}</span><span>{noteExcerpt(noteReadingBody(note.title,note.body))}</span></span> : null;
  };
  const relatedNotes=(assetIds:string[],nodeIds:string[]=[])=>{
    const notes=notesForPlace(w.data,assetIds,nodeIds);
    return notes.length>0 && <div className="map-related-notes" aria-label="相关笔记"><h4>相关笔记</h4>{notes.map(note=><button key={note.id} onClick={e=>onOpenNote(note.id,{itemId:selected,mobileTab,openerTop:e.currentTarget.getBoundingClientRect().top,listScrollTop:list.current?.scrollTop||0})}><strong>{note.title}</strong>{note.body && <span>{noteExcerpt(noteReadingBody(note.title,note.body))}</span>}</button>)}</div>;
  };
  return <section className="plan-map-view" aria-label="计划地点与地图" ref={root} tabIndex={-1}>
    {adopting && <PlaceAdoptionPreview workspace={w} parentId={nodeId} asset={adopting} stops={stops.filter(e=>e.asset.geometry.type==='Point').map(e=>({nodeId:e.node.id,assetId:e.asset.id,coordinates:e.asset.geometry.type==='Point'?e.asset.geometry.coordinates:[0,0]}))} onClose={()=>setAdopting(undefined)} onConfirm={async (version,beforeNodeId)=>{await onAdopt(adopting.id,version,beforeNodeId);setNearby(list=>list.filter(item=>item.id!==adopting.id));setSelected('');}}/>}
    {onBackToMedia && <button className="text-button map-back-media" onClick={onBackToMedia}><ArrowLeft size={16}/>返回配图</button>}
    <div className={`map-intro ${missing.length ? 'has-missing' : ''}`}><div>{missing.length > 0 && <p className="subtle">{missing.length} 项待定位</p>}</div><div className="map-tabs"><button aria-pressed={mobileTab === 'map'} onClick={() => setMobileTab('map')}><MapIcon size={16}/>地图</button><button aria-pressed={mobileTab === 'list'} onClick={() => setMobileTab('list')}><List size={16}/>列表</button></div></div>
    <div className={`plan-map-layout mobile-${mobileTab}`} ref={layout}>
      <div className="plan-map-stage">
        {items.length && status?.available ? <Suspense fallback={<div className="map-empty" role="status">正在准备地图…</div>}><MapCanvas items={items} selectedId={draft ? 'preview' : selected} onSelect={id => select(id, true)} viewKey={viewKey} style={status.style}/></Suspense> : <div className="map-empty"><MapPin size={30}/><h3>{items.length ? '地图暂时不可用' : '先为安排找到位置'}</h3><p>{items.length ? status?.message || '正在读取地图状态，仍可浏览下面的地点。' : '选择一项安排搜索地点，或在编辑中保留手动位置。待定位的内容都在列表中。'}</p></div>}
        <p className="map-legend"><span>● 已安排</span><span>＋ 可选停留</span></p>
        <div className="map-route-actions">
          {routing && <p role="status">正在更新沿街步行路线…</p>}
          {computedRoutes.map(route => <p key={route.id}>{route.name} · {describeAsset(route)}</p>)}
          {routeError && <p role="alert">{routeError}</p>}
          {routeGroups.length>0 && <button disabled={routing || !status?.available} onClick={() => setRouteAttempt(n=>n+1)}>更新步行路线</button>}
          {groups.some(group=>group.stops.length<2) && <p className="subtle">单点、跨日或较远地点分别呈现，交通方式待确认。</p>}
        </div>

      </div>
      <div className="plan-map-content" ref={list}>
        {draft && previewTarget && <div className="map-change-preview" ref={preview} tabIndex={-1} aria-label="地图变更预览"><span className="overline">保存前预览 · 尚未修改计划</span><h3>{draft.asset.name}</h3><p>{assetText(draft.asset)}</p><p>{draft.asset.kind === 'place' ? `${previewTarget.location.name || '原地点待补充'} → ${draft.asset.name}` : `关联到「${previewTarget.title}」`}</p>{draft.nodeIds.length > 0 && <p className="subtle">{draft.nodeIds.map(id => w.data.nodes[id]?.title).join(' → ')}</p>}<p className="subtle">{draft.asset.address}</p><a href={draft.asset.source.url} target="_blank" rel="noreferrer">查看数据来源</a>{movedFar && <label className="check-line"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/>新地点离原位置较远，我已核对城市和地点</label>}{draft.version !== w.version && <p className="alert warning">计划已更新，请取消此预览后重新选择，避免覆盖新修改。</p>}<div className="button-row"><button className="primary" disabled={!editable || busy || draft.version !== w.version || !!movedFar && !confirm} onClick={async () => { setBusy(true); setError(''); try { const old = w.data.spatial?.[draft.nodeId] || []; const refs = [...old.filter(b => b.assetId !== draft.asset.id && !(draft.asset.kind === 'place' && b.primary)), { assetId: draft.asset.id, primary: draft.asset.kind === 'place', optional: false, nodeIds: draft.nodeIds, mediaIds: [] }]; await onBind(draft.nodeId, refs, draft.version); select(`${draft.nodeId}:${draft.asset.id}`); setDraft(null); setSearching(false); setResults(null); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>保存地图变更</button><button disabled={busy} onClick={() => { setDraft(null); if (searching) searchInput.current?.focus(); else buttons.current.get(draft.nodeId)?.focus(); }}>取消预览</button></div>{!editable && <p className="subtle">你可以查看与研究；共同计划的修改需由编辑者采用。</p>}</div>}
        <div className="map-place-list" aria-label="当前范围的地点">{listedNodes.map((n, index) => { const entry = entries.find(e => e.node.id === n.id), id = entry?.id || n.id; return <div key={n.id} className={`map-place-row ${activeNode?.id === n.id ? 'selected' : ''}`}><button ref={el => { if (el) buttons.current.set(n.id, el); else buttons.current.delete(n.id); }} onClick={() => chooseNode(n)} aria-pressed={activeNode?.id === n.id}><span className="map-number">{index + 1}</span><span><strong>{n.location.name || n.title}</strong><small>{n.location.name && n.location.name!==n.title ? n.title + ' · ' : ''}{entry?.asset ? assetText(entry.asset, entry.stale, entry.optional) : entry ? '手动位置' : '待定位'}</small></span></button>{!entry && <button className="text-button" onClick={() => search(n)} aria-label={`查找地点：${n.title}`}><Search size={15}/></button>}</div>; })}</div>
        {activeNode && <article className="map-place-detail"><div className="map-detail-heading"><h3>{activeNode.title}</h3><button className="icon-button" aria-label="关闭地点详情" onClick={() => { clearQuery(); setSearching(false); setSelected(''); remembered.delete(viewKey); buttons.current.get(activeNode.id)?.focus(); }}><X size={18}/></button></div>{activeAddress && <p className="subtle">{activeAddress}</p>}<RichContent text={activeNode.description}/>{relatedNotes(activeEntries.flatMap(entry=>entry.asset?[entry.asset.id]:[]),[activeNode.id])}{activeEntries.length > 1 && <div className="map-detail-assets" aria-label="这项安排的地图内容">{activeEntries.map(e => <button key={e.id} aria-pressed={selected === e.id} onClick={() => select(e.id)}><strong>{e.asset?.name || e.title}</strong><span>{e.asset ? assetText(e.asset, e.stale, e.optional) : '手动位置'}</span></button>)}</div>}{activeEntry?.asset && <p><a href={activeEntry.asset.source.url} target="_blank" rel="noreferrer">地图数据来源</a> · {assetText(activeEntry.asset, activeEntry.stale, activeEntry.optional)}<span className="map-source-time">取得于 {new Date(activeEntry.asset.source.retrievedAt).toLocaleString()}</span></p>}<div className="map-detail-actions"><button ref={openButton} onClick={e => onOpen(activeNode.id, {itemId:selected,mobileTab,openerTop:e.currentTarget.getBoundingClientRect().top,listScrollTop:list.current?.scrollTop || 0})}><ArrowUpRight size={16}/>打开安排</button><button onClick={() => search(activeNode)}><Search size={16}/>{activeEntry ? '核对／更换地点' : '搜索地点'}</button>{activeEntry?.binding?.primary && <button disabled={busy} onClick={() => void query({ action: 'area', placeId: activeEntry.asset.id }, activeNode)}><Layers size={16}/>查看场所轮廓</button>}</div>{activeEntry?.binding ? <PlaceMedia key={activeEntry.id} workspaceId={w.id} nodeId={activeNode.id} version={w.version} label={activeEntry.asset.name} mediaIds={activeEntry.binding.mediaIds} mapTargets={workspaceMediaTargets(w.data,activeNode.id).map(target=>({...target,label:entries.find(e=>e.id===target.itemId)?.title || target.label}))} onLocate={target=>{select(target.itemId);setMobileTab('map');layout.current?.scrollIntoView({block:'start',behavior:'smooth'});}} onSave={editable ? async (ids,version)=>onBind(activeNode.id,(w.data.spatial?.[activeNode.id] || []).map(b=>b.assetId===activeEntry.asset.id?{...b,mediaIds:ids}:b),version) : undefined}/> : <WorkspaceMedia workspaceId={w.id} nodeId={activeNode.id} version={w.version} editable={false} onSave={async () => {}}/>}</article>}
    {stops.length > 0 && <section className="nearby-places" aria-label="附近地点"><h3>附近与沿途</h3>
      <div className="section-line"><label>附近类别<select value={nearbyCategory} onChange={e => {clearQuery();setNearbyCategory(e.target.value as "museum"|"park"|"cafe");setNearby([]);nearbyPreferences.set(viewKey,{category:e.target.value as "museum"|"park"|"cafe",expanded:false});if(nearbyPreferences.size>50)nearbyPreferences.delete(nearbyPreferences.keys().next().value!);}}><option value="museum">博物馆</option><option value="park">公园</option><option value="cafe">咖啡馆</option></select></label><button disabled={busy || !status?.available} onClick={() => void query({action:'nearby',nearPlaceId:(activeEntry?.asset?.kind==='place' ? activeEntry.asset.id : stops[0].asset.id),category:nearbyCategory,radiusMeters:1000},node)}>查找附近地点</button>{realRoutes.length>0 && <button disabled={busy||routing||!status?.available||!centers.length} onClick={()=>void queryAlongRoute()}>{queriedCenters.length===centers.length?'重新查询沿途地点':queriedCenters.length?'继续查询沿途地点':'查找沿途地点'}</button>}</div>
      {centerResult.error && <p role="status">{centerResult.error}</p>}
      {hydratedKey!==alongKey && <p className="subtle" role="status">正在恢复上次查询…</p>}
      {nearbyCoverage && <p className="subtle" role="status">{nearbyCoverage}</p>}
      {nearby.filter(a => !entries.some(e => e.asset?.entityId === a.entityId)).filter((a,index)=>showAllNearby||index<3||selected===`nearby:${a.id}`).map(a => <div className="nearby-place" key={a.id}><button ref={el=>{if(el)buttons.current.set(`nearby:${a.id}`,el);else buttons.current.delete(`nearby:${a.id}`);}} aria-pressed={selected===`nearby:${a.id}`} onClick={() => select(`nearby:${a.id}`)}><span>＋ {a.name}</span>{candidateSummary(a.id)}</button>{selected===`nearby:${a.id}` && <div><p>{a.address}</p><p className="subtle">{candidateNotes.has(a.id) && candidateNotes.get(a.id) ? '附近地点 · 尚未加入安排；可阅读下方笔记，开放条件请核对来源。' : '附近地点 · 尚未加入安排；看点与开放条件待查阅资料。'}</p><a href={a.source.url} target="_blank" rel="noreferrer">地点来源</a>{relatedNotes([a.id])}<button onClick={()=>onResearchPlace(a)}>研究看点与指引</button>{editable && <button disabled={busy || Object.values(w.data.notebook || {}).some(note=>note.spatialIds?.includes(a.id))} onClick={async()=>{setBusy(true);setError('');try{await onSavePlace(a.id,w.version);setSavedMessage('已保存到旅行笔记，尚未加入行程。');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存地点资料到笔记</button>}{editable && <button disabled={busy || nearbyVersion!==w.version} onClick={() => setAdopting(a)}>预览加入安排</button>}{nearbyVersion!==w.version && <p>安排已更新，请重新查询后再加入。</p>}</div>}</div>)}
      {nearby.length>3 && <button className="text-button" onClick={()=>setShowAllNearby(value=>{nearbyPreferences.set(viewKey,{category:nearbyCategory,expanded:!value});return !value;})}>{showAllNearby?'收起更多地点':`查看全部 ${nearby.length} 个地点`}</button>}
      {queriedCenters.length>0 && !nearby.length && !busy && <p className="subtle">已查询范围内暂无符合条件的沿途地点。</p>}
    </section>}
        {searching && searchTarget && <form className="map-search" onSubmit={submit}><div className="map-detail-heading"><h3>为「{searchTarget.title}」查找地点</h3><button type="button" className="icon-button" aria-label="关闭地点搜索" onClick={() => { clearQuery(); setSearching(false); buttons.current.get(searchTargetId)?.focus(); }}><X size={18}/></button></div><label>查找类型<select value={searchType} onChange={e => { clearQuery(); setSearchType(e.target.value as 'place'|'street'|'city'); }}><option value="place">具体地点：景点、餐馆、店铺</option><option value="street">街道／广场代表位置</option><option value="city">城市概览</option></select></label><label>{searchType === 'city' ? '城市名称' : '地点名称'}<input ref={searchInput} value={text} onChange={e => { clearQuery(); setText(e.target.value); }} maxLength={250} required/></label><label>{searchType === 'city' ? '所在国家或地区（可选）' : '所在城市或地区'}<input value={context} onChange={e => { clearQuery(); setContext(e.target.value); }} placeholder="例如 Florence, Italy" maxLength={200}/></label><button className="primary" disabled={busy || !status?.available} type="submit">{busy ? '正在查找…' : '搜索地点'}</button>{results && <div className="map-search-results"><p className="subtle">{results.message}</p>{results.assets.map(a => <button key={a.id} type="button" onClick={() => { setDraft({ asset: a, nodeId: searchTarget.id, nodeIds: [], version: resultVersion }); setConfirm(false); setMobileTab('map'); requestAnimationFrame(() => showPreview()); }}><strong>{a.name}</strong><span>{assetText(a)} · {a.category} · {a.match?.city}</span><small>{a.address}</small><span className="map-result-link">在地图上预览</span></button>)}</div>}</form>}
      </div>
    </div>
    {savedMessage && <p role="status">{savedMessage}</p>}
    {busy && !searching && <p role="status">正在取得地图内容…</p>}{error && <p className="alert warning" role="alert">{error}</p>}
  </section>;
}

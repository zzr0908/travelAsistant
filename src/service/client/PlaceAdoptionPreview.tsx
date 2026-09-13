import {useEffect, useMemo, useState} from 'react';
import {Dialog, ErrorNotice} from './Forms';
import {api, uid} from './api';
import {positionPlace} from '../../shared/place-insertion';
import {itineraryGroups,itineraryNodes} from '../../shared/itinerary';
import {nodeFields, type WorkspaceView} from '../../shared/model';
import {walkingGroups, type WalkingStop} from '../../shared/walking';
import type {MapQueryResult, SpatialAsset} from '../../shared/maps';

interface Props {
  workspace: WorkspaceView; parentId: string; asset: SpatialAsset; stops: WalkingStop[];
  onClose(): void; onConfirm(version: number, beforeNodeId?:string): Promise<unknown>;
}
export function PlaceAdoptionPreview({workspace:w,parentId,asset,stops,onClose,onConfirm}:Props) {
  const [baseVersion] = useState(w.version), [busy,setBusy] = useState(false), [loading,setLoading] = useState(true), [error,setError] = useState(''), [attempt,setAttempt] = useState(0);
  const [beforeNodeId,setBeforeNodeId] = useState('');
  const positions = itineraryGroups(w.data,parentId).flatMap(group=>group.nodes).filter(node=>node.dates.mode!=='fixed');
  const [routes,setRoutes] = useState<{before?:SpatialAsset;after?:SpatialAsset}>({});
  const group = useMemo(() => {
    if (asset.geometry.type !== 'Point' || w.version!==baseVersion) return;
    const id = '__preview_place__';
    const data = {...w.data,nodes:{...Object.fromEntries(Object.entries(w.data.nodes).map(([key,node])=>[key,{...node}])),[id]:{...nodeFields.parse({title:asset.name}),id,parentId,order:1e9}}};
    positionPlace(data,parentId,id,beforeNodeId || undefined);
    const candidates = [...stops,{nodeId:id,assetId:asset.id,coordinates:asset.geometry.coordinates}];
    const ordered = itineraryNodes(data,parentId).flatMap(node=>candidates.filter(stop=>stop.nodeId===node.id));
    return walkingGroups(data,ordered).find(group=>group.stops.some(stop=>stop.nodeId===id));
  },[w.data,parentId,asset,stops,beforeNodeId]);
  const key = JSON.stringify(group?.stops.map(stop=>stop.assetId));
  useEffect(() => {
    setRoutes({}); setError('');
    if (!group || group.stops.length<2 || group.stops.length>12) {setLoading(false);return;}
    const controller=new AbortController();setLoading(true);
    const timer=setTimeout(()=>{setError('路线影响计算超时。可重试，或仅加入地点后再安排交通。');setLoading(false);controller.abort();},20000);
    const query=async(ids:string[])=>{
      if(ids.length<2) return undefined;
      const result=await api<MapQueryResult>('/api/maps/queries',{method:'POST',body:JSON.stringify({action:'route',placeIds:ids,workspaceId:w.id,requestId:uid(),name:'加入地点 · 路线预览'}),signal:controller.signal});
      if(result.status!=='ok'||result.assets[0]?.route?.mode!=='walk') throw new Error(result.message);
      return result.assets[0];
    };
    const ids=group.stops.map(stop=>stop.assetId);
    void Promise.all([query(group.stops.filter(stop=>stop.nodeId!=='__preview_place__').map(stop=>stop.assetId)),query(ids)]).then(([before,after])=>{if(!controller.signal.aborted)setRoutes({before,after});}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{clearTimeout(timer);if(!controller.signal.aborted)setLoading(false);});
    return()=>{clearTimeout(timer);controller.abort();};
  },[w.id,key,attempt]);
  const before=routes.before?.route,after=routes.after?.route;
  const fixed = group?.stops.some(stop=>w.data.nodes[stop.nodeId]?.fixed);
  const distance = (value:number|null|undefined) => value==null ? '未知' : `${(value/1000).toFixed(2)} 公里`;
  const minutes = (value:number|null|undefined) => value==null ? '未知' : `${(value/60).toFixed(1)} 分钟`;
  return <Dialog title={`加入 ${asset.name}`} busy={busy} onClose={onClose}><div className="route-adoption-body">
    <p>加入「{w.data.nodes[parentId].title}」，时间待定。</p>
    <label>插入位置<select value={beforeNodeId} disabled={busy} onChange={e=>setBeforeNodeId(e.target.value)}>{positions.map(node=><option key={node.id} value={node.id}>在「{node.title}」之前</option>)}<option value="">末尾</option></select></label>
    <p className="subtle">确定日期的安排保持原顺序；新地点可插入待安排列表。</p>
    <ol>{group?.stops.map(stop=><li key={stop.nodeId}>{w.data.nodes[stop.nodeId]?.title || asset.name}</li>)}</ol>
    {loading && <p role="status">正在计算真实步行路径的变化…</p>}
    {after && <table className="route-impact"><thead><tr><th>移动影响</th><th>当前片段</th><th>加入后</th></tr></thead><tbody><tr><th>路程</th><td>{before ? distance(before.distanceMeters) : '单个地点'}</td><td>{distance(after.distanceMeters)}</td></tr><tr><th>预计移动</th><td>{before ? minutes(before.movingSeconds) : '尚无路径'}</td><td>{minutes(after.movingSeconds)}</td></tr></tbody></table>}
    {before?.movingSeconds!=null && after?.movingSeconds!=null && <p>移动时间约增加 {((after.movingSeconds-before.movingSeconds)/60).toFixed(1)} 分钟，不含参观和停留。</p>}
    {after && <a href={routes.after!.source.url} target="_blank" rel="noreferrer">路径来源</a>}
    {!loading && !after && !error && <p>新地点没有连续的可计算步行片段；加入后先单独呈现地点。</p>}
    {fixed && <p className="alert warning">片段包含固定安排；原时间保持不变。新地点停留时间未定，尚不能确认是否赶得上后续安排。</p>}
    <ErrorNotice error={error}/>
    {error && <button type="button" disabled={loading} onClick={()=>setAttempt(n=>n+1)}>重试计算</button>}
    {w.version!==baseVersion && <p role="alert">安排已更新，请关闭预览后重新检查。</p>}
    <div className="button-row"><button disabled={busy||loading||w.version!==baseVersion} onClick={async()=>{setBusy(true);try{await onConfirm(baseVersion,beforeNodeId || undefined);onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{after ? '确认加入安排' : '仅加入地点，交通待确认'}</button><button disabled={busy} onClick={onClose}>取消</button></div>
  </div></Dialog>;
}

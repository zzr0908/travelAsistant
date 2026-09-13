import {createPortal} from 'react-dom';
import './maps.css';
import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import type {WorkspaceView} from '../../shared/model';
import type {SpatialAsset, MapStatus} from '../../shared/maps';
import {api} from './api';
import {Dialog} from './Forms';
const MapCanvas=lazy(()=>import('./MapCanvas'));

export function NotePlaces({workspace:w,ids,onChange}:{workspace:WorkspaceView;ids:string[];onChange?:(ids:string[])=>void}) {
  const trigger=useRef<HTMLButtonElement | null>(null);
  const closeMap=()=>{setOpened(undefined);requestAnimationFrame(()=>trigger.current?.focus());};
  const [assets,setAssets]=useState<SpatialAsset[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[attempt,setAttempt]=useState(0);
  const [opened,setOpened]=useState<SpatialAsset>(),[status,setStatus]=useState<MapStatus>(),[mapError,setMapError]=useState('');
  const candidates=onChange ? [...new Set([...ids,...Object.values(w.data.spatial || {}).flatMap(refs=>refs.map(ref=>ref.assetId)),...Object.values(w.data.notebook || {}).flatMap(note=>note.spatialIds || [])])] : ids;
  const key=JSON.stringify(candidates);
  useEffect(()=>{
    const request=new AbortController();setAssets([]);setError('');setLoading(!!candidates.length);
    if(!candidates.length)return;
    const timer=setTimeout(()=>{setError('地点资料读取超时，请重试。');setLoading(false);request.abort();},10000);
    void (async()=>{
      const result:SpatialAsset[]=[];
      for(let offset=0;offset<candidates.length;offset+=600) {
        const response=await api<{assets:SpatialAsset[]}>('/api/maps/asset-set',{method:'POST',body:JSON.stringify({workspaceId:w.id,ids:candidates.slice(offset,offset+600)}),signal:request.signal});
        result.push(...response.assets);
      }
      if(!request.signal.aborted)setAssets(result);
    })().catch(e=>{if(!request.signal.aborted)setError(e.message);}).finally(()=>{clearTimeout(timer);if(!request.signal.aborted)setLoading(false);});
    return()=>{clearTimeout(timer);request.abort();};
  },[w.id,w.version,key,attempt]);
  useEffect(()=>{
    if(!opened)return;
    const request=new AbortController();setMapError('');setStatus(undefined);
    const timer=setTimeout(()=>{setMapError('地图加载超时，可关闭后重试。');request.abort();},10000);
    api<MapStatus>('/api/maps/status',{signal:request.signal}).then(value=>{if(!request.signal.aborted)setStatus(value);}).catch(e=>{if(!request.signal.aborted)setMapError(e.message);}).finally(()=>clearTimeout(timer));
    return()=>{clearTimeout(timer);request.abort();};
  },[opened?.id]);
  if(!onChange && !ids.length)return null;
  return <section className="note-places" aria-label="关联地点与路线">
    <h3>关联地点与路线</h3>
    {loading && <p role="status">正在读取地点资料…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={()=>setAttempt(n=>n+1)}>重试地点资料</button></div>}
    {!loading && !error && !assets.length && <p className="subtle">尚无可关联地点。可以先在地图中保存地点资料。</p>}
    {assets.map(asset=><div className="note-place-row" key={asset.id}>
      {onChange ? <label><input type="checkbox" checked={ids.includes(asset.id)} disabled={!ids.includes(asset.id)&&ids.length>=50} onChange={e=>onChange(e.target.checked?[...ids,asset.id]:ids.filter(id=>id!==asset.id))}/>{asset.name}</label> : <strong>{asset.name}</strong>}
      <span className="subtle">{asset.kind==='place'?'地点':asset.kind==='route'?'路线':'区域'}</span>
      <button type="button" className="text-button" onClick={e=>{trigger.current=e.currentTarget;setOpened(asset);}}>查看地图</button>
    </div>)}
    {!loading && ids.some(id=>!assets.some(asset=>asset.id===id)) && <p className="subtle">部分关联暂时无法读取；保存时仍保留原关联。</p>}
    {opened && createPortal(<Dialog title={opened.name} onClose={closeMap}><div className="note-place-map">
      <p>{opened.address}</p>
      {status?.available ? <Suspense fallback={<p role="status">正在准备地图…</p>}><MapCanvas items={[{id:opened.id,title:opened.name,geometry:opened.geometry,precision:opened.precision,schematic:opened.route?.mode==='schematic',suggested:opened.areaNature==='suggested'}]} selectedId={opened.id} onSelect={()=>{}} viewKey={`note:${w.id}:${opened.id}`} style={status.style}/></Suspense> : <p role="status">{mapError || status?.message || '正在读取地图状态…'}</p>}
      <a href={opened.source.url} target="_blank" rel="noreferrer">地点或路线来源</a>
    </div></Dialog>,document.body)}
  </section>;
}

import React,{useEffect,useRef,useState} from 'react';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type {Map as MapInstance} from 'maplibre-gl';
import {ArrowLeft,ChevronRight,Plus,BookOpen,X,Footprints,LocateFixed} from 'lucide-react';
import {geometry,places,type Scope,type Stop} from './data';
import 'maplibre-gl/dist/maplibre-gl.css';
maplibregl.setWorkerUrl(workerUrl);

const bounds:[[number,number],[number,number]]=[[11.2518,43.7674],[11.2617,43.7703]];
export function MapView({active,scope,selectedId,stops,stale,onSelect,onRead,onAdd,onOpenPlan}:{active:boolean;scope:Scope;selectedId?:string;stops:Stop[];stale:boolean;onSelect:(id?:string)=>void;onRead:(id:string)=>void;onAdd:(id:string)=>void;onOpenPlan:(id:string)=>void}){
  const container=useRef<HTMLDivElement>(null),map=useRef<MapInstance|null>(null);
  const markers=useRef<maplibregl.Marker[]>([]),callback=useRef(onSelect);callback.current=onSelect;
  const [ready,setReady]=useState(false),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const previousScope=useRef<Scope>('day');
  const selected=places.find(p=>p.id===selectedId), selectedStop=stops.find(s=>s.id===selected?.id),root=scope==='day'||scope==='trip'||scope==='walk';
  useEffect(()=>{
    if(!active||map.current||!container.current)return;
    try{
      const m=new maplibregl.Map({container:container.current,style:{version:8,sources:{basemap:{type:'image',url:'/assets/florence-basemap.png',coordinates:[[11.2445068359375,43.77506035122469],[11.2664794921875,43.77506035122469],[11.2664794921875,43.76315996157265],[11.2445068359375,43.76315996157265]]}},layers:[{id:'background',type:'background',paint:{'background-color':'#edf0f3'}},{id:'basemap',type:'raster',source:'basemap',paint:{'raster-saturation':-.4}}]},bounds,fitBoundsOptions:{padding:48},maxBounds:[[11.2445068359375,43.76315996157265],[11.2664794921875,43.77506035122469]],minZoom:13.8,maxZoom:18.2,attributionControl:{compact:false,customAttribution:'© <a href="https://www.geoapify.com/">Geoapify</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'},pitchWithRotate:false,dragRotate:false,touchPitch:false});
      map.current=m;m.touchZoomRotate.disableRotation();m.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
      m.on('load',()=>{
        m.addSource('walk',{type:'geojson',data:geometry.route as any});
        m.addLayer({id:'walk-halo',type:'line',source:'walk',layout:{'line-cap':'round','line-join':'round'},paint:{'line-width':8,'line-color':'#fff','line-opacity':.9}});
        m.addLayer({id:'walk-line',type:'line',source:'walk',layout:{'line-cap':'round','line-join':'round'},paint:{'line-width':4,'line-color':'#315ed2'}});
        setReady(true);
      });
      m.on('error',()=>setError(true));
    }catch{setError(true);}
  },[active,attempt]);
  useEffect(()=>()=>{markers.current.forEach(m=>m.remove());map.current?.remove();map.current=null;},[]);
  useEffect(()=>{if(!active||!map.current)return;const frame=requestAnimationFrame(()=>map.current?.resize());return()=>cancelAnimationFrame(frame);},[active]);
  useEffect(()=>{if(!container.current)return;const ro=new ResizeObserver(()=>map.current?.resize());ro.observe(container.current);return()=>ro.disconnect();},[]);
  useEffect(()=>{
    if(!ready||!map.current)return;
    markers.current.forEach(m=>m.remove());markers.current=[];
    places.forEach(p=>{
      const index=stops.findIndex(s=>s.id===p.id),button=document.createElement('button');
      button.type='button';button.className=`place-marker ${index>=0?'planned':'recommendation'} ${selectedId===p.id?'selected':''} ${!root&&scope!==p.id?'deemphasized':''}`;
      button.textContent=index>=0?String(index+1):'+';
      button.setAttribute('aria-label',`${p.name} · ${index>=0?'已安排':'附近推荐'}`);button.setAttribute('aria-pressed',String(selectedId===p.id));
      button.addEventListener('click',e=>{e.stopPropagation();callback.current(p.id);});
      markers.current.push(new maplibregl.Marker({element:button}).setLngLat(p.coordinates).addTo(map.current!));
    });
    if(map.current.getLayer('walk-line'))map.current.setPaintProperty('walk-line','line-color',stale?'#8b919b':'#315ed2');
  },[ready,selectedId,stops,scope,stale]);
  useEffect(()=>{
    if(!ready||!map.current||previousScope.current===scope)return;
    previousScope.current=scope;
    if(root)map.current.fitBounds(bounds,{padding:48,duration:350});
    else{const p=places.find(p=>p.id===scope);if(p)map.current.easeTo({center:p.coordinates,zoom:16.8,duration:350});}
  },[scope,ready]);
  const retry=()=>{markers.current.forEach(m=>m.remove());map.current?.remove();map.current=null;setReady(false);setError(false);setAttempt(a=>a+1);};
  return <section className="view map-view" aria-label="地图">
    <div className="map-summary"><div><Footprints size={18}/><strong>{stale?'路线待更新':'步行 0.76 公里'}</strong><span>{stale?'下方保留原路线':'约 13 分钟 · 不含停留'}</span></div><span className="map-legend"><i className="legend-planned"/>已安排<i className="legend-nearby"/>附近推荐</span></div>
    <div className="map-layout"><div className="map-stage"><div ref={container} className="map-canvas" aria-label="佛罗伦萨步行地图"/><button className="map-fit button" onClick={()=>map.current?.fitBounds(bounds,{padding:48,duration:350})}><LocateFixed size={16}/>查看全部</button>{error&&<div className="map-error" role="status">底图未完整加载，地点列表仍可查看。<button onClick={retry}>重试</button></div>}</div>
      <aside className="map-reading" aria-label="地点与附近推荐">{selected?<article className="place-detail"><div className="detail-top"><span className={selectedStop?'planned-label':'nearby-label'}>{selectedStop?'已安排':'附近推荐'} · {selected.kind}</span><button className="icon-button" aria-label="关闭地点详情" onClick={()=>onSelect(undefined)}><X size={19}/></button></div>{selected.photo&&<button className="detail-photo" aria-label={`阅读${selected.name}介绍`} onClick={()=>onRead(selected.article)}><img src={selected.photo} alt="乌菲齐建筑"/></button>}<h2>{selected.name}</h2><p className="local-name">{selected.localName}</p><p className="detail-description">{selected.description}</p><div className="detail-actions"><button className="button" onClick={()=>onRead(selected.article)}><BookOpen size={16}/>查看笔记</button>{selectedStop?<button className="text-button" onClick={()=>onOpenPlan(selected.id)}>打开安排<ChevronRight size={16}/></button>:<button className="button primary" onClick={()=>onAdd(selected.id)}><Plus size={16}/>加入安排</button>}</div><details className="source-details"><summary>来源与说明</summary><p>固定推荐样例；坐标来自已保存的地图数据，未实时核对营业与开放。</p><a href={selected.source} target="_blank" rel="noreferrer">查看来源</a></details></article>:<><div className="map-list-heading"><h2>{root?'沿途安排':'当前安排与沿途'}</h2><span>{stops.length}</span></div><div className="map-stop-list">{stops.map((s,i)=><button key={s.id} onClick={()=>onSelect(s.id)}><span className="step-number">{i+1}</span><span><strong>{s.title}</strong><small>{s.time}</small></span><ChevronRight size={16}/></button>)}</div><div className="nearby-heading"><h2>附近值得看看</h2></div><div className="nearby-list">{places.filter(p=>!stops.some(s=>s.id===p.id)).map(p=><button key={p.id} onClick={()=>onSelect(p.id)}><span className="nearby-symbol">+</span><span><strong>{p.name}</strong><small>{p.kind}</small></span><ChevronRight size={16}/></button>)}</div></>}</aside>
    </div>
    {selected&&<button className="back-link mobile-map-back" onClick={()=>onSelect(undefined)}><ArrowLeft size={16}/>返回地点列表</button>}
  </section>;
}

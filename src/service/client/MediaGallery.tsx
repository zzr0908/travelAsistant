import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, ExternalLink, ImageOff, Images, MapPin, RefreshCw, X } from 'lucide-react';
import type { MediaAsset } from '../../shared/agent';
import { api, post } from './api';
import type { MediaMapTarget } from './map-media';
export const mediaUrl = (id: string, workspaceId?: string, thumb = true) => `/api/media/${id}?size=${thumb ? 'thumb' : 'full'}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`;
const hostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return '来源'; } };
const safeLink = (url: string) => /^https?:\/\//i.test(url) ? url : undefined;
export function Lightbox({ images, index, workspaceId, onClose, onIndex }: { images: MediaAsset[]; index: number; workspaceId?: string; onClose(): void; onIndex(index: number): void }) {
  const dialog = useRef<HTMLDialogElement>(null), touch = useRef<number | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; state: 'ready' | 'failed' } | null>(null), [version, setVersion] = useState(0);
  const image = images[index];
  const imageKey = `${image.id}:${version}`, failed = loaded?.key === imageKey && loaded.state === 'failed', loading = loaded?.key !== imageKey;
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current?.showModal(); return () => { document.body.style.overflow = previous; }; }, []);
  return createPortal(<dialog ref={dialog} className="media-lightbox" aria-label="来源图片预览" onCancel={onClose} onClose={onClose} onKeyDown={e => { if (e.key === 'ArrowRight' && index < images.length - 1) { e.preventDefault(); onIndex(index + 1); } if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onIndex(index - 1); } }}>
    <header><div><span className="overline">来源图片</span><p aria-live="polite">{index + 1} / {images.length} · {image.kind === 'screenshot' ? '网页截图' : '页面配图'}</p></div><button className="icon-button" autoFocus onClick={onClose} aria-label="关闭图片预览"><X/></button></header>
    <div className="lightbox-stage" onTouchStart={e => { touch.current = e.touches[0].clientX; }} onTouchEnd={e => { if (touch.current === null) return; const delta = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(delta) > 60) onIndex(Math.max(0, Math.min(images.length - 1, index + (delta < 0 ? 1 : -1)))); }}>
      {failed ? <div className="media-empty"><ImageOff/><p>图片暂时无法加载，说明与来源仍保留。</p><button onClick={() => setVersion(v => v+1)}><RefreshCw size={16}/>重试加载</button></div> : <><img key={imageKey} className={loading ? 'media-pending' : undefined} src={`${mediaUrl(image.id, image.accessWorkspaceId || workspaceId, false)}&v=${version}`} width={image.width || undefined} height={image.height || undefined} alt={image.alt || image.caption || `${image.sourceTitle}的来源配图，未提供文字描述`} onLoad={() => setLoaded({key:imageKey,state:'ready'})} onError={() => setLoaded({key:imageKey,state:'failed'})}/>{loading && <span className="media-loading" role="status"><Images size={22}/><span>正在加载图片…</span></span>}</>}
    </div>
    <footer><div className="lightbox-controls"><button disabled={index === 0} onClick={() => onIndex(index - 1)}><ArrowLeft size={18}/>上一张</button><span className="subtle">原始比例 · {image.width} × {image.height}</span><button disabled={index === images.length - 1} onClick={() => onIndex(index + 1)}>下一张<ArrowRight size={18}/></button></div>
      <div className="lightbox-caption"><p>{image.caption || image.alt || '来源未提供图片说明'}</p><a href={safeLink(image.sourceUrl)} target="_blank" rel="noreferrer">{image.sourceTitle || hostname(image.sourceUrl)} <ExternalLink size={14}/></a><p className="subtle">采集于 {new Date(image.retrievedAt).toLocaleString()} · 模型未解读图像内容{image.license ? ` · ${image.license}` : ''}</p></div>
    </footer>
  </dialog>, document.body);
}
function Thumbnail({ image, workspaceId, onOpen }: {image: MediaAsset; workspaceId?: string; onOpen(button: HTMLButtonElement): void}) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  return <button className="media-thumbnail" data-media-id={image.id} onClick={e => onOpen(e.currentTarget)} aria-label={`查看图片：${image.alt || image.caption || image.sourceTitle}`}>
    {state === 'failed' ? <span className="media-empty"><ImageOff size={22}/><span>图片暂不可用<br/>点击查看详情</span></span> : <><img className={state === 'loading' ? 'media-pending' : undefined} loading="lazy" decoding="async" src={mediaUrl(image.id, image.accessWorkspaceId || workspaceId)} width={image.width || undefined} height={image.height || undefined} alt={image.alt || image.caption || `${image.sourceTitle}的来源配图，未提供文字描述`} onLoad={() => setState('ready')} onError={() => setState('failed')}/>{state === 'loading' && <span className="media-loading" role="status"><Images size={22}/><span>正在加载图片…</span></span>}</>}
    <span className="media-expand"><Images size={14}/>查看大图</span>
  </button>;
}
export function MediaGallery({ images, workspaceId, title = '来源图集', empty = false, selected, onSelect, onRetry, mapTargets = [], onLocate }: {images: MediaAsset[]; workspaceId?: string; title?: string; empty?: boolean; selected?: string[]; onSelect?(id: string): void; onRetry?(): void; mapTargets?: MediaMapTarget[]; onLocate?(target: MediaMapTarget, button: HTMLButtonElement): void}) {
  const [imageId, setImageId] = useState<string | null>(null), [expanded, setExpanded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const focus = useRef<HTMLElement | null>(null), position = useRef({x:0,y:0,parent:null as HTMLElement|null,top:0});
  const ready = images.filter(m => m.status === 'ready'), others = images.filter(m => m.status !== 'ready');
  const index = imageId === null ? -1 : ready.findIndex(image => image.id === imageId);
  const close = () => { setImageId(null); requestAnimationFrame(() => {if(document.activeElement && ![document.body,document.documentElement,focus.current].includes(document.activeElement as HTMLElement))return;focus.current?.focus({preventScroll:true});window.scrollTo({left:position.current.x,top:position.current.y,behavior:'instant'});if(position.current.parent)position.current.parent.scrollTop=position.current.top;}); };
  useEffect(() => { if (imageId !== null && index < 0) close(); }, [imageId, index]);
  if (!images.length && !empty) return null;
  return <section className="media-gallery" aria-label={title}>
    <div className="media-gallery-heading"><h4><Images size={16}/>{title}</h4><span className="subtle">{ready.length} 张{ready.length ? ' · 点击放大' : ''}</span></div>
    {ready.length ? <div className={`media-grid ${ready.length === 1 ? 'single' : ''}`}>{(expanded ? ready : ready.slice(0,3)).map(image => { const targets = mapTargets.filter(t => t.mediaIds.includes(image.id)); return <figure key={image.id}><Thumbnail image={image} workspaceId={workspaceId} onOpen={button => { focus.current = button; const parent = button.closest('.agent-panel-body') as HTMLElement | null; position.current = {x:scrollX,y:scrollY,parent,top:parent?.scrollTop || 0}; setImageId(image.id); }}/><figcaption><span className="media-caption">{image.caption || image.alt || image.sourceTitle || '来源未提供图片说明'}</span><span className="media-origin">{image.kind === 'screenshot' ? '网页截图' : '来源图片'} · {hostname(image.sourceUrl)}</span></figcaption>{onLocate && targets.length === 1 && <button className="media-map-link" data-media-id={image.id} data-map-target={targets[0].id} onClick={e => onLocate(targets[0], e.currentTarget)}><MapPin size={16}/>在地图上查看</button>}{onLocate && targets.length > 1 && <details className="media-map-links"><summary>查看关联地点（{targets.length}）</summary>{targets.map(target => <button key={target.id} data-media-id={image.id} data-map-target={target.id} onClick={e => onLocate(target,e.currentTarget)}><MapPin size={16}/>{target.label}</button>)}</details>}{onSelect && <button className={selected?.includes(image.id) ? 'media-select selected' : 'media-select'} aria-pressed={selected?.includes(image.id)} onClick={() => onSelect(image.id)}>{selected?.includes(image.id) ? <Check size={16}/> : <Images size={16}/>} {selected?.includes(image.id) ? '已选配图' : '选择配图'}</button>}</figure>; })}</div> : <p className="media-no-images"><ImageOff size={18}/>本次尚无可展示图片，仍可阅读文字资料与来源。</p>}
    {ready.length > 3 && <button className="media-more" onClick={() => setExpanded(x => !x)}>{expanded ? '收起图集' : `展开其余 ${ready.length - 3} 张图片`}</button>}
    {ready.length > 0 && <p className="media-note">图片出处见图注；模型未解读图像内容。</p>}
    {!!others.length && <details className="media-issues"><summary>{others.filter(m => m.status === 'excluded').length} 张已过滤 · {others.filter(m => m.status !== 'excluded').length} 张未保存</summary>{others.map(m => <div key={m.id}><p>{m.alt || m.sourceTitle}：{m.message}</p>{m.status === 'failed' && onRetry && <button disabled={!!busy} onClick={async () => { setBusy(m.id); setError(''); try { await post(`/api/media/${m.id}/retry`, {}); onRetry(); } catch(e) { setError((e as Error).message); } finally { setBusy(''); } }}>{busy === m.id ? '正在重新采集…' : '重试图片采集'}</button>}</div>)}</details>}
    {error && <p role="alert" className="alert warning">{error}</p>}
    {index >= 0 && ready[index] && <Lightbox images={ready} index={index} workspaceId={workspaceId} onClose={close} onIndex={next => setImageId(ready[next]?.id || null)}/>}
  </section>;
}
export function WorkspaceMedia({ workspaceId, nodeId, version, editable, onSave, mapTargets, onLocate }: {workspaceId: string; nodeId: string; version: number; editable: boolean; onSave(ids: string[], baseVersion: number): Promise<unknown>; mapTargets?: MediaMapTarget[]; onLocate?(target: MediaMapTarget, button: HTMLButtonElement): void}) {
  const [mapNames,setMapNames] = useState<Record<string,string>>({});
  const [images, setImages] = useState<MediaAsset[]>([]), [options, setOptions] = useState<MediaAsset[]>([]), [selected, setSelected] = useState<string[]>([]), [managing, setManaging] = useState(false), [error,setError] = useState(''), [busy,setBusy] = useState(false), [search,setSearch]=useState(''), [baseVersion,setBaseVersion]=useState(version);
  const editing=useRef(managing);editing.current=managing;
  useEffect(() => {setManaging(false);setError('');setImages([]);setMapNames({});},[workspaceId,nodeId]);
  useEffect(() => { let live=true; api<{media:MediaAsset[];mapNames?:Record<string,string>}>(`/api/workspaces/${workspaceId}/media?nodeId=${nodeId}`).then(r => { if (live) { setImages(r.media);setMapNames(r.mapNames || {}); if(!editing.current)setSelected(r.media.map(m => m.id)); } }).catch(e => { if (live) setError(e.message); }); return () => {live=false;}; }, [workspaceId,nodeId,version]);
  return <section className="workspace-media">{!!images.length && <MediaGallery images={images} workspaceId={workspaceId} title="这份安排的配图" mapTargets={mapTargets?.map(t=>({...t,label:mapNames[t.assetId] || t.label}))} onLocate={onLocate}/>}
    {editable && <button className="text-button" disabled={busy} onClick={async () => { if (managing) {setManaging(false);return;} setBusy(true); setError(''); try { const result = await api<{media:MediaAsset[]}>(`/api/workspaces/${workspaceId}/media-options`); setOptions(result.media); setBaseVersion(version); setSearch(''); setSelected(images.map(m=>m.id)); setManaging(true); } catch(e) {setError((e as Error).message);} finally {setBusy(false);} }}><Images size={16}/>{busy ? '正在读取配图…' : managing ? '取消修改配图' : images.length ? '管理配图' : '添加采集到的配图'}</button>}
    {managing && <div className="media-manager"><h3>选择这份安排的配图</h3><p className="subtle">勾选后先检查下方变更，再保存到计划。保存后成员可见，可从修改记录撤销。</p><label className="media-picker-search">查找采集图片<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="按景点、图片说明或来源查找"/></label><MediaGallery images={options.filter(m => `${m.alt} ${m.caption} ${m.sourceTitle}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} empty selected={selected} onSelect={id => setSelected(ids => ids.includes(id) ? ids.filter(x=>x!==id) : [...ids,id])}/><p>当前 {images.length} 张 → 保存后 {selected.length} 张</p>{baseVersion !== version && <div className="trace-warning" role="status"><p>计划已更新，你的配图选择已保留。请对照上方当前配图，确认后继续。</p><button onClick={()=>setBaseVersion(version)}>已查看最新版本，保留选择</button></div>}<div className="button-row"><button disabled={busy || baseVersion !== version || selected.length > 30 || JSON.stringify(selected) === JSON.stringify(images.map(m=>m.id))} className="primary" onClick={async () => {setBusy(true);setError('');try {await onSave(selected,baseVersion);setManaging(false);} catch(e) {setError((e as Error).message);} finally {setBusy(false);} }}>保存配图变更</button><button onClick={() => setSelected([])}>解除全部关联</button></div></div>}
    {error && <p className="alert warning" role="alert">{error}</p>}
  </section>;
}

export function PlaceMedia({ workspaceId, nodeId, version, label, mediaIds, mapTargets, onLocate, onSave }: { workspaceId: string; nodeId: string; version: number; label: string; mediaIds: string[]; mapTargets: MediaMapTarget[]; onLocate(target: MediaMapTarget, button: HTMLButtonElement): void; onSave?(ids: string[], version: number): Promise<unknown> }) {
  const [images,setImages]=useState<MediaAsset[]>([]), [loaded,setLoaded]=useState(false), [error,setError]=useState(''), [editing,setEditing]=useState(false), [selected,setSelected]=useState<string[]>([]), [baseVersion,setBaseVersion]=useState(version), [busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setLoaded(false);
    const timer=setTimeout(()=>{setError('读取配图超时，地点说明仍可查看。');controller.abort();},10000);
    api<{media:MediaAsset[]}>(`/api/workspaces/${workspaceId}/media?nodeId=${nodeId}`,{signal:controller.signal}).then(r=>{if(!controller.signal.aborted){setImages(r.media);setError('');setLoaded(true);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>clearTimeout(timer));
    return()=>{clearTimeout(timer);controller.abort();};
  },[workspaceId,nodeId,version]);
  const related=images.filter(m=>mediaIds.includes(m.id)), other=images.filter(m=>!mediaIds.includes(m.id));
  return <section className="place-media" aria-label="地图关联配图">
    {related.length ? <MediaGallery images={related} workspaceId={workspaceId} title={`与「${label}」相关的配图`}/> : <p className="subtle">{mediaIds.length ? !loaded&&!error ? '正在读取关联配图…' : '关联配图当前不可访问，地点说明仍可查看。' : '这处地图内容尚未关联配图。'}</p>}
    {!!other.length && !editing && <details><summary>这份安排的其他配图（{other.length}）</summary><MediaGallery images={other} workspaceId={workspaceId} mapTargets={mapTargets} onLocate={onLocate}/></details>}
    {onSave && images.length > 0 && !editing && <button className="text-button" onClick={()=>{setSelected(mediaIds);setBaseVersion(version);setEditing(true);setError('');}}>选择相关配图</button>}
    {editing && <div className="media-manager"><h4>为「{label}」选择配图</h4><p className="subtle">这里只关联内容，不代表图片的拍摄位置。</p><MediaGallery images={images} workspaceId={workspaceId} selected={selected} onSelect={id=>setSelected(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id])}/><p>当前 {mediaIds.length} 张 → 保存后 {selected.length} 张</p>{baseVersion!==version && <p className="alert warning">计划已更新，请取消后重新检查关联。</p>}<div className="button-row"><button className="primary" disabled={busy||baseVersion!==version||JSON.stringify(selected)===JSON.stringify(mediaIds)} onClick={async()=>{setBusy(true);setError('');try{await onSave?.(selected,baseVersion);setEditing(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存配图关联</button><button disabled={busy} onClick={()=>setEditing(false)}>取消</button></div></div>}
    {error && <p className="alert warning" role="alert">{error}</p>}
  </section>;
}

import {createPortal} from 'react-dom';
import {useEffect,useRef,useState} from 'react';
import type {AgentRunView} from '../../shared/agent';
import type {WorkspaceView,WorkspaceSummary} from '../../shared/model';
import {researchNote} from '../../shared/research-note';
import {Dialog,ErrorNotice} from './Forms';
import {RichContent} from './RichContent';
import {api,post,uid,ApiError} from './api';

export function SaveResearchNote({run,onClose,onSaved}:{run:AgentRunView;onClose:()=>void;onSaved:(id:string)=>Promise<void>}) {
 const [fields,setFields]=useState(()=>researchNote(run)),[workspace,setWorkspace]=useState<WorkspaceView>(),[version,setVersion]=useState<number>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[preview,setPreview]=useState(false),[saved,setSaved]=useState(false);
 const [destination,setDestination]=useState(run.scope.workspaceId || ''),[destinations,setDestinations]=useState<WorkspaceSummary[]>([]),[listing,setListing]=useState(!run.scope.workspaceId);
 useEffect(()=>{
  if(run.scope.workspaceId)return;
  const controller=new AbortController();setListing(true);setError('');
  api<{workspaces:WorkspaceSummary[]}>('/api/workspaces',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setDestinations(result.workspaces.filter(w=>w.role!=='reader'));}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setListing(false);});
  return()=>controller.abort();
 },[run.scope.workspaceId,attempt]);
 const spatialChoices=[...new Set([...(run.researchPlaceIds || []),...(run.output?.spatial || []).map(ref=>ref.assetId)])];
 const request=useRef<{key:string;id:string} | undefined>(undefined);
 useEffect(()=>{
  setWorkspace(undefined);setVersion(undefined);
  if(!destination)return;
  const controller=new AbortController();setError('');
  api<WorkspaceView>(`/api/workspaces/${destination}`,{signal:controller.signal}).then(w=>{if(!controller.signal.aborted){setWorkspace(w);setVersion(w.version);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
  return()=>controller.abort();
 },[destination,attempt]);
 return createPortal(<Dialog title="保存研究为笔记" busy={busy} onClose={onClose}><form className="route-adoption-body research-note-form" onSubmit={async e=>{
  e.preventDefault();if(busy || saved || !workspace || workspace.id!==destination || workspace.role==='reader' || workspace.version!==version || version===undefined)return;
  setBusy(true);setError('');
  const command={kind:'note',workspaceId:workspace.id,version,payload:{note:fields}},key=JSON.stringify(command);
  if(request.current?.key!==key)request.current={key,id:uid()};
  try{await post('/api/commands',{...command,requestId:request.current.id});setSaved(true);try{await onSaved(workspace.id);}catch{setError('笔记已保存，页面刷新失败。关闭后刷新即可查看。');}}
  catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status===409){try{setWorkspace(await api<WorkspaceView>(`/api/workspaces/${workspace.id}`));}catch{ /* Keep draft and conflict visible. */ }}}
  finally{setBusy(false);}
 }}>
 {saved ? <><p role="status">已保存到旅行笔记，行程未改变。</p><button type="button" onClick={onClose}>完成</button></> : <>
 {!run.scope.workspaceId && <label>保存到<select required value={destination} disabled={busy||listing} onChange={e=>{setWorkspace(undefined);setVersion(undefined);setDestination(e.target.value);}}><option value="">选择旅行或独立计划</option>{destinations.map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label>}
 {!run.scope.workspaceId && !listing && !destinations.length && !error && <p>还没有可编辑的旅行或独立计划。请先创建，再回来保存研究。</p>}
 {workspace && <p>保存到「{workspace?.data.nodes[workspace.data.rootId].title || '当前旅行'}」的笔记资料库。旅行成员可阅读下方正文及勾选的图片、地点；不会采用行程提议。</p>}
 {(listing || (destination && !workspace && !error)) && <p role="status">正在读取旅行…</p>}
 {!workspace && error && <button type="button" onClick={()=>setAttempt(n=>n+1)}>重试读取旅行</button>}
 <label>笔记标题<input required maxLength={160} value={fields.title} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
 <button type="button" onClick={()=>setPreview(v=>!v)}>{preview?'继续编辑':'预览正文'}</button>
 {preview?<RichContent preserveLineEscapes text={fields.body} images={run.media.filter(m=>m.status==='ready'&&fields.mediaIds.includes(m.id))}/>:<label>笔记正文<textarea rows={12} maxLength={100000} value={fields.body} onChange={e=>setFields({...fields,body:e.target.value})}/></label>}
 {!!run.output?.media.length && <fieldset><legend>保存配图</legend>{run.media.filter(m=>m.status==='ready'&&run.output?.media.some(ref=>ref.mediaId===m.id)).map(m=><label className="note-checklist-step" key={m.id}><input type="checkbox" checked={fields.mediaIds.includes(m.id)} onChange={e=>setFields({...fields,mediaIds:e.target.checked?[...fields.mediaIds,m.id]:fields.mediaIds.filter(id=>id!==m.id)})}/>{m.caption || m.alt || m.sourceTitle}</label>)}</fieldset>}
 {!!spatialChoices.length && <fieldset><legend>关联地点与路线（最多 50 项）</legend>{spatialChoices.map(id=><label className="note-checklist-step" key={id}><input type="checkbox" checked={fields.spatialIds?.includes(id)} disabled={!fields.spatialIds?.includes(id)&&(fields.spatialIds?.length || 0)>=50} onChange={e=>setFields({...fields,spatialIds:e.target.checked?[...(fields.spatialIds || []),id]:fields.spatialIds?.filter(value=>value!==id)})}/>{run.spatial?.find(asset=>asset.id===id)?.name || '关联地图资料'}</label>)}</fieldset>}
 {workspace&&workspace.version!==version && <div role="alert"><p>旅行已有更新，草稿已保留。请确认仍要保存到这份旅行。</p><button type="button" onClick={()=>{setVersion(workspace.version);setError('');}}>按最新版本保存此草稿</button></div>}
 {workspace?.role==='reader' && <p>当前为只读权限，无法保存笔记。</p>}
 <button disabled={busy||!workspace||workspace.id!==destination||workspace.role==='reader'||workspace.version!==version}>{busy?'保存中…':'保存到旅行笔记'}</button>
 </>}
 <ErrorNotice error={error}/>
 </form></Dialog>,document.body);
}

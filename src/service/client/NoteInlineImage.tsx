import {useState} from 'react';
import type {MediaAsset} from '../../shared/agent';
import {mediaUrl} from './MediaGallery';
export function NoteInlineImage({image,alt,workspaceId,onOpen}:{image:MediaAsset;alt?:string;workspaceId?:string;onOpen:(button:HTMLButtonElement)=>void}) {
 const [state,setState]=useState<'loading'|'ready'|'failed'>('loading'),[attempt,setAttempt]=useState(0);
 const label=alt || image.alt || image.sourceTitle;
 return <span className="note-inline-image">
  {state==='failed'?<span className="note-image-error" role="status">图片暂时无法加载，说明仍保留。<button type="button" onClick={()=>{setAttempt(n=>n+1);setState('loading');}}>重试图片</button><button type="button" onClick={e=>onOpen(e.currentTarget)}>查看图片详情</button></span>:<button type="button" aria-label={`放大图片：${label}`} onClick={e=>onOpen(e.currentTarget)}>
   <img key={attempt} loading="lazy" decoding="async" src={`${mediaUrl(image.id,image.accessWorkspaceId || workspaceId)}&v=${attempt}`} width={image.width || undefined} height={image.height || undefined} alt={label} onLoad={()=>setState('ready')} onError={()=>setState('failed')}/>
   {state==='loading' && <span role="status">正在加载图片…</span>}
  </button>}
  <span>{alt || image.caption || image.alt}</span>
 </span>;
}

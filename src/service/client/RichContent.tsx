import { createContext, useContext, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../shared/agent';
import { NoteInlineImage } from './NoteInlineImage';
import { Lightbox } from './MediaGallery';
import Markdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
const ImageContext=createContext<{images:MediaAsset[];workspaceId?:string;open:(id:string,button:HTMLButtonElement)=>void}>({images:[],open:()=>{}});
const components:Components={
    a: ({children, href}) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    img: ({alt, src}) => {
      const {images,workspaceId,open}=useContext(ImageContext);
      const image = images.find(image => src === `media:${image.id}`);
      return image ? <NoteInlineImage image={image} alt={alt} workspaceId={workspaceId} onOpen={button=>open(image.id,button)}/> : <span className="subtle">{alt ? `图片说明：${alt}（见来源图集）` : '图片见来源图集'}</span>;
    },
    table: ({children}) => <div className="rich-table" tabIndex={0} role="region" aria-label="可横向滚动的数据表"><table>{children}</table></div>,
};
export function RichContent({ text, images = [], workspaceId, preserveLineEscapes = false }: {text: string; images?: MediaAsset[]; workspaceId?: string; preserveLineEscapes?:boolean}) {
  const [opened, setOpened] = useState<string>();
  const imageIndex = images.findIndex(image => image.id === opened);
  const origin=useRef<{button:HTMLButtonElement;x:number;y:number;parent:HTMLElement|null;top:number} | undefined>(undefined);
  const open=useCallback((id:string,button:HTMLButtonElement)=>{
    const parent=button.closest('.agent-panel-body,dialog') as HTMLElement|null;
    origin.current={button,x:scrollX,y:scrollY,parent,top:parent?.scrollTop || 0};setOpened(id);
  },[]);
  const restoring=useRef(false);
  const close=()=>{restoring.current=true;setOpened(undefined);};
  useLayoutEffect(()=>{
    if(opened!==undefined || !restoring.current)return;
    restoring.current=false;
    const frame=requestAnimationFrame(()=>{
      const saved=origin.current;
      if(!saved?.button.isConnected)return;
      saved.button.focus({preventScroll:true});
      window.scrollTo({left:saved.x,top:saved.y,behavior:'instant'});
      if(saved.parent)saved.parent.scrollTop=saved.top;
    });
    return()=>cancelAnimationFrame(frame);
  },[opened]);
  return <ImageContext.Provider value={{images,workspaceId,open}}><div className="rich-content"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={url=>url.startsWith('media:')&&images.some(image=>image.id===url.slice(6))?url:/^(https?:\/\/|#)/i.test(url)?url:''} components={components}>{preserveLineEscapes?text:text.replaceAll('\\n','\n')}</Markdown>{imageIndex >= 0 && <Lightbox images={images} index={imageIndex} workspaceId={workspaceId} onIndex={index=>setOpened(images[index]?.id)} onClose={close}/>}</div></ImageContext.Provider>;
}

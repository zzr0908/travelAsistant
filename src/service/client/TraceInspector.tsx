import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Copy,X} from 'lucide-react';
export function TraceInspector({title,value,onClose}:{title:string;value:unknown;onClose():void}) {
 const dialog=useRef<HTMLDialogElement>(null),[notice,setNotice]=useState('');
 useEffect(()=>{const overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.showModal();return()=>{document.body.style.overflow=overflow;};},[]);
 return createPortal(<dialog ref={dialog} className="trace-inspector" aria-label="执行详情宽视图" onClose={onClose} onCancel={onClose}><header><div><span className="overline">完整执行记录</span><h2>{title}</h2></div><button className="icon-button" autoFocus aria-label="关闭执行详情" onClick={onClose}><X/></button></header><div className="inspector-toolbar"><p>原始输入、输出与关联资料 · 已隐藏凭据</p><button onClick={async()=>{setNotice('正在复制完整详情…');try{await navigator.clipboard.writeText(JSON.stringify(value,null,2));setNotice('已复制完整详情');}catch{setNotice('复制失败，可选择下方文字复制。');}}}><Copy size={15}/>复制详情</button></div><pre tabIndex={0} aria-label="完整原始详情">{JSON.stringify(value,null,2)}</pre><footer><span role="status">{notice || '关闭后返回原步骤与阅读位置；查看不会重新执行工具。'}</span><button onClick={onClose}>返回执行轨迹</button></footer></dialog>,document.body);
}

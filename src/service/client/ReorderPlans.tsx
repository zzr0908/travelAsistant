import {useState} from 'react';
import {ArrowUp,ArrowDown} from 'lucide-react';
import {dateLabel,type WorkspaceView} from '../../shared/model';
import {itineraryGroups} from '../../shared/itinerary';
import {Dialog,ErrorNotice} from './Forms';

export function ReorderPlans({workspace:w,parentId,onSave,onClose}:{workspace:WorkspaceView;parentId:string;onSave(nodeIds:string[],version:number):Promise<unknown>;onClose():void}) {
  const [initial] = useState(()=>itineraryGroups(w.data,parentId).flatMap(group=>group.nodes.map(n=>n.id)));
  const [ids,setIds] = useState(initial), [version] = useState(w.version), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const swap=(index:number,delta:number)=>{const next=[...ids];[next[index],next[index+delta]]=[next[index+delta],next[index]];setIds(next);setError('');};
  return <Dialog title="调整子计划顺序" busy={busy} onClose={onClose}><div className="route-adoption-body">
    <p>确认后计划与地图使用以下顺序。日期与确定时间保持不变。</p>
    <ol className="reorder-list">{ids.map((id,index)=>{const node=w.data.nodes[id];return <li key={id}><div><strong>{node?.title || '该安排已移除'}</strong><small>{node && dateLabel(node.dates)}</small></div><button aria-label={`上移：${node?.title}`} disabled={index===0||busy} onClick={()=>swap(index,-1)}><ArrowUp size={16}/></button><button aria-label={`下移：${node?.title}`} disabled={index===ids.length-1||busy} onClick={()=>swap(index,1)}><ArrowDown size={16}/></button></li>;})}</ol>
    {w.version!==version && <p role="alert">安排已更新，请关闭后重新检查。</p>}
    <ErrorNotice error={error}/><div className="button-row"><button disabled={busy||w.version!==version||JSON.stringify(ids)===JSON.stringify(initial)} onClick={async()=>{setBusy(true);setError('');try{await onSave(ids,version);onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>确认调整顺序</button><button disabled={busy} onClick={onClose}>取消</button></div>
  </div></Dialog>;
}

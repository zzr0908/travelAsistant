import {useState} from 'react';
import {descendants,type WorkspaceView} from '../../shared/model';
import {Dialog,ErrorNotice} from './Forms';
export function RemovePlan({workspace:w,nodeId,onClose,onSave}:{workspace:WorkspaceView;nodeId:string;onClose:()=>void;onSave:(version:number,confirmFixed:boolean)=>Promise<unknown>}) {
 const [version]=useState(w.version),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
 const nodes=descendants(w.data,nodeId),fixed=nodes.some(node=>node.fixed);
 return <Dialog title="移出行程" busy={busy} onClose={onClose}><div className="route-adoption-body">
 <p>将移出「{w.data.nodes[nodeId].title}」{nodes.length>1?`及其 ${nodes.length-1} 个子计划`:''}，地图路线会随之更新。</p>
 <p>介绍、备注、图片和地点保存在旅行笔记中。共用清单保留；没有其他关联的清单转为旅行清单，个人进度不变。操作可撤销。</p>
 {fixed && <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认移出其中的固定安排（不会取消外部预订）</label>}
 {version!==w.version && <p role="alert">计划已有更新，请关闭后重新检查。</p>}
 <ErrorNotice error={error}/><div className="button-row"><button disabled={busy || (fixed&&!confirmed) || version!==w.version} onClick={async()=>{setBusy(true);try{await onSave(version,confirmed);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>移出并保留资料</button><button disabled={busy} onClick={onClose}>取消</button></div>
 </div></Dialog>;
}

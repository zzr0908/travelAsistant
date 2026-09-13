import {randomUUID} from 'node:crypto';
import {descendants,dateLabel,trail,type WorkspaceData} from '../../shared/model.js';
import {ensure} from './validation.js';

/** Remove itinerary nodes, preserving their material as independent notes. Undo uses the workspace snapshot. */
export function removePlan(data:WorkspaceData,nodeId:string,confirmFixed=false) {
  ensure(data.nodes[nodeId] && nodeId!==data.rootId,'只能移出旅行中的子计划');
  const removed=descendants(data,nodeId),ids=new Set(removed.map(node=>node.id));
  ensure(confirmFixed || !removed.some(node=>node.fixed),'包含固定安排，请确认移出影响');
  data.notebook ||= {};
  const now=new Date().toISOString();
  for(const node of removed) {
    const id=randomUUID();
    data.notebook[id]={id,title:`${node.title} · 已移出行程`.slice(0,160),body:[`原位置：${trail(data,node.id).map(n=>n.title).join(' / ')}`,`原时间：${dateLabel(node.dates)}`,node.location.name && `地点：${node.location.name}`,node.location.address,node.preference && `偏好：${node.preference}`,node.description,node.notes].filter(Boolean).join('\n\n'),nodeIds:[],mediaIds:[...(data.media?.[node.id] || [])],spatialIds:[...new Set((data.spatial?.[node.id] || []).map(ref=>ref.assetId))],preparationIds:[],createdAt:now,updatedAt:now};
  }
  for(const note of Object.values(data.notebook)) {
    note.nodeIds=note.nodeIds.filter(id=>!ids.has(id));
    if(note.origin && note.origin.kind!=='preparation' && ids.has(note.origin.sourceId)) delete note.origin;
  }
  for(const card of Object.values(data.cards||{}))card.bindings=card.bindings.filter(b=>!ids.has(b.nodeId));
  for(const preparation of Object.values(data.preparations)) {
    const remains=preparation.nodeIds.filter(id=>!ids.has(id));
    if(remains.length===preparation.nodeIds.length)continue;
    preparation.nodeIds=remains.length?remains:[data.rootId];
  }
  for(const id of ids) {
    delete data.nodes[id];
    if(data.media)delete data.media[id];
    if(data.spatial)delete data.spatial[id];
  }
}

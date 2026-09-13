import { children, descendants, type NodeFields, type WorkspaceData, type Preparation } from '../../shared/model.js';
import { ensure } from './validation.js';
import { itineraryGroups } from '../../shared/itinerary.js';

export function reorderNodes(data: WorkspaceData, parentId: string, nodeIds: string[]) {
  ensure(data.nodes[parentId], '找不到上级计划');
  const siblings = children(data,parentId);
  ensure(nodeIds.length===siblings.length && new Set(nodeIds).size===nodeIds.length && nodeIds.every(id=>data.nodes[id]?.parentId===parentId), '排序必须完整包含当前层的子计划，不能重复或跨层');
  nodeIds.forEach((id,index)=>{data.nodes[id].order=index;});
  const chronological = itineraryGroups(data,parentId).flatMap(group=>group.nodes.map(n=>n.id));
  ensure(JSON.stringify(chronological)===JSON.stringify(nodeIds), '此顺序与日期或确定时间冲突，请先修改时间；原安排未改变');
}

export function addNode(data: WorkspaceData, id: string, parentId: string, fields: NodeFields) {
  ensure(data.nodes[parentId], '找不到上级计划');
  ensure(!data.nodes[id], '计划标识重复');
  data.nodes[id] = { ...fields, id, parentId, order: Math.max(-1, ...children(data, parentId).map(n => n.order)) + 1 };
}
export function editNode(data: WorkspaceData, id: string, fields: NodeFields, confirmFixed = false) {
  const old = data.nodes[id];
  ensure(old, '找不到计划');
  if (old.fixed && (JSON.stringify(old.dates) !== JSON.stringify(fields.dates) || !fields.fixed))
    ensure(confirmFixed, '此项为固定安排，请确认修改影响后保存');
  const locationChanged = old.location.name !== fields.location.name || old.location.address !== fields.location.address || old.location.lat !== fields.location.lat || old.location.lng !== fields.location.lng;
  if (locationChanged && data.spatial?.[id]) {
    // Manual correction keeps its own coordinates; it must not silently retain
    // a provider identity that belongs to the previous location.
    data.spatial[id] = data.spatial[id].filter(b => !b.primary);
  }
  data.nodes[id] = { ...old, ...fields };
  for (const note of Object.values(data.notebook || {})) {
    if (note.origin?.sourceId === id && (note.origin.kind === 'description' || note.origin.kind === 'notes') && note.body !== fields[note.origin.kind]) {
      note.body = fields[note.origin.kind];
      note.updatedAt = new Date().toISOString();
    }
  }
}
export function moveNode(data: WorkspaceData, id: string, parentId: string) {
  ensure(data.nodes[id] && data.nodes[parentId], '找不到移动目标');
  ensure(id !== data.rootId, '根计划通过“加入旅行”调整归属');
  ensure(!descendants(data, id).some(n => n.id === parentId), '计划不能放进自身或后代');
  data.nodes[id].parentId = parentId;
  data.nodes[id].order = Math.max(-1, ...children(data, parentId).map(n => n.order)) + 1;
}
export function putPreparation(data: WorkspaceData, preparation: Preparation) {
  data.preparations[preparation.id] = { ...preparation, nodeIds: [...new Set(preparation.nodeIds)] };
  const allSteps = new Set(Object.values(data.preparations).flatMap(p => p.steps.map(s => s.id)));
  for (const steps of Object.values(data.progress))
    for (const sid of Object.keys(steps)) if (!allSteps.has(sid)) delete steps[sid];
}

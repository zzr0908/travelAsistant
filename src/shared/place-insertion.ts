import {type WorkspaceData} from './model.js';
import {itineraryGroups} from './itinerary.js';

/** Position an already-created, undated place without changing anyone's dates. */
export function positionPlace(data: WorkspaceData, parentId: string, nodeId: string, beforeNodeId?: string) {
  const siblings = itineraryGroups(data,parentId).flatMap(group=>group.nodes).filter(node=>node.id!==nodeId);
  const index = beforeNodeId === undefined ? siblings.length : siblings.findIndex(node=>node.id===beforeNodeId);
  if (index < 0) throw new Error('插入位置已不存在，请重新选择');
  if (beforeNodeId && siblings[index].dates.mode==='fixed') throw new Error('新地点时间待定，请选择待安排的位置；确定日期的安排保持原顺序');
  siblings.splice(index,0,data.nodes[nodeId]);
  siblings.forEach((node,order)=>{node.order=order;});
}

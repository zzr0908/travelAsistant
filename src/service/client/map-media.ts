import type { AgentRunView } from '../../shared/agent';
import { spatialObjectLabel, type SpatialPresentation } from '../../shared/maps';
import type { WorkspaceData } from '../../shared/model';

export interface MediaMapTarget { assetId: string; id: string; label: string; mediaIds: string[]; tab?: string; itemId: string }
export const mapItemId = (ref: SpatialPresentation, index: number) => `${ref.nodeId || index}:${ref.assetId}`;
export function agentMapRefs(run: AgentRunView, tab: string): SpatialPresentation[] {
  if (tab === 'before') return run.proposal?.spatialBefore || [];
  if (tab === 'after') return run.proposal?.spatialAfter || [];
  return (run.output?.spatial || []).filter(r => tab.startsWith('candidate:') ? r.candidateId === tab.slice(10) : !r.candidateId);
}
export function agentMediaTargets(run: AgentRunView, candidateId?: string): MediaMapTarget[] {
  const tab = candidateId ? `candidate:${candidateId}` : 'answer';
  return agentMapRefs(run, tab).map((ref, index) => {
    const itemId = mapItemId(ref, index), asset = run.spatial?.find(a => a.id === ref.assetId);
    return { assetId:ref.assetId, id: `${tab}/${itemId}`, tab, itemId, label: asset ? spatialObjectLabel(asset, ref.title || asset.name) : ref.title || `地点 ${index + 1}`, mediaIds: ref.mediaIds };
  });
}
export function workspaceMediaTargets(data: WorkspaceData, nodeId: string): MediaMapTarget[] {
  return (data.spatial?.[nodeId] || []).map((ref, index) => ({ assetId:ref.assetId, id: `${nodeId}:${ref.assetId}`, itemId: `${nodeId}:${ref.assetId}`, label: ref.primary ? data.nodes[nodeId].location.name || data.nodes[nodeId].title : `地图内容 ${index + 1}`, mediaIds: ref.mediaIds }));
}

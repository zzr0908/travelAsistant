import { trail, type WorkspaceData } from './model.js';
import type { Coordinate } from './maps.js';

export interface WalkingStop { nodeId: string; assetId: string; coordinates: Coordinate }
export interface WalkingGroup { key: string; label: string; stops: WalkingStop[] }
export function walkingGroups(data: WorkspaceData, stops: WalkingStop[]): WalkingGroup[] {
  const result: WalkingGroup[] = [];
  const leafStops = stops.filter(stop => !stops.some(other => other.nodeId !== stop.nodeId && trail(data,other.nodeId).some(n => n.id === stop.nodeId)));
  let previous: WalkingStop | undefined;
  for (const stop of leafStops) {
    const node = data.nodes[stop.nodeId];
    if (!node) continue;
    const scope = trail(data,node.id).reverse().find(n => n.dates.mode !== 'unset');
    const dates = scope?.dates;
    const day = dates?.mode === 'fixed' && dates.start === dates.end ? dates.start : '';
    const groupKey = day ? `${day}:${dates!.timezone}` : `pending:${node.parentId}`;
    const label = day || '按已排顺序';
    const distant = previous && Math.hypot((previous.coordinates[0]-stop.coordinates[0])*Math.cos(stop.coordinates[1]*Math.PI/180),previous.coordinates[1]-stop.coordinates[1])*111.195 > 20;
    // Multi-day and flexible-date plans are overview objects, not a walking leg.
    const overview = node.dates.mode === 'window' || node.dates.mode === 'duration' || (node.dates.mode === 'fixed' && node.dates.start !== node.dates.end);
    const last = result.at(-1);
    if (!last || last.key !== groupKey || distant || overview) result.push({key:overview ? `overview:${node.id}` : groupKey,label:overview ? '日期范围 · 查看地点分布' : distant ? `${label} · 另起路段` : label,stops:[stop]});
    else last.stops.push(stop);
    previous = stop;
  }
  return result;
}

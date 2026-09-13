import {civilTime,uniqueInstant} from './zoned-time.js';
import { children, type PlanNode, type WorkspaceData } from './model.js';

export interface ItineraryGroup {
  key: string;
  label: string;
  nodes: PlanNode[];
}

/** Presentation order only: never rewrite the user's tree or infer dates. */
export function itineraryGroups(data: WorkspaceData, parentId: string): ItineraryGroup[] {
  const ordered = children(data, parentId);
  const timedZones=new Set(ordered.filter(node=>node.dates.mode==='fixed'&&node.dates.startTime).map(node=>node.dates.timezone));
  const crossZone=timedZones.size>1,displayZone=data.nodes[parentId]?.dates.timezone || 'UTC';
  const instants=new Map<string,number>(),uncertain:PlanNode[]=[];
  const dated = new Map<string, PlanNode[]>();
  const pending: PlanNode[] = [];
  for (const node of ordered) {
    if (node.dates.mode !== 'fixed' || !node.dates.start) {
      pending.push(node);
      continue;
    }
    let day = node.dates.start;
    if(node.dates.startTime) {
      const instant=uniqueInstant(day,node.dates.startTime,node.dates.timezone);
      if(instant===null){uncertain.push(node);continue;}
      instants.set(node.id,instant);
      if(crossZone)day=civilTime(instant,displayZone).slice(0,10);
    }
    dated.set(day, [...(dated.get(day) || []), node]);
  }
  const groups: ItineraryGroup[] = [];
  for (const day of [...dated.keys()].sort()) {
    const nodes = dated.get(day)!;
    const timed = nodes.filter(n => n.dates.startTime);
    timed.sort((a,b)=>instants.get(a.id)!-instants.get(b.id)!);
    if (timed.length) groups.push({ key: day, label: crossZone ? `${day} · 按 ${displayZone} 排序` : day, nodes: timed });
    const untimed = nodes.filter(n => !n.dates.startTime);
    if (untimed.length) groups.push({ key: `${day}:untimed`, label: `${day} · 时间待定`, nodes: untimed });
  }
  if(uncertain.length)groups.push({key:'uncertain-clock',label:'当地时刻待确认（夏令时切换或时区无效）',nodes:uncertain});
  if (pending.length) groups.push({ key: 'pending', label: dated.size ? '待安排' : '已排顺序 · 日期待定', nodes: pending });
  return groups;
}

/** Expand each branch in the same order used by its plan page. */
export function itineraryNodes(data: WorkspaceData, rootId: string): PlanNode[] {
  const result: PlanNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !data.nodes[id]) return;
    seen.add(id);
    result.push(data.nodes[id]);
    for (const group of itineraryGroups(data, id)) for (const node of group.nodes) visit(node.id);
  };
  visit(rootId);
  return result;
}

import { z } from "zod";
import type { SpatialBinding } from './maps.js';
import type { Note } from './notes.js';
import type { Card } from './cards.js';

export const dateSchema = z
  .object({
    mode: z.enum(["unset", "fixed", "window", "duration"]).default("unset"),
    start: z.string().max(10).default(""),
    end: z.string().max(10).default(""),
    minDays: z.number().int().min(1).max(366).nullable().default(null),
    maxDays: z.number().int().min(1).max(366).nullable().default(null),
    startTime: z.string().max(5).default(""),
    endTime: z.string().max(5).default(""),
    timezone: z.string().max(100).default("Europe/Rome"),
  })
  .strict();
export const nodeFields = z
  .object({
    title: z.string().trim().min(1, "请填写计划名称").max(160),
    description: z.string().max(4000).default(""),
    notes: z.string().max(20000).default(""),
    preference: z.string().max(2000).default(""),
    kind: z.enum(["plan", "activity", "free"]).default("plan"),
    dates: dateSchema.default(() => emptyDates()),
    fixed: z.boolean().default(false),
    location: z
      .object({
        name: z.string().max(250),
        address: z.string().max(600),
        lat: z.number().min(-90).max(90).nullable(),
        lng: z.number().min(-180).max(180).nullable(),
      })
      .strict()
      .default({ name: "", address: "", lat: null, lng: null }),
  })
  .strict();
export type Dates = z.infer<typeof dateSchema>;
export type NodeFields = z.infer<typeof nodeFields>;
export interface PlanNode extends NodeFields {
  id: string;
  parentId: string | null;
  order: number;
}
export interface Preparation {
  id: string;
  title: string;
  note: string;
  nodeIds: string[];
  steps: { id: string; text: string }[];
}
export interface WorkspaceData {
  rootId: string;
  kind: "trip" | "standalone";
  nodes: Record<string, PlanNode>;
  preparations: Record<string, Preparation>;
  progress: Record<string, Record<string, boolean>>;
  sample: boolean;
  media?: Record<string, string[]>;
  spatial?: Record<string, SpatialBinding[]>;
  notebook?: Record<string, Note>;
  cards?: Record<string, Card>;
}
export interface Workspace {
  id: string;
  ownerId: string;
  version: number;
  data: WorkspaceData;
  deleted: boolean;
}
export type Role = "owner" | "editor" | "reader";
export interface User {
  id: string;
  username: string;
  name: string;
  admin: boolean;
}
export interface WorkspaceSummary {
  id: string;
  title: string;
  kind: "trip" | "standalone";
  dates: Dates;
  role: Role;
  version: number;
  sample: boolean;
  count: number;
}
export interface HistoryEntry {
  id: string;
  label: string;
  actor: string;
  time: string;
  canUndo: boolean;
}
export interface WorkspaceView extends Workspace {
  role: Role;
  members: { id: string; name: string; role: Role }[];
  history: HistoryEntry[];
}
export interface Conflict {
  nodeId: string;
  message: string;
}
export function emptyDates(): Dates {
  return {
    mode: "unset",
    start: "",
    end: "",
    minDays: null,
    maxDays: null,
    startTime: "",
    endTime: "",
    timezone: "Europe/Rome",
  };
}
export function children(data: WorkspaceData, id: string) {
  return Object.values(data.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
export function descendants(data: WorkspaceData, id: string): PlanNode[] {
  const result: PlanNode[] = [];
  const visit = (nid: string) => {
    const node = data.nodes[nid];
    if (!node || result.some((n) => n.id === nid)) return;
    result.push(node);
    children(data, nid).forEach((n) => visit(n.id));
  };
  visit(id);
  return result;
}
export function trail(data: WorkspaceData, id: string) {
  const list: PlanNode[] = [];
  let node = data.nodes[id];
  while (node && !list.some((n) => n.id === node.id)) {
    list.unshift(node);
    node = data.nodes[node.parentId || ""];
  }
  return list;
}
export function dateLabel(d: Dates) {
  if (d.mode === "unset") return "日期未定";
  if (d.mode === "duration")
    return d.minDays === d.maxDays
      ? `${d.minDays} 天`
      : `${d.minDays}—${d.maxDays} 天`;
  const range = d.start === d.end ? d.start : `${d.start} — ${d.end}`;
  return `${d.mode === "window" ? "可选日期 · " : ""}${range}${d.startTime ? ` · ${d.startTime}${d.endTime ? "—" + d.endTime : ""}` : ""}`;
}
export function conflicts(data: WorkspaceData): Conflict[] {
  const found: Conflict[] = [];
  for (const n of Object.values(data.nodes)) {
    if (!["fixed", "window"].includes(n.dates.mode)) continue;
    const parents = trail(data, n.id).slice(0, -1);
    for (const p of parents)
      if (
        ["fixed", "window"].includes(p.dates.mode) &&
        (n.dates.start < p.dates.start || n.dates.end > p.dates.end)
      ) {
        found.push({
          nodeId: n.id,
          message: `“${n.title}”超出“${p.title}”的日期范围；原日期已保留。`,
        });
        break;
      }
  }
  const activities = Object.values(data.nodes).filter(
    (n) =>
      n.dates.mode === "fixed" &&
      n.dates.startTime &&
      n.dates.endTime &&
      n.dates.start === n.dates.end,
  );
  for (let i = 0; i < activities.length; i++)
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i],
        b = activities[j];
      if (
        a.dates.start === b.dates.start &&
        a.dates.timezone === b.dates.timezone &&
        a.dates.startTime < b.dates.endTime &&
        b.dates.startTime < a.dates.endTime &&
        !trail(data, a.id).some((n) => n.id === b.id) &&
        !trail(data, b.id).some((n) => n.id === a.id)
      )
        found.push({
          nodeId: a.id,
          message: `“${a.title}”与“${b.title}”时间重叠${a.fixed || b.fixed ? "，包含固定安排" : ""}。`,
        });
    }
  return found;
}

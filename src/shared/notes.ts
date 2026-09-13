import { z } from 'zod';
import { descendants, type WorkspaceData } from './model.js';

const ids = z.array(z.string().min(1).max(100)).max(500).refine(values => new Set(values).size === values.length, '关联不能重复');
export const noteFields = z.object({
  title: z.string().trim().min(1, '请填写笔记标题').max(160),
  body: z.string().max(100000).default(''),
  nodeIds: ids.default([]),
  preparationIds: ids.default([]),
  mediaIds: z.array(z.string().uuid()).max(30).default([]).refine(values => new Set(values).size === values.length, '图片不能重复'),
  spatialIds: z.array(z.string().uuid()).max(50).refine(values => new Set(values).size === values.length, '地点或路线不能重复').optional(),
}).strict();
export const noteSchema = noteFields.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  origin: z.object({ kind: z.enum(['description', 'notes', 'media', 'preparation']), sourceId: z.string().min(1).max(100) }).strict().optional(),
}).strict();
export type NoteFields = z.infer<typeof noteFields>;
export type Note = z.infer<typeof noteSchema>;

export function workspaceMediaIds(data: WorkspaceData): string[] {
  return [...new Set([...Object.values(data.media || {}).flat(), ...Object.values(data.notebook || {}).flatMap(note => note.mediaIds)])];
}

export function legacyNoteCount(data: WorkspaceData): number {
  const saved = new Set(Object.values(data.notebook || {}).flatMap(n => n.origin ? [`${n.origin.kind}:${n.origin.sourceId}`] : []));
  let count = 0;
  for (const n of Object.values(data.nodes)) {
    for (const kind of ['description', 'notes', 'media'] as const) {
      if ((kind === 'media' ? data.media?.[n.id]?.length : n[kind]) && !saved.has(`${kind}:${n.id}`)) count++;
    }
  }
  for (const p of Object.values(data.preparations)) if (!saved.has(`preparation:${p.id}`)) count++;
  return count;
}

export function notesForPlan(data: WorkspaceData, nodeId: string): Note[] {
  const scope = new Set(descendants(data, nodeId).map(n => n.id));
  const spatial = new Set([...scope].flatMap(id => (data.spatial?.[id] || []).map(binding=>binding.assetId)));
  return Object.values(data.notebook || {}).filter(note =>
    note.nodeIds.some(id => scope.has(id)) || note.spatialIds?.some(id=>spatial.has(id)) || (!note.nodeIds.length && nodeId === data.rootId),
  ).sort((a, b) => Number(b.nodeIds.includes(nodeId)) - Number(a.nodeIds.includes(nodeId)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Match explicit place or direct plan references only; nearby geography is not a content association. */
export function notesForPlace(data:WorkspaceData,assetIds:string[],nodeIds:string[]=[]):Note[] {
 const places=new Set(assetIds),nodes=new Set(nodeIds);
 return Object.values(data.notebook||{}).filter(note=>note.spatialIds?.some(id=>places.has(id))||note.nodeIds.some(id=>nodes.has(id)))
  .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}

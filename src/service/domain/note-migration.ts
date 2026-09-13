import { createHash } from 'node:crypto';
import type { WorkspaceData } from '../../shared/model.js';
import type { Note } from '../../shared/notes.js';

/** A user-visible transaction converts legacy material without rewriting its text. */
export function migrateNotes(data: WorkspaceData, workspaceId: string) {
  data.notebook ||= {};
  const now = new Date().toISOString();
  let count = 0;
  const add = (kind: NonNullable<Note['origin']>['kind'], sourceId: string, title: string, body: string, nodeIds: string[], mediaIds: string[] = [], preparationIds: string[] = []) => {
    if (Object.values(data.notebook!).some(n => n.origin?.kind === kind && n.origin.sourceId === sourceId)) return;
    const hash = createHash('sha256').update(`${workspaceId}:${kind}:${sourceId}`).digest('hex');
    const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    data.notebook![id] = {id, title:title.slice(0,160), body, nodeIds, mediaIds:[...mediaIds], preparationIds, createdAt:now, updatedAt:now, origin:{kind,sourceId}};
    count++;
  };
  for (const node of Object.values(data.nodes)) {
    if (node.description) add('description', node.id, `${node.title} · 介绍`, node.description, [node.id]);
    if (node.notes) add('notes', node.id, `${node.title} · 备注`, node.notes, [node.id]);
    if (data.media?.[node.id]?.length) add('media', node.id, `${node.title} · 图片`, '', [node.id], data.media[node.id]);
  }
  for (const prep of Object.values(data.preparations)) add('preparation', prep.id, prep.title, '', [...prep.nodeIds], [], [prep.id]);
  return count;
}

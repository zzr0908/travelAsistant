import {workspaceMediaIds} from '../shared/notes.js';
import type { DB } from './database.js';
import type { Workspace } from '../shared/model.js';
import { ensure } from '../service/domain/validation.js';
import { MapStore, mapCanonical } from '../maps/store.js';

interface VersionState { workspace: Workspace; from: number; until: number }
interface ChangeRow { id: string; user_id: string; request_body: string; before_data: string; after_versions: string; created: string }
export interface PublishedReferences { spatial: Set<string>; media: Set<string> }
export const emptyPublication = (): PublishedReferences => ({ spatial: new Set(), media: new Set() });

/** Reconstruct saved versions without using today's membership to judge old reads. */
export function publicationHistory(db: DB, inspect: (workspace: Workspace) => void) {
  const maps = new MapStore(db), states = new Map<string, Map<number, VersionState>>();
  const owners = new Map((db.prepare('SELECT id,owner_id FROM workspaces').all() as {id:string;owner_id:string}[]).map(w => [w.id,w.owner_id]));
  const references = (w: Workspace | null): PublishedReferences => w ? {
    spatial: maps.ids(w.data), media: new Set(workspaceMediaIds(w.data)),
  } : emptyPublication();
  const add = (w: Workspace) => {
    ensure(owners.get(w.id) === w.ownerId && Number.isSafeInteger(w.version) && w.version >= 0, '历史计划标识、版本或归属无效');
    inspect(w);
    let versions = states.get(w.id); if (!versions) states.set(w.id,versions = new Map());
    const old = versions.get(w.version);
    ensure(!old || mapCanonical(old.workspace) === mapCanonical(w), '同一计划版本的历史快照不一致');
    if (!old) versions.set(w.version,{workspace:w,from:-Infinity,until:Infinity});
    return versions.get(w.version)!;
  };
  for (const row of db.prepare('SELECT * FROM workspaces').all() as {id:string;owner_id:string;version:number;data:string;deleted:number}[]) {
    add({id:row.id,ownerId:row.owner_id,version:row.version,data:JSON.parse(row.data),deleted:!!row.deleted});
  }
  const changes = db.prepare('SELECT id,user_id,request_body,before_data,after_versions,created FROM changes ORDER BY rowid').all() as ChangeRow[];
  const beforeByChange = new Map<string,Record<string,Workspace|null>>();
  for (const change of changes) {
    const before = JSON.parse(change.before_data) as Record<string,Workspace|null>;
    beforeByChange.set(change.id,before);
    for (const [id,w] of Object.entries(before)) if (w) {
      ensure(id === w.id, '历史快照的计划引用不一致'); add(w);
    }
  }
  const assertOwnedOrPublished = (refs: PublishedReferences, actor: string, published: PublishedReferences, message: string) => {
    for (const id of refs.spatial) ensure(maps.row(id).owner_id === actor || published.spatial.has(id),message);
    for (const id of refs.media) {
      const image = db.prepare('SELECT owner_id FROM media_assets WHERE id=?').get(id) as {owner_id:string}|undefined;
      ensure(image && (image.owner_id === actor || published.media.has(id)),message);
    }
  };
  const merge = (target: PublishedReferences, value: PublishedReferences) => {
    for (const id of value.spatial) target.spatial.add(id);
    for (const id of value.media) target.media.add(id);
  };
  const generated = new Set<string>();
  for (const change of changes) {
    const before = beforeByChange.get(change.id)!, versions = JSON.parse(change.after_versions) as Record<string,number>;
    ensure(mapCanonical(Object.keys(before).sort()) === mapCanonical(Object.keys(versions).sort()), '历史变更范围与版本不一致');
    const when = Date.parse(change.created); ensure(Number.isFinite(when),'历史变更时间无效');
    const published = emptyPublication(); Object.values(before).forEach(w => merge(published,references(w)));
    const command = JSON.parse(change.request_body);
    if (command.kind === 'undo') {
      const original = changes.find(c => c.id === command.payload?.changeId);
      ensure(original && original.user_id === change.user_id, '撤销的历史归属无效');
      Object.values(beforeByChange.get(original.id)!).forEach(w => merge(published,references(w)));
    }
    for (const [id,version] of Object.entries(versions)) {
      const next = states.get(id)?.get(version), old = before[id];
      ensure(next && version === (old?.version || 0)+1 && !generated.has(`${id}:${version}`), '历史变更的后续快照或版本缺失');
      generated.add(`${id}:${version}`); next.from = when;
      if (old) states.get(id)!.get(old.version)!.until = when;
      assertOwnedOrPublished(references(next.workspace),change.user_id,published,'计划或历史包含没有发布依据的私人地图／配图');
      if (command.kind === 'agent_apply') {
        const proposal = db.prepare('SELECT body,change_id FROM agent_proposals WHERE id=?').get(command.proposalId) as {body:string;change_id:string}|undefined;
        ensure(proposal?.change_id === change.id,'采用记录与提议关联不一致');
        const body = JSON.parse(proposal.body);
        ensure(body.workspace.id === id && mapCanonical(body.workspace.data) === mapCanonical(next.workspace.data) && mapCanonical(body.before) === mapCanonical(old),'采用后的地图／内容与保存提议不一致');
      }
    }
  }
  for (const versions of states.values()) for (const state of versions.values()) {
    if (!generated.has(`${state.workspace.id}:${state.workspace.version}`)) assertOwnedOrPublished(references(state.workspace),state.workspace.ownerId,emptyPublication(),'初始计划缺少私人地图／配图的发布依据');
  }
  const exact = (w: Workspace) => {
    const saved = states.get(w.id)?.get(w.version);
    ensure(saved && mapCanonical(saved.workspace) === mapCanonical(w),'研究或提议快照不属于保存的计划历史版本');
    return references(w);
  };
  const at = (id: string | null | undefined, time: string) => {
    const result = emptyPublication(); if (!id) return result;
    const when = Date.parse(time); ensure(Number.isFinite(when),'地图研究时间无效');
    // Millisecond timestamps can tie; either adjacent saved state is valid at
    // that boundary. This checks consistency, not a signed tamper-proof ledger.
    for (const state of states.get(id)?.values() || []) if (!state.workspace.deleted && state.from <= when && when <= state.until) merge(result,references(state.workspace));
    return result;
  };
  return {references,assertOwnedOrPublished,exact,at};
}

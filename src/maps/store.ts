import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/database.js';
import { digest } from '../shared/hash.js';
import { AppError, ensure } from '../service/domain/validation.js';
import { spatialAssetSchema, spatialBindingSchema, spatialDependency, mapQueryResultSchema, type SpatialAsset, type SpatialBinding, type SpatialEvidence } from '../shared/maps.js';
import type { WorkspaceData } from '../shared/model.js';

export function mapCanonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
interface AssetRow { id: string; owner_id: string; query_id: string; body: string; sha256: string; identity: string }
export class MapStore {
  constructor(public db: DB) {}
  row(id: string): AssetRow {
    const row = this.db.prepare('SELECT * FROM spatial_assets WHERE id=?').get(id) as AssetRow | undefined;
    ensure(row, '找不到保存的地点或几何', 404);
    ensure(digest(row.body) === row.sha256, '空间资产完整性校验失败');
    return row;
  }
  get(id: string): SpatialAsset { return spatialAssetSchema.parse(JSON.parse(this.row(id).body)); }
  readMany(ids: string[], owner: string, workspaceId?: string, options: { skipUnavailable?: boolean } = {}) {
    let published = new Set<string>();
    if (workspaceId) {
      const w = this.db.prepare('SELECT w.data FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=? AND w.deleted=0').get(workspaceId, owner) as { data: string } | undefined;
      if (!w && options.skipUnavailable) return [];
      ensure(w, '没有这份计划的地图访问权限', 403);
      published = this.ids(JSON.parse(w.data));
    }
    const result: SpatialAsset[] = [];
    for (const id of new Set(ids)) try {
      // Publication is computed once for this read, never cached across requests.
      // Unpublished assets still require ownership and original-scope access.
      result.push(published.has(id) ? this.get(id) : this.allowed(id, owner));
    } catch (error) {
      if (!options.skipUnavailable || !(error instanceof AppError) || ![403,404].includes(error.status)) throw error;
    }
    return result;
  }
  ids(data: WorkspaceData): Set<string> {
    const ids = new Set([...Object.values(data.spatial || {}).flat().map(b => b.assetId), ...Object.values(data.notebook || {}).flatMap(note=>note.spatialIds || [])]);
    for (const id of ids) for (const stop of this.get(id).route?.placeIds || []) ids.add(stop);
    return ids;
  }
  allowed(id: string, owner: string, workspaceId?: string) {
    const row = this.row(id);
    if (workspaceId) {
      const w = this.db.prepare('SELECT w.data FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=? AND w.deleted=0').get(workspaceId, owner) as { data: string } | undefined;
      ensure(w, '没有这份计划的地图访问权限', 403);
      if (this.ids(JSON.parse(w.data)).has(id)) return this.get(id);
    }
    ensure(row.owner_id === owner, '不能读取他人的私人地图内容', 403);
    const q = this.db.prepare('SELECT workspace_id FROM map_queries WHERE id=?').get(row.query_id) as { workspace_id: string | null };
    if (q.workspace_id) ensure(this.db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(q.workspace_id, owner), '该地图所属计划的访问权限已失效', 403);
    return this.get(id);
  }
  put(owner: string, queryId: string, data: Omit<SpatialAsset, 'id'>) {
    const q = this.db.prepare('SELECT owner_id FROM map_queries WHERE id=?').get(queryId) as { owner_id: string } | undefined;
    ensure(q?.owner_id === owner, '地图查询归属无效', 403);
    const parsed = spatialAssetSchema.parse({ ...data, id: randomUUID() });
    ensure(parsed.source.queryId === queryId, '空间资产与来源查询不一致');
    const identity = digest(mapCanonical({ ...parsed, id: undefined, source: { ...parsed.source, retrievedAt: undefined, queryId: undefined } }));
    const existing = this.db.prepare('SELECT id FROM spatial_assets WHERE owner_id=? AND identity=?').get(owner, identity) as { id: string } | undefined;
    if (existing) {
      // Reuse only while the original scope is still readable. Revoked research
      // must not be made public by a new cache hit.
      try { return this.allowed(existing.id, owner); } catch { /* save a new scoped revision below */ }
    }
    const body = mapCanonical(parsed);
    this.db.prepare('INSERT INTO spatial_assets(id,owner_id,query_id,identity,body,sha256) VALUES(?,?,?,?,?,?)').run(parsed.id, owner, queryId, existing ? `${identity}:${queryId}` : identity, body, digest(body));
    return parsed;
  }
  bind(data: WorkspaceData, owner: string, workspaceId: string | undefined, nodeId: string, input: SpatialBinding[]) {
    const node = data.nodes[nodeId]; ensure(node, '空间关联节点不存在');
    const bindings = input.map(x => spatialBindingSchema.parse(x));
    ensure(bindings.length <= 50 && new Set(bindings.map(b => b.assetId)).size === bindings.length, '空间引用重复或过多');
    ensure(bindings.filter(b => b.primary).length <= 1, '只能设置一个主地点');
    const oldBindings = new Map((data.spatial?.[nodeId] || []).map(b => [b.assetId, b]));
    const oldPrimary = (data.spatial?.[nodeId] || []).find(b => b.primary);
    for (const b of bindings) {
      const a = this.allowed(b.assetId, owner, workspaceId);
      ensure(!b.primary || a.kind === 'place', '主地点必须是地点对象');
      ensure(b.nodeIds.every(id => data.nodes[id]), '路线引用了不存在的计划');
      if (a.route) for (const id of a.route.placeIds) this.allowed(id, owner, workspaceId);
      if (b.primary && a.geometry.type === 'Point') node.location = { name: a.name, address: a.address, lng: a.geometry.coordinates[0], lat: a.geometry.coordinates[1] };
      ensure(b.mediaIds.every(id => (data.media?.[nodeId] || []).includes(id)), '空间配图须先关联到同一计划节点');
      const old = oldBindings.get(b.assetId);
      if (a.route && old?.dependency && mapCanonical({...old, dependency: undefined}) === mapCanonical({...b, dependency: undefined})) b.dependency = old.dependency;
      else delete b.dependency;
    }
    if (oldPrimary && !bindings.some(b => b.primary)) node.location = { name: '', address: '', lat: null, lng: null };
    data.spatial ||= {}; data.spatial[nodeId] = bindings;
    for (const b of bindings) {
      const a = this.get(b.assetId);
      if (a.route && !b.dependency) {
        if (!b.nodeIds.length) b.nodeIds = a.route.placeIds.flatMap(id => Object.entries(data.spatial!).filter(([, refs]) => refs.some(x => x.primary && x.assetId === id)).map(([nid]) => nid));
        if (b.nodeIds.length) {
          ensure(b.nodeIds.length === a.route.placeIds.length, '请明确路线各停留点对应的计划，避免重复地点混淆');
          b.nodeIds.forEach((id, i) => {
            const stop = this.get(a.route!.placeIds[i]); const n = data.nodes[id];
            ensure(stop.geometry.type === 'Point' && n.location.lng === stop.geometry.coordinates[0] && n.location.lat === stop.geometry.coordinates[1], '路线与计划地点不一致，请重新生成');
          });
          b.dependency = spatialDependency(data, b.nodeIds);
        }
      }
    }
  }
  validate(data: WorkspaceData) {
    for (const id of this.ids(data)) this.get(id);
    for (const [id, bindings] of Object.entries(data.spatial || {})) for (const b of bindings) {
      const a = this.get(b.assetId);
      if (b.primary) ensure(a.geometry.type === 'Point' && data.nodes[id].location.lng === a.geometry.coordinates[0] && data.nodes[id].location.lat === a.geometry.coordinates[1] && data.nodes[id].location.name === a.name && data.nodes[id].location.address === a.address, '地点字段与空间引用不一致');
      if (a.route) for (const sid of a.route.placeIds) ensure(this.get(sid).kind === 'place', '路径停留点引用无效');
    }
  }
  evidence(e: SpatialEvidence, owner: string, workspaceId?: string) {
    this.allowed(e.assetId, owner, workspaceId);
    return this.verifyEvidence(e);
  }
  verifyEvidence(e: SpatialEvidence) {
    const a = this.get(e.assetId), row = this.db.prepare('SELECT result FROM map_queries WHERE id=?').get(e.queryId) as { result: string | null } | undefined;
    const result = row?.result ? mapQueryResultSchema.parse(JSON.parse(row.result)) : null;
    ensure(result && ['ok', 'ambiguous'].includes(result.status) && result.assets.some(asset => mapCanonical(asset) === mapCanonical(a)), '空间证据引用了不同或失败的查询');
    const value = e.field === 'distanceMeters' || e.field === 'movingSeconds' ? a.route?.[e.field] : a[e.field];
    ensure(value != null && value === e.value, '空间证据与保存的字段不一致');
    return a;
  }
}

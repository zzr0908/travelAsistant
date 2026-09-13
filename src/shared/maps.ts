import { z } from 'zod';
import type { WorkspaceData } from './model.js';

export const coordinateSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const line = z.array(coordinateSchema).min(2).max(20000);
const ring = z.array(coordinateSchema).min(4).max(5000);
const polygon = z.array(ring).min(1).max(100);
export const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: coordinateSchema }).strict(),
  z.object({ type: z.literal('LineString'), coordinates: line }).strict(),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(line).min(1).max(100) }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: polygon }).strict(),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(polygon).min(1).max(100) }).strict(),
]).superRefine((g, ctx) => {
  const points = geometryCoordinates(g);
  if (points.length > 50000) ctx.addIssue({ code: 'custom', message: '几何超过 50,000 个顶点，请使用有依据的简化版本' });
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const p of polygons) {
    if (p.some(r => !validRing(r)) || p.slice(1).some(r => r.some(v => !pointInRing(v, p[0])) || ringsIntersect(r, p[0])) || p.slice(1).some((r, i) => p.slice(i + 2).some(other => ringsIntersect(r, other) || pointInRing(r[0], other) || pointInRing(other[0], r)))) {
      ctx.addIssue({ code: 'custom', message: '区域轮廓未闭合、自相交或内环超出范围' }); break;
    }
  }
  if (polygons.some((p, i) => polygons.slice(i + 1).some(other => ringsIntersect(p[0], other[0], true) || (pointInRing(p[0][0], other[0]) && !other.slice(1).some(h => pointInRing(p[0][0], h))) || (pointInRing(other[0][0], p[0]) && !p.slice(1).some(h => pointInRing(other[0][0], h)))))) ctx.addIssue({ code: 'custom', message: '多个区域轮廓相互重叠' });
});
export type Coordinate = [number, number];
export type Geometry = z.infer<typeof geometrySchema>;

function pointInRing(p: Coordinate, r: Coordinate[]) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}
function ringsIntersect(a: Coordinate[], b: Coordinate[], proper = false) {
  const cross = (p: Coordinate, q: Coordinate, r: Coordinate) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const segments = b.slice(0, -1).map((p, i) => ({ p, q: b[i + 1], minX: Math.min(p[0], b[i + 1][0]), maxX: Math.max(p[0], b[i + 1][0]) })).sort((x, y) => x.minX - y.minX);
  for (let i = 0; i < a.length - 1; i++) {
    const p = a[i], q = a[i + 1], minX = Math.min(p[0], q[0]), maxX = Math.max(p[0], q[0]);
    for (const s of segments) {
      if (s.minX > maxX) break;
      if (s.maxX < minX || Math.min(p[1], q[1]) > Math.max(s.p[1], s.q[1]) || Math.max(p[1], q[1]) < Math.min(s.p[1], s.q[1])) continue;
      const x = cross(p, q, s.p) * cross(p, q, s.q), y = cross(s.p, s.q, p) * cross(s.p, s.q, q);
      if (proper ? x < 0 && y < 0 : x <= 0 && y <= 0) return true;
    }
  }
  return false;
}
function validRing(r: Coordinate[]) {
  if (r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1]) return false;
  let area = 0;
  const segments = r.slice(0, -1).map((a, i) => ({ a, b: r[i + 1], i, minX: Math.min(a[0], r[i + 1][0]), maxX: Math.max(a[0], r[i + 1][0]) }));
  for (const { a, b } of segments) { if (a[0] === b[0] && a[1] === b[1]) return false; area += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(area) < 1e-12) return false;
  const cross = (a: Coordinate, b: Coordinate, c: Coordinate) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  segments.sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length && segments[j].minX <= segments[i].maxX; j++) {
    const x = segments[i], y = segments[j];
    if (Math.abs(x.i - y.i) === 1 || Math.abs(x.i - y.i) === r.length - 2) continue;
    if (Math.max(x.a[1], x.b[1]) < Math.min(y.a[1], y.b[1]) || Math.max(y.a[1], y.b[1]) < Math.min(x.a[1], x.b[1])) continue;
    if (cross(x.a, x.b, y.a) * cross(x.a, x.b, y.b) <= 0 && cross(y.a, y.b, x.a) * cross(y.a, y.b, x.b) <= 0) return false;
  }
  return true;
}
export function geometryCoordinates(g: { type: string; coordinates: unknown }): Coordinate[] {
  const points: Coordinate[] = [];
  const walk = (v: unknown) => {
    if (!Array.isArray(v)) return;
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') points.push(v as Coordinate);
    else v.forEach(walk);
  };
  walk(g.coordinates); return points;
}
export function geometryBounds(geometries: Geometry[]): [number, number, number, number] | null {
  const points = geometries.flatMap(geometryCoordinates);
  if (!points.length) return null;
  const b: [number, number, number, number] = [180, 90, -180, -90];
  for (const [x, y] of points) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}
const safeSource = z.string().url().refine(value => !/[?&](apikey|key|token)=/i.test(value), '来源链接不能包含凭据');
export const spatialAssetSchema = z.object({
  id: z.string().uuid(), entityId: z.string().max(1000), kind: z.enum(['place', 'route', 'area']),
  name: z.string().min(1).max(250), address: z.string().max(600), category: z.string().max(200),
  match: z.object({ city: z.string().max(250), country: z.string().max(100), countryCode: z.string().max(2), aliases: z.array(z.string().max(250)).max(30), confidence: z.number().min(0).max(1).nullable() }).strict().optional(),
  geometry: geometrySchema, precision: z.enum(['place', 'street', 'city', 'region', 'manual', 'suggested']),
  source: z.object({ provider: z.enum(['geoapify', 'osm', 'manual', 'suggestion']), entityId: z.string().max(1000), url: safeSource,
    retrievedAt: z.string().datetime(), attribution: z.string().max(1000), license: z.string().max(500), queryId: z.string().uuid() }).strict(),
  route: z.object({ mode: z.enum(['walk', 'schematic']), placeIds: z.array(z.string().uuid()).min(2).max(12),
    distanceMeters: z.number().nonnegative().nullable(), movingSeconds: z.number().nonnegative().nullable() }).strict().optional(),
  areaNature: z.enum(['boundary', 'building', 'suggested']).optional(),
}).strict().superRefine((a, ctx) => {
  const valid = a.kind === 'place' ? a.geometry.type === 'Point' && !a.route && !a.areaNature : a.kind === 'route' ? ['LineString', 'MultiLineString'].includes(a.geometry.type) && !!a.route && !a.areaNature : ['Polygon', 'MultiPolygon'].includes(a.geometry.type) && !!a.areaNature && !a.route;
  if (!valid) ctx.addIssue({ code: 'custom', message: '空间对象类型与几何不一致' });
  if (a.route?.mode === 'schematic' && (a.route.distanceMeters !== null || a.route.movingSeconds !== null)) ctx.addIssue({ code: 'custom', message: '顺序示意不能提供真实距离或移动时间' });
});
export type SpatialAsset = z.infer<typeof spatialAssetSchema>;
export function spatialObjectLabel(asset: Pick<SpatialAsset, 'name' | 'kind' | 'areaNature' | 'route'>, title = asset.name): string {
  const type = asset.kind === 'area' ? asset.areaNature === 'building' ? '建筑轮廓' : asset.areaNature === 'suggested' ? '建议探索范围' : '真实区域边界'
    : asset.kind === 'route' ? asset.route?.mode === 'schematic' ? '顺序示意' : '步行路径' : '地点';
  return `${title} · ${type}`;
}
export type SpatialSummary = Omit<SpatialAsset, 'geometry'> & { geometryType: Geometry['type']; bounds: [number, number, number, number] | null };
export const spatialSummary = ({ geometry, ...asset }: SpatialAsset): SpatialSummary => ({ ...asset, geometryType: geometry.type, bounds: geometryBounds([geometry]) });
export const spatialBindingSchema = z.object({
  assetId: z.string().uuid(), primary: z.boolean().default(false), optional: z.boolean().default(false),
  nodeIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  mediaIds: z.array(z.string().uuid()).max(30).default([]),
  dependency: z.string().max(500000).optional(),
}).strict();
export type SpatialBinding = z.infer<typeof spatialBindingSchema>;
export const spatialSchema = z.record(z.string().min(1).max(100), z.array(spatialBindingSchema).max(50));
export const spatialReferenceSchema = z.object({ assetId: z.string().uuid(), candidateId: z.string().min(1).max(100).optional(), nodeId: z.string().min(1).max(100).optional(), optional: z.boolean().default(false), mediaIds: z.array(z.string().uuid()).max(30).default([]) }).strict();
export type SpatialReference = z.infer<typeof spatialReferenceSchema>;
export type SpatialPresentation = SpatialReference & { stale?: boolean; title?: string; label?: string; description?: string };
export const spatialEvidenceSchema = z.object({ assetId: z.string().uuid(), queryId: z.string().uuid(), field: z.enum(['name', 'category', 'address', 'distanceMeters', 'movingSeconds', 'areaNature']), value: z.union([z.string().max(1000), z.number()]) }).strict();
export type SpatialEvidence = z.infer<typeof spatialEvidenceSchema>;
export function spatialEvidenceText(asset: SpatialAsset, evidence: SpatialEvidence) {
  const descriptions = { name: '地图名称', category: '地图类别', address: '地图地址', areaNature: '区域性质', distanceMeters: '步行路径长度（米）', movingSeconds: '预计移动时间（秒，不含停留）' };
  const value = evidence.field === 'areaNature' ? ({ building: '建筑轮廓', boundary: '真实边界', suggested: '建议探索范围' } as Record<string,string>)[String(evidence.value)] || evidence.value : evidence.value;
  return `${asset.name}：${descriptions[evidence.field]}为 ${value}。`;
}
export function spatialDependency(data: WorkspaceData, ids: string[]) {
  const parents = [...new Set(ids.map(id => data.nodes[id]?.parentId).filter((id): id is string => !!id))].sort();
  return JSON.stringify({ siblings: parents.map(parentId => [parentId, Object.values(data.nodes).filter(n => n.parentId === parentId).map(n => n.id).sort()]), nodes: ids.map(id => {
    const n = data.nodes[id];
    return [id, n ? [n.parentId, n.order, n.location.lat, n.location.lng,
      n.dates.mode, n.dates.start, n.dates.end, n.dates.startTime, n.dates.endTime, n.dates.timezone,
      (data.spatial?.[id] || []).filter(b => b.primary).map(b => b.assetId).sort(),
    ] : null];
  }) });
}
export function bindingStale(data: WorkspaceData, binding: SpatialBinding) {
  return !!binding.dependency && binding.dependency !== spatialDependency(data, binding.nodeIds);
}
type PlanLocation = WorkspaceData['nodes'][string]['location'];
export function coordinateContextWarning(location: PlanLocation, references: PlanLocation[]): string {
  if (location.lat === null || location.lng === null || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return '';
  const distanceKm = (lat: number, lng: number, ref: PlanLocation) => {
    const rad=Math.PI/180, dLat=(lat-ref.lat!)*rad, dLng=(lng-ref.lng!)*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(lat*rad)*Math.cos(ref.lat!*rad)*Math.sin(dLng/2)**2;
    return 12742*Math.asin(Math.min(1,Math.sqrt(h)));
  };
  const known=references.filter(r=>r.lat !== null && r.lng !== null).map(r=>({r,d:distanceKm(location.lat!,location.lng!,r)})).sort((a,b)=>a.d-b.d)[0];
  // This is a broad mismatch hint, not a city boundary or a save restriction.
  if (!known || known.d <= 100) return '';
  if (Math.abs(location.lng) <= 90 && distanceKm(location.lng,location.lat,known.r) < 25) return '经纬度可能填反，请核对。应用会保留你的输入，不会自动交换。';
  return `这组坐标距「${known.r.name || '已知位置'}」约 ${Math.round(known.d)} 公里，请核对所在城市和经纬度。`;
}
export interface MapStatus { available: boolean; message: string; style: string; attribution: string; usedCredits: number; dailyBudget: number; requests: number }
export const mapQueryResultSchema = z.object({ queryId: z.string().uuid(), status: z.enum(['ok', 'no_match', 'ambiguous', 'failed', 'cancelled']), assets: z.array(spatialAssetSchema).max(20), message: z.string().max(1000), cached: z.boolean(), estimatedCredits: z.number().nonnegative().nullable() }).strict();
export type MapQueryResult = z.infer<typeof mapQueryResultSchema>;
export const mapInputSchema = z.object({
  action: z.enum(['search', 'nearby', 'details', 'route', 'area', 'suggested_area', 'schematic']),
  nearRouteId: z.string().uuid().optional(), routeCenterIndex: z.number().int().min(0).max(1999).optional(),
  radiusMeters: z.number().int().min(100).max(3000).optional(),
  searchType: z.enum(['place', 'street', 'city']).optional().describe('place 查景点/店铺，street 查街道/广场代表位置，city 仅查城市概览'), nearPlaceId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(250).optional().describe('仅地点本身名称，例如 Ponte Vecchio；城市放 context'), context: z.string().trim().min(1).max(200).optional().describe('已知城市必须填写，例如 Florence, Italy；避免按IP或全国同名结果猜测'),
  country: z.string().regex(/^[a-z]{2}$/).optional(), category: z.string().max(100).optional().describe('明确类别可用 museum/bridge/cafe/restaurant/park；square 或 street 改用街道代表位置搜索。bridge 等附近类别查询请同时给 nearPlaceId。未知类别省略，保留服务返回类别。'),
  placeId: z.string().uuid().optional(), placeIds: z.array(z.string().uuid()).min(2).max(12).optional(),
  name: z.string().min(1).max(250).optional(), requestId: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
}).strict();
export type MapInput = z.infer<typeof mapInputSchema>;

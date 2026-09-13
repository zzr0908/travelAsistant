import { routeSearchCenters } from '../shared/route-nearby.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../storage/database.js';
import { AppError, ensure } from '../service/domain/validation.js';
import { digest } from '../shared/hash.js';
import { MapStore, mapCanonical } from './store.js';
import { MapTransport, type MapTransportOptions } from './transport.js';
import { MAP_STYLE, MAP_ATTRIBUTION, mapResource } from './resources.js';
import { coordinateSchema, geometrySchema, mapInputSchema, mapQueryResultSchema, type Coordinate, type MapInput, type MapQueryResult, type SpatialAsset, type MapStatus } from '../shared/maps.js';

const properties = z.object({
  place_id: z.string().max(1000).optional(), name: z.string().optional(), formatted: z.string().optional(), address_line1: z.string().optional(),
  category: z.string().optional(), categories: z.array(z.string()).optional(), result_type: z.string().optional(),
  lat: z.number().optional(), lon: z.number().optional(), city: z.string().optional(), country: z.string().optional(), country_code: z.string().optional(),
  rank: z.object({ confidence: z.number().optional() }).passthrough().optional(),
  name_international: z.record(z.string(), z.unknown()).optional(),
  other_names: z.record(z.string(), z.unknown()).optional(),
  datasource: z.object({ attribution: z.string().optional(), license: z.string().optional(), raw: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
}).passthrough();
const featureCollection = z.object({ features: z.array(z.object({ properties, geometry: geometrySchema })).max(20) });
// Routing uses a separate response contract: e.g. country_code is an array
// of countries crossed, whereas geocoding returns one country string.
const routeFeatureCollection = z.object({ features: z.array(z.object({
  properties: z.object({
    distance: z.number().nonnegative().optional(), time: z.number().nonnegative().optional(), mode: z.string().optional(),
    distance_units: z.string().optional(), units: z.string().optional(),
  }).passthrough(), geometry: geometrySchema,
})).max(20) });
type Props = z.infer<typeof properties>;
type DraftAsset = Omit<SpatialAsset, 'id'>;
const short = (v: unknown, limit = 250) => typeof v === 'string' ? v.slice(0, limit) : '';
const cancelled = () => new DOMException('地图查询已取消', 'AbortError');
function distance(a: Coordinate, b: Coordinate) {
  const rad = Math.PI / 180, x = (b[0] - a[0]) * Math.cos((a[1] + b[1]) * rad / 2), y = b[1] - a[1];
  return Math.hypot(x, y) * 111195;
}
function source(queryId: string, p: Props, url: string, provider: SpatialAsset['source']['provider'] = 'geoapify') {
  return { provider, entityId: p.place_id || '', url, queryId, retrievedAt: new Date().toISOString(), attribution: short(p.datasource?.attribution || (provider === 'geoapify' ? 'Geoapify · © OpenStreetMap contributors' : '应用根据已知地点生成'), 1000), license: short(p.datasource?.license || (provider === 'geoapify' ? 'Open Database License' : '建议范围，不代表真实边界'), 500) };
}
function placeSource(p: Props) {
  const raw = p.datasource?.raw, type = raw?.osm_type, id = raw?.osm_id;
  if (['n', 'w', 'r', 'node', 'way', 'relation'].includes(String(type)) && /^\d+$/.test(String(id))) {
    const kind = ({ n: 'node', w: 'way', r: 'relation' } as Record<string, string>)[String(type)] || String(type);
    return `https://www.openstreetmap.org/${kind}/${id}`;
  }
  return 'https://apidocs.geoapify.com/docs/geocoding/';
}
function match(p: Props): SpatialAsset['match'] {
  const names = Object.entries({ ...p.datasource?.raw, ...p.other_names, ...p.name_international }).filter(([k]) => k.startsWith('name') || ['alt_name', 'official_name', 'short_name', 'loc_name'].includes(k) || /^[a-z]{2}(?:-[A-Z]{2})?$/.test(k)).flatMap(([, v]) => short(v).split(';')).map(v => v.trim()).filter(Boolean);
  return { city: short(p.city), country: short(p.country, 100), countryCode: short(p.country_code, 2), aliases: [...new Set(names)].slice(0, 30), confidence: p.rank?.confidence == null ? null : Math.max(0, Math.min(1, p.rank.confidence)) };
}
const categoryKeys: Record<string, string[]> = { bridge: ['man_made.bridge', 'tourism.sights.bridge'], museum: ['entertainment.museum'], cafe: ['catering.cafe'], restaurant: ['catering.restaurant'], park: ['leisure.park'] };
const categoriesOf = (p: Props) => [...new Set([...(p.categories || []), ...(p.category || '').split(/[;,]/)].map(v => v.trim()).filter(Boolean))];
function matchesCategory(p: Props, category?: string) {
  return !category || categoriesOf(p).some(c => (categoryKeys[category] || [category]).some(key => c === key || c.startsWith(key + '.')));
}
function samePlaceName(a: Props, b: Props) {
  const names = (p: Props) => [p.name || '', ...(match(p)?.aliases || [])].map(n => n.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const known = new Set(names(a)); return names(b).some(n => known.has(n));
}
export class MapService {
  readonly store: MapStore;
  readonly transport: MapTransport;
  private active = new Map<string, Promise<MapQueryResult>>();
  constructor(readonly db: DB, options: MapTransportOptions = {}) { this.store = new MapStore(db); this.transport = new MapTransport(db, options); }
  status(): MapStatus {
    const u = this.transport.usage();
    return { available: this.transport.available, message: this.transport.available ? '地图用于呈现计划与内容' : '地图暂未配置；已有图文计划仍可查看', style: MAP_STYLE, attribution: MAP_ATTRIBUTION, usedCredits: u.credits, dailyBudget: u.dailyBudget, requests: u.requests };
  }
  private scope(owner: string, workspaceId?: string) {
    ensure(this.db.prepare('SELECT 1 FROM users WHERE id=?').get(owner), '请先登录', 401);
    if (workspaceId) ensure(this.db.prepare('SELECT 1 FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=? AND w.deleted=0').get(workspaceId, owner), '没有这份计划的地图访问权限', 403);
  }
  resource(path: string, signal?: AbortSignal) { return mapResource(this.transport, path, signal); }
  async query(owner: string, raw: unknown, options: { signal?: AbortSignal; runId?: string } = {}): Promise<MapQueryResult> {
    const input = mapInputSchema.parse(raw);
    this.scope(owner, input.workspaceId);
    if (options.signal?.aborted) throw cancelled();
    if (input.action === 'search') ensure(input.text, '请填写地点名称');
    if (input.action === 'nearby') {
      ensure(!!input.nearPlaceId !== !!input.nearRouteId, '附近查询需要一个地点或步行路线');
      ensure(!input.nearRouteId || input.routeCenterIndex !== undefined, '请选择路线查询位置');
      ensure(['museum', 'cafe', 'park', 'restaurant', 'bridge'].includes(input.category || ''), '请选择支持的附近地点类别');
    }
    if (input.action === 'details' || input.action === 'area') ensure(input.placeId, '请先选择已匹配地点');
    if (['route', 'schematic', 'suggested_area'].includes(input.action)) ensure(input.placeIds?.length && input.placeIds.length >= 2, '请至少选择两个已匹配地点');
    // IDs must be checked before cache access, including completed idempotent requests.
    for (const id of [input.placeId, input.nearPlaceId, ...(input.placeIds || [])].filter(Boolean) as string[]) {
      const a = this.store.allowed(id, owner, input.workspaceId); ensure(a.kind === 'place', '需要引用地点对象');
    }
    if(input.nearRouteId) {
      const route=this.store.allowed(input.nearRouteId,owner,input.workspaceId);
      ensure(routeSearchCenters(route)[input.routeCenterIndex!] , '路线查询位置无效或不是实际步行路线');
    }
    const hash = digest(mapCanonical(input));
    const previous = this.db.prepare('SELECT id,request_hash,result FROM map_queries WHERE owner_id=? AND request_id=?').get(owner, input.requestId) as { id: string; request_hash: string; result: string | null } | undefined;
    if (previous) {
      ensure(previous.request_hash === hash, '同一地图请求标识不能用于不同查询', 409);
      if (previous.result) {
        const saved = mapQueryResultSchema.parse(JSON.parse(previous.result));
        for (const a of saved.assets) this.store.allowed(a.id, owner, input.workspaceId);
        return saved;
      }
      const running = this.active.get(previous.id);
      if (running) return running;
      const interrupted: MapQueryResult = { queryId: previous.id, status: 'failed', assets: [], message: '上次地图查询已中断，请重新查询', cached: false, estimatedCredits: null };
      this.finish(interrupted); return interrupted;
    }
    if (options.runId) {
      ensure(this.db.prepare("SELECT 1 FROM agent_runs WHERE id=? AND owner_id=? AND state IN ('queued','running') AND cancel_requested=0").get(options.runId, owner), '地图研究任务已结束或取消', 409);
      const n = this.db.prepare('SELECT count(*) AS n FROM agent_map_queries WHERE run_id=?').get(options.runId) as { n: number };
      ensure(n.n < 8, '本轮地图查询已达 8 次，请利用已有结果完成回答', 429, 'MAP_RUN_LIMIT');
    }
    const { requestId: _requestId, ...query } = input;
    const cacheKey = digest(mapCanonical({ adapterRevision: 6, ...query, text: input.text?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() }));
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO map_queries(id,owner_id,workspace_id,request_id,request_hash,cache_key,input,created) VALUES(?,?,?,?,?,?,?,?)').run(id, owner, input.workspaceId || null, input.requestId, hash, cacheKey, mapCanonical(input), new Date().toISOString());
      if (options.runId) this.db.prepare('INSERT INTO agent_map_queries(run_id,query_id) VALUES(?,?)').run(options.runId, id);
    })();
    // A fallback is still one user query: all stages share one deadline.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('地图查询超时', 'TimeoutError')), this.transport.timeoutMs);
    const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const task = this.execute(owner, input, id, cacheKey, signal).finally(() => { clearTimeout(timer); this.active.delete(id); });
    this.active.set(id, task); return task;
  }
  private finish(result: MapQueryResult) { this.db.prepare('UPDATE map_queries SET result=? WHERE id=?').run(mapCanonical(mapQueryResultSchema.parse(result)), result.queryId); }
  private async execute(owner: string, input: MapInput, id: string, cacheKey: string, signal?: AbortSignal): Promise<MapQueryResult> {
    let cost: number | null = 0, cached = false;
    try {
      const prior = this.db.prepare("SELECT result FROM map_queries WHERE owner_id=? AND cache_key=? AND id<>? AND result IS NOT NULL AND created>? AND json_extract(result,'$.status') IN ('ok','ambiguous','no_match') ORDER BY created DESC LIMIT 1").get(owner, cacheKey, id, new Date(Date.now() - 86400000).toISOString()) as { result: string } | undefined;
      if (prior) {
        const r = mapQueryResultSchema.parse(JSON.parse(prior.result));
        this.scope(owner, input.workspaceId);
        for (const a of r.assets) this.store.allowed(a.id, owner, input.workspaceId);
        if (signal?.aborted) throw cancelled();
        const result = { ...r, queryId: id, cached: true, estimatedCredits: 0, message: r.message + '（复用已保存结果）' };
        this.finish(result); return result;
      }
      const drafts: DraftAsset[] = [];
      if (input.action === 'nearby') {
        const center = this.store.allowed((input.nearRouteId || input.nearPlaceId)!, owner, input.workspaceId);
        const point = input.nearRouteId ? routeSearchCenters(center)[input.routeCenterIndex!] : center.geometry.type === 'Point' ? center.geometry.coordinates : undefined;
        ensure(point, '附近查询需要有效坐标');
        const radius = input.radiusMeters || 1000;
        const url = new URL('https://api.geoapify.com/v2/places');
        url.searchParams.set('categories', categoryKeys[input.category!].join(','));
        url.searchParams.set('filter', `circle:${point[0]},${point[1]},${radius}`);
        url.searchParams.set('bias', `proximity:${point[0]},${point[1]}`);
        url.searchParams.set('limit', '20');
        const response = await this.transport.json(url.toString(), 1, `query:${owner}:${cacheKey}`, signal);
        cached = response.cached; cost = response.estimatedCredits;
        const seen = new Set([center.entityId]);
        const features = featureCollection.parse(response.data).features.filter(f => f.geometry.type === 'Point' && distance(point, f.geometry.coordinates) <= radius && matchesCategory(f.properties, input.category) && (!input.country || f.properties.country_code === input.country));
        features.sort((a,b) => distance(point, a.geometry.type === 'Point' ? a.geometry.coordinates : point) - distance(point, b.geometry.type === 'Point' ? b.geometry.coordinates : point));
        for (const f of features) {
          const p = f.properties, identity = 'geoapify:' + p.place_id;
          if (!p.place_id || !p.name?.trim() || seen.has(identity) || drafts.length >= 5) continue;
          seen.add(identity);
          drafts.push({entityId:identity, kind:'place', name:short(p.name), address:short(p.formatted,600), category:short(categoriesOf(p).join(','),200), geometry:f.geometry, precision:'place', match:match(p), source:source(id,p,placeSource(p))});
        }
      } else if (input.action === 'search') {
        const url = new URL('https://api.geoapify.com/v1/geocode/search');
        const street = input.searchType === 'street' || ['square', 'street'].includes(input.category || '');
        const context = input.context?.split(',').map(s => s.trim()).filter(Boolean) || [];
        if (input.searchType !== 'city' && context.length) {
          url.searchParams.set(street ? 'street' : 'name', input.text!); url.searchParams.set('city', context[0]);
          if (context.length > 1) url.searchParams.set('country', context.at(-1)!);
        } else url.searchParams.set('text', [input.text, input.context].filter(Boolean).join(', '));
        url.searchParams.set('type', input.searchType === 'city' ? 'city' : street ? 'street' : 'amenity');
        url.searchParams.set('bias', 'countrycode:none');
        url.searchParams.set('limit', '5'); url.searchParams.set('lang', 'en');
        if (input.country) url.searchParams.set('filter', 'countrycode:' + input.country);
        const near = input.nearPlaceId ? this.store.allowed(input.nearPlaceId, owner, input.workspaceId) : undefined;
        const nearPoint = near?.geometry.type === 'Point' ? near.geometry.coordinates : undefined;
        const geocodeUrl = new URL(url);
        if (nearPoint) geocodeUrl.searchParams.set('filter', `circle:${nearPoint[0]},${nearPoint[1]},10000`);
        const nearbyCategory = !!(near && input.category && input.searchType !== 'city' && !street);
        if (nearbyCategory) {
          const near = this.store.allowed(input.nearPlaceId!, owner, input.workspaceId);
          ensure(near.geometry.type === 'Point', '附近搜索需要已知地点');
          const category = (categoryKeys[input.category!] || [input.category!]).join(',');
          url.pathname = '/v2/places'; url.search = '';
          url.searchParams.set('name', input.text!); url.searchParams.set('categories', category); url.searchParams.set('limit', '5');
          url.searchParams.set('filter', `circle:${near.geometry.coordinates[0]},${near.geometry.coordinates[1]},10000`);
        }
        let searchCost = 0, allCached = true;
        const readFeatures = async (target: URL) => {
          cost = null;
          const result = await this.transport.json(target.toString(), 1, `query:${owner}:${cacheKey}:${digest(target.toString())}`, signal);
          searchCost += result.estimatedCredits; cost = searchCost;
          allCached = allCached && result.cached; cached = allCached;
          return featureCollection.parse(result.data).features;
        };
        const inScope = (f: z.infer<typeof featureCollection>['features'][number]) => f.geometry.type === 'Point' && (!input.country || f.properties.country_code === input.country) && (!nearPoint || distance(nearPoint, f.geometry.coordinates) <= 10000);
        let features = (await readFeatures(url)).filter(inScope);
        if (nearbyCategory && !features.some(f => matchesCategory(f.properties, input.category))) {
          // Places name filtering misses some aliases and branches. Geocoding
          // keeps the same name/city and radius; it cannot relax the category.
          const fallback = (await readFeatures(geocodeUrl)).filter(inScope);
          features = fallback.filter(f => matchesCategory(f.properties, input.category));
          // A generic geocoder label is not category evidence. At most two
          // nearby category lookups may resolve it, with matching name/alias.
          const unresolved = fallback.filter(f => !matchesCategory(f.properties, input.category) && (!f.properties.category || ['amenity', 'tourism', 'tourism.attraction', 'man_made'].includes(f.properties.category))).slice(0, 2);
          for (const candidate of unresolved) {
            if (candidate.geometry.type !== 'Point') continue;
            const lookup = new URL('https://api.geoapify.com/v2/places');
            lookup.searchParams.set('categories', (categoryKeys[input.category!] || [input.category!]).join(','));
            lookup.searchParams.set('filter', `circle:${candidate.geometry.coordinates[0]},${candidate.geometry.coordinates[1]},100`);
            lookup.searchParams.set('limit', '5');
            for (const f of (await readFeatures(lookup)).filter(inScope)) {
              if (f.geometry.type === 'Point' && matchesCategory(f.properties, input.category) && samePlaceName(candidate.properties, f.properties) && distance(candidate.geometry.coordinates, f.geometry.coordinates) <= 100) features.push(f);
            }
          }
        }
        const seen = new Set<string>();
        for (const f of features) {
          const p = f.properties;
          const categories = categoriesOf(p).join(',');
          if (!p.place_id || seen.has(p.place_id) || f.geometry.type !== 'Point' || (!street && !matchesCategory(p, input.category))) continue;
          seen.add(p.place_id);
          const precision = street ? 'street' : ['city', 'town', 'village', 'suburb', 'district'].includes(p.result_type || '') ? 'city' : ['country', 'state', 'county'].includes(p.result_type || '') ? 'region' : 'place';
          drafts.push({ entityId: 'geoapify:' + p.place_id, kind: 'place', name: short(p.name || p.address_line1 || p.formatted || input.text), address: short(p.formatted, 600), category: short(categories || p.result_type, 200), geometry: f.geometry, precision, match: match(p), source: source(id, p, placeSource(p)) });
        }
      } else if (input.action === 'area' || input.action === 'details') {
        const place = this.store.allowed(input.placeId!, owner, input.workspaceId);
        ensure(place.source.provider === 'geoapify' && place.source.entityId, '此地点暂无可查询的供应商详情');
        const url = new URL('https://api.geoapify.com/v2/place-details');
        url.searchParams.set('id', place.source.entityId); url.searchParams.set('features', 'details');
        cost = null;
        const result = await this.transport.json(url.toString(), 1, `query:${owner}:${cacheKey}`, signal);
        cost = result.estimatedCredits; cached = result.cached;
        for (const f of featureCollection.parse(result.data).features) {
          const p = f.properties;
          // Details can return a different encoded place_id for the same entity.
          // Require the requested details feature, matching name and nearby centre;
          // never accept a neighbouring feature just because it is a polygon.
          const normalizedName = (v: string) => v.normalize('NFKC').trim().toLocaleLowerCase();
          const sameName = [place.name, ...(place.match?.aliases || [])].some(name => normalizedName(name) === normalizedName(p.name || ''));
          const sameDetails = p.feature_type === 'details' && sameName && p.lat != null && p.lon != null && place.geometry.type === 'Point' && distance(place.geometry.coordinates, [p.lon, p.lat]) <= 30 && (!place.match?.countryCode || p.country_code === place.match.countryCode);
          if (p.place_id !== place.source.entityId && !sameDetails) continue;
          if (['Polygon', 'MultiPolygon'].includes(f.geometry.type)) drafts.push({ entityId: place.entityId, kind: 'area', name: short(p.name || place.name), address: short(p.formatted || place.address, 600), category: short(p.categories?.join(',') || place.category, 200), geometry: f.geometry, precision: 'place', areaNature: p.categories?.includes('building') || p.datasource?.raw?.building ? 'building' : 'boundary', source: source(id, p, placeSource(p)) });
          else if (input.action === 'details' && f.geometry.type === 'Point') drafts.push({ ...place, source: source(id, p, placeSource(p)), match: match(p), geometry: f.geometry });
        }
      } else {
        const places = input.placeIds!.map(pid => this.store.allowed(pid, owner, input.workspaceId));
        const coords = places.map(p => { ensure(p.geometry.type === 'Point' && ['place','street'].includes(p.precision), '路径和探索范围需要具体地点；城市或区域中心不能冒充景点'); return coordinateSchema.parse(p.geometry.coordinates); });
        ensure(coords.some(c => distance(c, coords[0]) > 1), '所选地点位置相同，无法形成路径或范围');
        if (input.action === 'schematic') drafts.push({ entityId: `schematic:${digest(mapCanonical(input.placeIds))}`, kind: 'route', name: input.name || '地点顺序示意', address: '', category: 'schematic', precision: 'suggested', geometry: { type: 'LineString', coordinates: coords }, route: { mode: 'schematic', placeIds: input.placeIds!, distanceMeters: null, movingSeconds: null }, source: source(id, {}, 'https://www.geoapify.com/', 'suggestion') });
        else if (input.action === 'suggested_area') {
          // Convex hull of small buffers around the selected verified points.
          // It is explicitly an application suggestion, never a provider boundary.
          const cloud = coords.flatMap(([x, y]) => Array.from({ length: 12 }, (_, n) => { const a = n * Math.PI / 6; return [x + Math.cos(a) * .0012 / Math.max(.2, Math.cos(y * Math.PI / 180)), y + Math.sin(a) * .0012] as Coordinate; })).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          const cross = (a: Coordinate, b: Coordinate, c: Coordinate) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const half = (points: Coordinate[]) => { const h: Coordinate[] = []; for (const p of points) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } return h.slice(0, -1); };
          const hull = [...half(cloud), ...half([...cloud].reverse())]; hull.push(hull[0]);
          drafts.push({ entityId: `suggested:${digest(mapCanonical(input.placeIds))}`, kind: 'area', name: input.name || '建议探索范围', address: '', category: 'suggested', precision: 'suggested', areaNature: 'suggested', geometry: geometrySchema.parse({ type: 'Polygon', coordinates: [hull] }), source: source(id, {}, 'https://www.geoapify.com/', 'suggestion') });
        } else {
          const url = new URL('https://api.geoapify.com/v1/routing');
          url.searchParams.set('waypoints', coords.map(([x, y]) => `${y},${x}`).join('|')); url.searchParams.set('mode', 'walk'); url.searchParams.set('details', 'route_details');
          url.searchParams.set('units', 'metric'); url.searchParams.set('intermediate_waypoint_mode', 'stopover');
          cost = null;
          const result = await this.transport.json(url.toString(), coords.length - 1, `query:${owner}:${cacheKey}`, signal);
          cost = result.estimatedCredits; cached = result.cached;
          const f = routeFeatureCollection.parse(result.data).features[0];
          if (f) {
            ensure(['LineString', 'MultiLineString'].includes(f.geometry.type) && f.properties.mode === 'walk', '供应商未返回步行路径', 502);
            ensure(f.properties.distance != null && f.properties.time != null && f.properties.distance <= 500000, '步行路径缺少可靠摘要或范围过大', 502);
            ensure(f.properties.distance_units?.toLowerCase() === 'meters' && (!f.properties.units || f.properties.units === 'metric'), '步行路径的距离单位不明确或不是米，未保存估计', 502);
            // Geoapify stopover geometry has exactly one line per waypoint pair.
            // Validate each leg in order; finding all stops somewhere in a flat
            // vertex set would also accept reordered or disconnected routes.
            const legs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : f.geometry.type === 'LineString' ? [f.geometry.coordinates] : [];
            ensure(legs.length === coords.length - 1, '路径分段与停留点数量不符，未保存路线', 502);
            let measured = 0;
            for (let n = 0; n < legs.length; n++) {
              const leg = legs[n];
              ensure(distance(leg[0], coords[n]) <= 250 && distance(leg.at(-1)!, coords[n + 1]) <= 250, '路径停留点顺序或位置不符，请核对入口或地点', 502);
              if (n) ensure(distance(legs[n - 1].at(-1)!, leg[0]) <= 5, '路径分段之间不连续，未保存路线', 502);
              for (let v = 1; v < leg.length; v++) measured += distance(leg[v - 1], leg[v]);
            }
            ensure(Math.abs(measured - f.properties.distance) <= Math.max(30, measured * .2), '路径几何长度与返回距离明显不符，未保存估计', 502);
            drafts.push({ entityId: `walk:${digest(mapCanonical(input.placeIds))}`, kind: 'route', name: input.name || '散步路径', address: '', category: 'walk', precision: 'place', geometry: f.geometry, route: { mode: 'walk', placeIds: input.placeIds!, distanceMeters: f.properties.distance, movingSeconds: f.properties.time }, source: source(id, {}, 'https://apidocs.geoapify.com/docs/routing/') });
          }
        }
      }
      this.scope(owner, input.workspaceId);
      if(input.nearRouteId)this.store.allowed(input.nearRouteId,owner,input.workspaceId);
      for (const pid of [input.placeId, input.nearPlaceId, ...(input.placeIds || [])].filter(Boolean) as string[]) this.store.allowed(pid, owner, input.workspaceId);
      if (signal?.aborted) throw cancelled();
      return this.db.transaction(() => {
        const assets = drafts.map(draft => this.store.put(owner, id, draft));
        const ambiguous = input.action === 'search' && (assets.length > 1 || assets.some(a => !['place','street'].includes(a.precision) || (a.match?.confidence ?? 0) < .8));
        const result: MapQueryResult = { queryId: id, status: assets.length ? ambiguous ? 'ambiguous' : 'ok' : 'no_match', assets, cached, estimatedCredits: cost, message: assets.length ? input.action === 'search' ? '请核对名称、类别和城市后选择地点；地图匹配不代表营业或体验信息已核实' : input.action === 'schematic' ? '仅表达地点顺序，不代表道路路径或实际耗时' : input.action === 'suggested_area' ? '根据所选地点生成的建议探索范围，不是真实边界' : '已保存几何、来源与查询条件' : input.action === 'area' ? '未取得该地点的真实轮廓；可保留地点或另建建议范围' : '未找到可靠结果，请调整名称或地域' };
        this.finish(result); return result;
      })();
    } catch (error) {
      if (error instanceof AppError && error.status === 403) {
        this.finish({ queryId: id, status: 'failed', assets: [], cached, estimatedCredits: cost, message: '地图所属计划的权限已变更，查询结果未绑定到计划' });
        throw error;
      }
      const timedOut = signal?.aborted && signal.reason?.name === 'TimeoutError';
      const isCancelled = !timedOut && (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'));
      const result: MapQueryResult = { queryId: id, status: isCancelled ? 'cancelled' : 'failed', assets: [], cached, estimatedCredits: cost, message: timedOut ? '地图查询超时，请稍后重试；计划未修改' : isCancelled ? '地图查询已取消，计划未修改' : error instanceof AppError ? error.message : error instanceof z.ZodError ? '地图结果格式或几何无效，请调整查询' : '地图查询未完成，请稍后重试' };
      this.finish(result); return result;
    }
  }
  async close() { await this.transport.close(); await Promise.allSettled(this.active.values()); }
}

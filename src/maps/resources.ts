import { ensure } from '../service/domain/validation.js';
import type { MapTransport } from './transport.js';

export const MAP_STYLE = '/api/maps/resources/v1/styles/positron/style.json';
export const MAP_ATTRIBUTION = '© Geoapify · © OpenStreetMap contributors · © OpenMapTiles';
export function resourcePath(input: string, template = false): string {
  ensure(input.length < 600 && !/[?&#\\\x00-\x1f]/.test(input) && !input.includes('..') && !input.includes('%'), '地图资源路径无效');
  if (/^v1\/styles\/positron\/(style\.json|data\.json|sprite(?:@2x)?\.(json|png))$/.test(input)) return input;
  if (template && ['v1/styles/positron/sprite', 'v1/styles/positron/fonts/{fontstack}/{range}.pbf', 'v1/tile/vector/{z}/{x}/{y}.pbf'].includes(input)) return input;
  const font = /^v1\/styles\/positron\/fonts\/([\p{L}\p{N} _.,-]{1,200})\/(\d{1,5})-(\d{1,5})\.pbf$/u.exec(input);
  if (font && Number(font[3]) === Number(font[2]) + 255 && Number(font[2]) % 256 === 0 && Number(font[3]) <= 65535) return input;
  const tile = /^v1\/tile\/vector\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.pbf$/.exec(input);
  if (tile && Number(tile[1]) <= 14 && Number(tile[2]) < 2 ** Number(tile[1]) && Number(tile[3]) < 2 ** Number(tile[1])) return input;
  ensure(false, '不支持该地图资源', 404);
}
export function rewriteMapResources(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('https://maps.geoapify.com/')) {
      const u = new URL(value);
      const path = decodeURIComponent(u.pathname).replace(/^\//, '');
      return '/api/maps/resources/' + resourcePath(path, true);
    }
    ensure(!/[?&](apiKey|token|key)=/i.test(value), '地图资源包含未经处理的鉴权链接', 502);
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteMapResources);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (['url', 'glyphs', 'sprite'].includes(key) && typeof child === 'string') ensure(child.startsWith('https://maps.geoapify.com/'), '地图样式引用了非允许来源', 502);
      if (key === 'tiles' && Array.isArray(child)) ensure(child.every(v => typeof v === 'string' && v.startsWith('https://maps.geoapify.com/')), '地图瓦片来源无效', 502);
      result[key] = rewriteMapResources(child);
    }
    return result;
  }
  return value;
}
export async function mapResource(transport: MapTransport, input: string, signal?: AbortSignal) {
  const path = resourcePath(input);
  // Reserve 0.25 credit per resource as a conservative local budget estimate.
  // Only tile pricing is published; this is not the provider's billing report.
  const result = await transport.get('https://maps.geoapify.com/' + path, .25, `resource:${path}`, { signal, cacheMs: 3600000 });
  if (path.endsWith('.json')) {
    let json: unknown;
    try { json = JSON.parse(result.bytes.toString('utf8')); } catch { ensure(false, '地图样式或索引格式异常', 502); }
    return { ...result, bytes: Buffer.from(JSON.stringify(rewriteMapResources(json))), mime: 'application/json' };
  }
  if (path.endsWith('.png')) ensure(result.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), '地图图标格式异常', 502);
  return { ...result, mime: path.endsWith('.png') ? 'image/png' : 'application/x-protobuf' };
}

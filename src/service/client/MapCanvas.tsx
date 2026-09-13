import { useEffect, useRef, useState } from 'react';
import { Map as LibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type ExpressionSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import { geometryBounds, type Geometry, type SpatialAsset } from '../../shared/maps';
import { useMapSlot } from './map-slots';
import { mapFailureMessage, mapResourceFallback } from './map-errors';
setWorkerUrl(workerUrl);
export interface MapItem { id: string; title: string; geometry: Geometry; precision?: SpatialAsset['precision']; label?: string; optional?: boolean; stale?: boolean; schematic?: boolean; suggested?: boolean }
interface Props { items: MapItem[]; selectedId: string; onSelect(id: string): void; viewKey: string; style: string; extent?: Geometry[] }
const views = new globalThis.Map<string, { center: [number, number]; zoom: number }>();
export default function MapCanvas({ items, selectedId, onSelect, viewKey, style, extent }: Props) {
  const slot = useMapSlot();
  const container = useRef<HTMLDivElement>(null), instance = useRef<LibreMap | null>(null), latest = useRef({ items, selectedId, onSelect, extent });
  const [message, setMessage] = useState('正在加载地图…'), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const rendered = useRef<MapItem[] | null>(null), highlighted = useRef(''), previousSelection = useRef(selectedId);
  latest.current = { items, selectedId, onSelect, extent };
  const fit = () => {
    const map = instance.current, bounds = geometryBounds(latest.current.extent || latest.current.items.map(i => i.geometry));
    const items = latest.current.items;
    const onlyOverview = items.length > 0 && items.every(item => item.precision === 'city' || item.precision === 'region');
    // A representative city point is not a precise visit location. This only
    // changes framing; it does not manufacture a boundary or alter coordinates.
    const maxZoom = onlyOverview ? items.some(item => item.precision === 'region') ? 6 : 11 : 15;
    if (map && bounds) map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 54, maxZoom, duration: 0 });
  };
  const update = () => {
    const map = instance.current; if (!map?.getSource('plan-points')) return;
    const feature = (item: MapItem, i = 0) => ({ type: 'Feature' as const, id: item.id, geometry: item.geometry, properties: { itemId: item.id, number: item.label || String(i + 1), title: item.title, optional: !!item.optional, stale: !!item.stale, schematic: !!item.schematic, suggested: !!item.suggested } });
    if (rendered.current !== latest.current.items) {
      const data: FeatureCollection = { type: 'FeatureCollection', features: latest.current.items.map(feature) };
      (map.getSource('plan-points') as GeoJSONSource).setData({ ...data, features: data.features.filter(f => f.geometry.type === 'Point') });
      (map.getSource('plan-shapes') as GeoJSONSource).setData({ ...data, features: data.features.filter(f => f.geometry.type !== 'Point') });
      rendered.current = latest.current.items;
    }
    if (highlighted.current) map.removeFeatureState({ source: 'plan-shapes', id: highlighted.current });
    highlighted.current = latest.current.selectedId;
    if (highlighted.current) map.setFeatureState({ source: 'plan-shapes', id: highlighted.current }, { selected: true });
    const selected = latest.current.items.find(i => i.id === latest.current.selectedId);
    (map.getSource('plan-selected') as GeoJSONSource).setData({ type: 'FeatureCollection', features: selected?.geometry.type === 'Point' ? [feature(selected)] : [] });
  };
  useEffect(() => {
    if (!container.current || !slot.enabled) return;
    let map: LibreMap | undefined, live = true, resourceError = false, errorVersion = 0;
    rendered.current = null; highlighted.current = '';
    const timer = setTimeout(() => { setMessage('地图加载超时，请重试；已有地点和图文仍可查看。'); setFailed(true); }, 10000);
    setMessage('正在加载地图…'); setFailed(false);
    try {
      const saved = views.get(viewKey), bounds = geometryBounds(latest.current.extent || latest.current.items.map(i => i.geometry));
      map = new LibreMap({ container: container.current, center: saved?.center || (bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : [0, 0]), zoom: saved?.zoom || 12, maxZoom: 19, attributionControl: { compact: false }, cooperativeGestures: true, pitchWithRotate: false, dragRotate: false,
        locale: { 'NavigationControl.ZoomIn': '放大地图', 'NavigationControl.ZoomOut': '缩小地图', 'CooperativeGesturesHandler.WindowsHelpText': '按住 Ctrl 并滚动以缩放地图', 'CooperativeGesturesHandler.MacHelpText': '按住 ⌘ 并滚动以缩放地图', 'CooperativeGesturesHandler.MobileHelpText': '使用双指移动地图' },
        transformRequest: url => ({ url: new URL(url, location.origin).href, credentials: 'same-origin' }),
      });
      instance.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.on('load', () => {
        if (!map || !live) return;
        const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
        map.addSource('plan-points', { type: 'geojson', data: empty, cluster: true, clusterRadius: 38, clusterMaxZoom: 13 });
        map.addSource('plan-shapes', { type: 'geojson', data: empty });
        map.addSource('plan-selected', { type: 'geojson', data: empty });
        const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];
        map.addLayer({ id: 'plan-area', type: 'fill', source: 'plan-shapes', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['case', ['get', 'suggested'], '#b67a35', '#328b79'], 'fill-opacity': ['case', selected, .3, .13] } });
        for (const suggested of [false, true]) map.addLayer({ id: suggested ? 'plan-suggested-outline' : 'plan-area-line', type: 'line', source: 'plan-shapes', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'suggested'], suggested]], paint: { 'line-color': suggested ? '#a47132' : '#377d6d', 'line-width': ['case', selected, 3, 1.5], ...(suggested ? { 'line-dasharray': [3, 2] } : {}) } });
        for (const schematic of [false, true]) map.addLayer({ id: schematic ? 'plan-schematic' : 'plan-line', type: 'line', source: 'plan-shapes', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'schematic'], schematic]], paint: { 'line-color': ['case', ['get', 'stale'], '#9a855e', selected, '#174e3a', '#448675'], 'line-width': ['case', selected, 6, 4], 'line-opacity': ['case', ['get', 'stale'], .5, .9], ...(schematic ? { 'line-dasharray': [2, 2] } : {}) }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
        map.addLayer({ id: 'plan-clusters', type: 'circle', source: 'plan-points', filter: ['has', 'point_count'], paint: { 'circle-color': '#365e50', 'circle-radius': 22, 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
        map.addLayer({ id: 'plan-cluster-count', type: 'symbol', source: 'plan-points', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 13 }, paint: { 'text-color': '#fff' } });
        map.addLayer({ id: 'plan-point', type: 'circle', source: 'plan-points', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': ['case', ['get', 'optional'], '#bd883e', '#608979'], 'circle-radius': 16, 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
        map.addLayer({ id: 'plan-number', type: 'symbol', source: 'plan-points', filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'number'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 }, paint: { 'text-color': '#fff' } });
        map.addLayer({ id: 'plan-selected-point', type: 'circle', source: 'plan-selected', paint: { 'circle-color': '#174e3a', 'circle-radius': 22, 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
        map.addLayer({ id: 'plan-selected-number', type: 'symbol', source: 'plan-selected', layout: { 'text-field': ['get', 'number'], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#fff' } });
        update(); if (!saved) fit(); clearTimeout(timer); if (!resourceError) { setMessage(''); setFailed(false); }
      });
      map.on('click', async e => {
        if (!live || !map?.getLayer('plan-point')) return;
        const features = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['plan-selected-point', 'plan-point', 'plan-line', 'plan-schematic', 'plan-area', 'plan-clusters'] });
        const ids = [...new Set(features.map(f => f.properties.itemId).filter(Boolean))] as string[];
        if (ids.length) { const i = ids.indexOf(latest.current.selectedId); latest.current.onSelect(ids[(i + 1) % ids.length]); return; }
        const cluster = features.find(f => f.properties.cluster_id != null);
        if (cluster && cluster.geometry.type === 'Point') { try { const zoom = await (map.getSource('plan-points') as GeoJSONSource).getClusterExpansionZoom(cluster.properties.cluster_id); if (live) map.easeTo({ center: cluster.geometry.coordinates as [number, number], zoom }); } catch { /* The source may have been replaced during the lookup. */ } }
      });
      map.on('moveend', () => { if (map) { const c = map.getCenter(); views.set(viewKey, { center: [c.lng, c.lat], zoom: map.getZoom() }); if (views.size > 100) views.delete(views.keys().next().value!); } });
      map.on('error', event => {
        if (!live) return;
        resourceError = true; clearTimeout(timer); setMessage(mapResourceFallback); setFailed(true);
        const version = ++errorVersion;
        void mapFailureMessage(event.error).then(message => { if (live && version === errorVersion) setMessage(message); });
      });
      // Sprite URLs are validated before transformRequest runs in MapLibre.
      map.setStyle(style, { transformStyle: (_previous, next) => ({ ...next, ...(next.sprite ? { sprite: typeof next.sprite === 'string' ? new URL(next.sprite, location.origin).href : next.sprite.map(sprite => ({ ...sprite, url: new URL(sprite.url, location.origin).href })) } : {}) }) });
    } catch { clearTimeout(timer); setFailed(true); setMessage('此浏览器暂时无法显示地图，仍可从列表查看地点与图文。'); }
    const observer = new ResizeObserver(() => map?.resize()); observer.observe(container.current);
    return () => { live = false; clearTimeout(timer); observer.disconnect(); map?.remove(); instance.current = null; rendered.current = null; };
  }, [viewKey, style, retry, slot.enabled]);
  useEffect(update, [items, selectedId]);
  useEffect(() => {
    if (previousSelection.current === selectedId) return;
    previousSelection.current = selectedId;
    const map = instance.current, selected = latest.current.items.find(i => i.id === selectedId);
    if (map && selected?.geometry.type === 'Point' && !map.getBounds().contains(selected.geometry.coordinates)) map.easeTo({ center: selected.geometry.coordinates, duration: 200 });
  }, [selectedId]);
  return <div className="map-canvas-wrap"><div className="map-canvas" ref={container} role="region" aria-label="计划地图，可从旁边列表选择相同内容"/>
    {slot.enabled && <div className="map-canvas-legend" aria-label="地图图例">{items.some(i => i.geometry.type.includes('LineString') && !i.schematic) && <span><i className="legend-path"/>步行路径</span>}{items.some(i => i.schematic) && <span><i className="legend-schematic"/>顺序示意</span>}{items.some(i => i.suggested) && <span><i className="legend-suggestion"/>建议范围</span>}{items.some(i => i.geometry.type.includes('Polygon') && !i.suggested) && <span><i className="legend-boundary"/>真实轮廓</span>}</div>}
    {slot.enabled ? <><button className="map-fit" onClick={fit}>查看全部</button>
    {message && <div className="map-load-state" role="status"><span>{message}</span>{failed && <button onClick={() => setRetry(n => n + 1)}>重试地图</button>}</div>}</> : <div className="map-load-state"><span>另一幅地图正在展示，地点和图文仍可阅读。</span><button onClick={slot.activate}>查看这幅地图</button></div>}
  </div>;
}

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/service/server/app.js';
import { nodeFields } from '../src/shared/model.js';
import { bindingStale, coordinateContextWarning, geometrySchema, spatialBindingSchema } from '../src/shared/maps.js';
import { inspectBackup, restoreDatabase } from '../src/storage/maintenance.js';
import { openDatabase } from '../src/storage/database.js';
import { MapStore } from '../src/maps/store.js';
import { MapTransport, type MapTransportOptions } from '../src/maps/transport.js';
import { resourcePath, rewriteMapResources } from '../src/maps/resources.js';

const p1 = [11.25, 43.76], p2 = [11.255, 43.761];
const feature = (name: string, point: number[]) => ({ properties: { place_id: name, name, formatted: name + ', Florence, Italy', category: 'entertainment.museum', country_code: 'it', city: 'Florence', country: 'Italy', result_type: 'amenity', rank: { confidence: 1 }, datasource: { attribution: '© OpenStreetMap contributors', license: 'Open Database License' } }, geometry: { type: 'Point', coordinates: point } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fakeFetch: NonNullable<MapTransportOptions['fetch']> = async (url) => {
  const u = new URL(url);
  if (u.pathname.includes('geocode')) { const text = (u.searchParams.get('text') || u.searchParams.get('name'))!; return json({ features: text.startsWith('none') ? [] : [feature(text.startsWith('second') ? 'second' : 'first', text.startsWith('second') ? p2 : p1)] }); }
  if (u.pathname.includes('routing')) return json({ features: [{ properties: { mode: 'walk', distance_units: 'meters', distance: 450, time: 360 }, geometry: { type: 'MultiLineString', coordinates: [[p1, [11.253,43.76], p2]] } }] });
  if (u.pathname.includes('place-details')) return json({ features: [{ properties: { ...feature('first', p1).properties, place_id: 'first-details', feature_type: 'details', lon: p1[0], lat: p1[1], categories: ['building'] }, geometry: { type: 'Polygon', coordinates: [[[11.249,43.759],[11.251,43.759],[11.251,43.761],[11.249,43.761],[11.249,43.759]]] } }] });
  if (u.pathname.endsWith('style.json')) return json({ version: 8, sources: { base: { type: 'vector', url: 'https://maps.geoapify.com/v1/styles/positron/data.json?apiKey=map-test-key' } }, glyphs: 'https://maps.geoapify.com/v1/styles/positron/fonts/{fontstack}/{range}.pbf?apiKey=map-test-key', sprite: 'https://maps.geoapify.com/v1/styles/positron/sprite?apiKey=map-test-key', layers: [] });
  if (u.pathname.endsWith('data.json')) return json({ tiles: ['https://maps.geoapify.com/v1/tile/vector/{z}/{x}/{y}.pbf?apiKey=map-test-key'], attribution: 'Geoapify · OpenStreetMap · OpenMapTiles' });
  return new Response(new Uint8Array([26,0]), { headers: { 'Content-Type': 'application/x-protobuf' } });
};
async function fixture(t: TestContext, options: MapTransportOptions = {}) {
  const f = await createApp({ maps: { apiKey: 'map-test-key', fetch: fakeFetch, ...options } });
  t.after(() => f.app.close());
  const owner = f.auth.create({ username: 'owner', password: 'testing-password', name: '组织者' }, true), peer = f.auth.create({ username: 'reader', password: 'testing-password', name: '同行' }), stranger = f.auth.create({ username: 'stranger', password: 'testing-password', name: '非成员' });
  const headers = (user = owner) => ({ cookie: 'travel_session=' + f.auth.session(user), 'x-travel-app': '1', host: 'localhost' });
  const command = (kind: string, payload: object, workspaceId?: string, user = owner) => f.plans.execute(user.id, { requestId: randomUUID(), kind, payload, ...(workspaceId ? { workspaceId, version: f.plans.get(workspaceId).version } : {}) });
  const create = () => command('create', { kind: 'trip', node: nodeFields.parse({ title: '受控地图测试' }) }).workspaceId;
  const search = (text: string, workspaceId?: string) => f.maps.query(owner.id, { action: 'search', text, country: 'it', workspaceId, requestId: randomUUID() });
  return { ...f, owner, peer, stranger, headers, command, create, search };
}

test('MA11/18: batched readable assets preserve partial access, reject corruption and recheck revocation', async t => {
  const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
  const published=(await f.search('first',wid)).assets[0],hidden=(await f.search('second',wid)).assets[0];
  f.command('spatial',{nodeId:root,bindings:[{assetId:published.id,primary:true}]},wid);
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
  const ids=[hidden.id,published.id,randomUUID(),published.id];
  assert.deepEqual(f.maps.store.readMany(ids,f.peer.id,wid,{skipUnavailable:true}).map(a=>a.id),[published.id]);
  assert.throws(()=>f.maps.store.readMany(ids,f.peer.id,wid),/私人/);
  const original=f.maps.store.row(published.id).body;
  f.db.prepare('UPDATE spatial_assets SET body=? WHERE id=?').run('{}',published.id);
  assert.throws(()=>f.maps.store.readMany([published.id],f.peer.id,wid,{skipUnavailable:true}),/完整性/);
  f.db.prepare('UPDATE spatial_assets SET body=? WHERE id=?').run(original,published.id);
  f.db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').run(wid,f.peer.id);
  assert.deepEqual(f.maps.store.readMany(ids,f.peer.id,wid,{skipUnavailable:true}),[]);
  assert.throws(()=>f.maps.store.readMany([published.id],f.peer.id,wid),/权限/);
  assert.deepEqual(f.maps.store.readMany([hidden.id],f.owner.id,wid).map(a=>a.id),[hidden.id]);
});

test('MA02/15: structured query cache, coalescing, immutable assets and idempotence; no implicit binding', async t => {
  let calls = 0;
  const f = await fixture(t, { fetch: async (url, init) => { calls++; await new Promise(r => setTimeout(r, 30)); return fakeFetch(url, init); } });
  const wid = f.create(), before = f.plans.get(wid), input = { action: 'search', text: 'first', country: 'it', workspaceId: wid, requestId: randomUUID() };
  const [a, b] = await Promise.all([f.maps.query(f.owner.id, input), f.maps.query(f.owner.id, { ...input, requestId: randomUUID() })]);
  assert.equal(calls, 1); assert.equal(a.assets[0].id, b.assets[0].id); assert.equal(Number(a.cached) + Number(b.cached), 1);
  assert.deepEqual(f.plans.get(wid), before, 'looking at a result must not bind a place');
  assert.deepEqual(await f.maps.query(f.owner.id, input), a);
  await assert.rejects(f.maps.query(f.owner.id, { ...input, text: 'second' }), /请求标识/);
  const cached = await f.maps.query(f.owner.id, { ...input, requestId: randomUUID() }); assert.equal(cached.cached, true); assert.equal(cached.estimatedCredits, 0); assert.equal(calls, 1);
  await assert.rejects(f.maps.query(f.owner.id, { ...input, coordinates: p2, requestId: randomUUID() }));
  assert.equal((await f.search('none')).status, 'no_match');
  assert.equal((await f.maps.query(f.owner.id, { ...input, category: 'railway', requestId: randomUUID() })).status, 'no_match');
});

test('MA07/08: real and schematic geometry are typed, preserve provenance and do not invent travel estimates', async t => {
  const f = await fixture(t), a = (await f.search('first')).assets[0], b = (await f.search('second')).assets[0];
  const route = await f.maps.query(f.owner.id, { action: 'route', placeIds: [a.id,b.id], requestId: randomUUID() });
  assert.equal(route.status, 'ok'); assert.equal(route.assets[0].route?.movingSeconds, 360); assert.equal(route.assets[0].route?.distanceMeters, 450); assert.equal(route.assets[0].source.queryId, route.queryId);
  const schematic = await f.maps.query(f.owner.id, { action: 'schematic', placeIds: [a.id,b.id], requestId: randomUUID() });
  assert.equal(schematic.assets[0].route?.distanceMeters, null); assert.equal(schematic.assets[0].route?.movingSeconds, null); assert.equal(schematic.estimatedCredits, 0);
  const area = await f.maps.query(f.owner.id, { action: 'area', placeId: a.id, requestId: randomUUID() }); assert.equal(area.status, 'ok'); assert.equal(area.assets[0].areaNature, 'building');
  const suggestion = await f.maps.query(f.owner.id, { action: 'suggested_area', placeIds: [a.id,b.id], requestId: randomUUID() }); assert.equal(suggestion.assets[0].areaNature, 'suggested'); assert.equal(suggestion.assets[0].source.provider, 'suggestion');
  assert.throws(() => f.maps.store.evidence({ assetId: route.assets[0].id, queryId: route.queryId, field: 'distanceMeters', value: 9 }, f.owner.id), /证据/);
  assert.equal(f.maps.store.evidence({ assetId: route.assets[0].id, queryId: route.queryId, field: 'distanceMeters', value: 450 }, f.owner.id).id, route.assets[0].id);
  await assert.rejects(f.maps.query(f.owner.id, { action: 'route', placeIds: [randomUUID(),b.id], requestId: randomUUID() }), /找不到/);
});

test('MA02: squares use structured street search and keep representative-position precision', async t => {
  const urls: URL[] = [];
  const f = await fixture(t, { fetch: async url => {
    const u = new URL(url); urls.push(u);
    return json({ features: [{ ...feature('Piazza Santa Croce', p2), properties: {
      ...feature('Piazza Santa Croce', p2).properties, category: 'highway.pedestrian', result_type: 'street',
    } }] });
  } });
  const input = { action: 'search', text: 'Piazza Santa Croce', context: 'Florence, Italy', country: 'it', requestId: randomUUID() };
  const square = await f.maps.query(f.owner.id, { ...input, category: 'square' });
  assert.equal(square.status, 'ok'); assert.equal(square.assets[0].precision, 'street');
  assert.equal(square.assets[0].category, 'highway.pedestrian');
  assert.equal(urls[0].searchParams.get('street'), input.text);
  assert.equal(urls[0].searchParams.get('city'), 'Florence');
  assert.equal(urls[0].searchParams.get('type'), 'street');
  assert.equal(urls[0].searchParams.get('bias'), 'countrycode:none');
  assert.equal(urls[0].searchParams.has('name'), false);
  const explicit = await f.maps.query(f.owner.id, { ...input, searchType: 'street', requestId: randomUUID() });
  assert.equal(explicit.assets[0].precision, 'street');
  assert.equal(urls[1].searchParams.get('type'), 'street');
});

test('MA02: real response replay recovers named places without relaxing category or city', async t => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/maps/geoapify-search-fallback.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/place-sample-inputs.json', import.meta.url), 'utf8'));
  let current = 'D2-10'; const urls: URL[] = [];
  const centre = () => current === 'D2-13' ? [11.7206547,45.7726007] : current === 'D2-14' ? [9.1546375,45.1860043] : [11.2556404,43.7697955];
  const f = await fixture(t, { fetch: async url => {
    const u = new URL(url); urls.push(u);
    if (u.searchParams.get('text')?.startsWith('anchor-')) return json({ features: [feature('anchor-' + current, centre())] });
    if (u.pathname.includes('geocode')) return json(raw.geocode[current]);
    if (u.pathname === '/v2/places') return json(u.searchParams.has('name') ? { features: [] } : raw.nearby[current] || { features: [] });
    throw new Error('Unexpected request');
  } });
  const wid = f.create(), before = f.plans.get(wid);
  for (const [id, count] of [['D2-10',1],['D2-11',1],['D2-13',0],['D2-14',1],['D2-17',3],['D2-19',0],['D2-20',1]] as const) {
    current = id;
    const anchor = (await f.search('anchor-' + id)).assets[0];
    const input = { ...manifest.samples.find((s: { id: string }) => s.id === id).input, action: 'search', workspaceId: wid, nearPlaceId: anchor.id, requestId: randomUUID() };
    const n = urls.length, result = await f.maps.query(f.owner.id, input);
    assert.equal(result.assets.length, count, id);
    assert.equal(result.status === 'no_match', count === 0, id);
    assert.equal(result.estimatedCredits, ['D2-13','D2-14'].includes(id) ? 3 : 2, 'every upstream stage is counted');
    const geo = urls.slice(n).find(u => u.pathname.includes('geocode'))!;
    assert.equal(geo.searchParams.get('name'), input.text);
    assert.equal(geo.searchParams.get('city'), input.context.split(',')[0]);
    assert.equal(geo.searchParams.get('filter'), `circle:${centre().join(',')},10000`);
    assert.ok(result.assets.every(a => a.match?.countryCode === 'it'));
    if (id === 'D2-14') assert.match(result.assets[0].category, /man_made\.bridge/);
    if (id === 'D2-17') {
      assert.equal(result.status, 'ambiguous');
      assert.ok(result.assets.some(a => a.address.includes('Via dei Neri')));
    }
    const requests = urls.length;
    const cached = await f.maps.query(f.owner.id, { ...input, requestId: randomUUID() });
    assert.equal(cached.cached, true); assert.equal(cached.estimatedCredits, 0); assert.equal(urls.length, requests);
    assert.deepEqual(f.plans.get(wid), before, 'research candidates never bind themselves');
  }
});

test('MA02: category fallback rejects nearby namesakes, remote geometry, foreign country and parking', async t => {
  let mode: 'bridge' | 'park' = 'bridge';
  const custom = (name: string, point: number[], category: string, country = 'it') => ({ ...feature(name, point), properties: { ...feature(name, point).properties, category, country_code: country } });
  const f = await fixture(t, { fetch: async url => {
    const u = new URL(url);
    if (u.searchParams.get('text') === 'anchor') return json({ features: [feature('anchor', p1)] });
    if (u.pathname.includes('geocode')) return json({ features: [custom('Expected', p1, mode === 'park' ? 'commercial.parking' : 'amenity')] });
    if (u.searchParams.has('name')) return json({ features: [] });
    return json({ features: [custom('Other bridge', p1, 'man_made.bridge'), custom('Expected', [11.3,43.76], 'man_made.bridge'), custom('Expected', p1, 'man_made.bridge', 'fr')] });
  } });
  const anchor = (await f.search('anchor')).assets[0];
  for (mode of ['bridge','park'] as const) {
    const result = await f.maps.query(f.owner.id, { action: 'search', text: 'Expected', context: 'Florence, Italy', country: 'it', category: mode, nearPlaceId: anchor.id, requestId: randomUUID() });
    assert.equal(result.status, 'no_match'); assert.deepEqual(result.assets, []);
  }
});

test('MA14: staged place lookup shares one deadline and saves no partial candidates', async t => {
  let calls = 0;
  const f = await fixture(t, { timeoutMs: 650, fetch: async (url, { signal }) => {
    const u = new URL(url);
    if (u.searchParams.get('text') === 'anchor') return json({ features: [feature('anchor', p1)] });
    calls++;
    if (u.pathname === '/v2/places') return json({ features: [] });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  } });
  const anchor = (await f.search('anchor')).assets[0], start = Date.now();
  const result = await f.maps.query(f.owner.id, { action: 'search', text: 'slow', category: 'park', country: 'it', nearPlaceId: anchor.id, requestId: randomUUID() });
  assert.equal(result.status, 'failed'); assert.match(result.message, /超时/);
  assert.ok(Date.now() - start < 1200); assert.equal(calls, 2); assert.deepEqual(result.assets, []);
  assert.equal(result.estimatedCredits, null, 'unfinished upstream cost is not claimed as zero');
});

test('MA07: reject wrong units, reordered stops, disconnected legs and inconsistent distance', async t => {
  const stops = [[11.25,43.76], [11.27,43.76], [11.29,43.76]];
  const good = { properties: { mode:'walk', distance_units:'meters', distance:3200, time:2500 }, geometry:{ type:'MultiLineString', coordinates:[[stops[0],stops[1]],[stops[1],stops[2]]] } };
  let returned: unknown = good;
  const f = await fixture(t, { fetch: async url => {
    const u = new URL(url);
    if(u.pathname.includes('routing')) {
      assert.equal(u.searchParams.get('units'), 'metric');
      assert.equal(u.searchParams.get('intermediate_waypoint_mode'), 'stopover');
      return json({features:[returned]});
    }
    const n=Number(u.searchParams.get('text'));
    return json({features:[feature(String(n),stops[n])]});
  }});
  const wid=f.create(), before=f.plans.get(wid), ids:string[]=[];
  for(let n=0;n<3;n++)ids.push((await f.search(String(n))).assets[0].id);
  const route = (name:string) => f.maps.query(f.owner.id,{action:'route',placeIds:ids,name,workspaceId:wid,requestId:randomUUID()});
  assert.equal((await route('good')).status,'ok');
  const cases = [
    {name:'missing units',value:{...good,properties:{...good.properties,distance_units:undefined}},message:/单位/},
    {name:'miles',value:{...good,properties:{...good.properties,distance_units:'miles'}},message:/单位/},
    {name:'out of order',value:{...good,geometry:{...good.geometry,coordinates:[[stops[0],stops[2]],[stops[2],stops[1]]]}},message:/顺序/},
    {name:'disconnected',value:{...good,geometry:{...good.geometry,coordinates:[[stops[0],stops[1]],[[11.271,43.76],stops[2]]]}},message:/不连续/},
    {name:'wrong summary',value:{...good,properties:{...good.properties,distance:32}},message:/长度/},
    {name:'missing leg',value:{...good,geometry:{...good.geometry,coordinates:[[stops[0],stops[1],stops[2]]]}},message:/分段/},
  ];
  for(const c of cases) { returned=c.value;const result=await route(c.name);assert.equal(result.status,'failed',c.name);assert.match(result.message,c.message);assert.deepEqual(result.assets,[]); }
  assert.deepEqual(f.plans.get(wid),before,'rejected provider geometry must not mutate the plan');
});

test('MA07: actual Geoapify walking response accepts routing-specific fields and preserves geometry', async t => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/maps/geoapify-florence-walk.json',import.meta.url),'utf8'));
  const stops = raw.features[0].properties.waypoints.map((w:{location:number[]})=>w.location);
  const f=await fixture(t,{fetch:async url=>{
    const u=new URL(url);if(u.pathname.includes('routing'))return json(raw);
    const n=Number(u.searchParams.get('text'));return json({features:[feature(String(n),stops[n])]});
  }});
  const ids=[];for(let n=0;n<2;n++)ids.push((await f.search(String(n))).assets[0].id);
  const result=await f.maps.query(f.owner.id,{action:'route',placeIds:ids,requestId:randomUUID()});
  assert.equal(result.status,'ok',result.message);assert.deepEqual(result.assets[0].geometry,raw.features[0].geometry);
  assert.equal(result.assets[0].route?.distanceMeters,756);assert.equal(result.assets[0].route?.movingSeconds,731.992);
});

test('MA09/10/11/13: plan binding is atomic, reversible, permission checked and survives backup including historical assets', async t => {
  const f = await fixture(t), wid = f.create(), a = (await f.search('first', wid)).assets[0], b = (await f.search('second', wid)).assets[0];
  const root = f.plans.get(wid).data.rootId;
  f.command('add', { parentId: root, node: nodeFields.parse({ title: '下一处' }) }, wid);
  const child = Object.keys(f.plans.get(wid).data.nodes).find(id => id !== root)!;
  f.command('spatial', { nodeId: root, bindings: [{ assetId: a.id, primary: true }] }, wid);
  f.command('spatial', { nodeId: child, bindings: [{ assetId: b.id, primary: true }] }, wid);
  const route = (await f.maps.query(f.owner.id, { action: 'route', placeIds: [a.id,b.id], workspaceId: wid, requestId: randomUUID() })).assets[0];
  const initial = f.plans.get(wid), input = { kind: 'spatial', requestId: randomUUID(), workspaceId: wid, version: initial.version, payload: { nodeId: root, bindings: [{ assetId: a.id, primary: true }, { assetId: route.id, nodeIds: [root,child] }] } };
  const applied = f.plans.execute(f.owner.id, input); assert.deepEqual(f.plans.execute(f.owner.id, input), applied);
  assert.equal(f.plans.get(wid).version, initial.version + 1);
  f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid, f.peer.id);
  assert.throws(() => f.maps.store.allowed(route.id, f.peer.id), /私人/);
  assert.equal(f.maps.store.allowed(route.id, f.peer.id, wid).id, route.id);
  assert.throws(() => f.maps.store.allowed(route.id, f.stranger.id, wid), /权限/);
  assert.throws(() => f.command('spatial', { nodeId: root, bindings: [] }, wid, f.peer), /只读/);
  const beforeBad = f.plans.get(wid);
  assert.throws(() => f.command('spatial', { nodeId: root, bindings: [{ assetId: b.id, primary: true }, { assetId: randomUUID() }] }, wid));
  assert.deepEqual(f.plans.get(wid), beforeBad, 'partial location projection must roll back');
  const data = structuredClone(beforeBad.data), binding = data.spatial![root].find(x => x.assetId === route.id)!;
  assert.equal(bindingStale(data, binding), false); data.nodes[child].notes = '只是补充说明'; assert.equal(bindingStale(data, binding), false); data.nodes[child].order++; assert.equal(bindingStale(data, binding), true);
  const {id,parentId,order,...fields} = beforeBad.data.nodes[root];
  // Saved provider projection and parsed forms can have different property order.
  const location = fields.location;
  f.db.exec('SAVEPOINT notes_identity_check');
  f.command('edit', {nodeId:root,node:nodeFields.parse({...fields,notes:'只修改备注',location:{lng:location.lng,lat:location.lat,address:location.address,name:location.name}})}, wid);
  assert.deepEqual(f.plans.get(wid).data.spatial, beforeBad.data.spatial, 'notes must not silently detach verified place identity');
  assert.equal(bindingStale(f.plans.get(wid).data,f.plans.get(wid).data.spatial![root].find(b=>b.assetId===route.id)!),false);
  f.db.exec('ROLLBACK TO notes_identity_check; RELEASE notes_identity_check');
  const calls = f.maps.status().requests;
  f.command('undo', { changeId: applied.changeId }); assert.deepEqual(f.plans.get(wid).data, initial.data); assert.equal(f.maps.status().requests, calls); assert.throws(() => f.maps.store.allowed(route.id, f.peer.id, wid), /私人/);
  const dir = mkdtempSync(join(tmpdir(), 'map-backup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'good.db'); await f.db.backup(file); inspectBackup(file); await restoreDatabase(file, join(dir, 'restored'));
  const restored = openDatabase(join(dir, 'restored/travel.db')); assert.deepEqual(new MapStore(restored).get(route.id), route); restored.close();
  const bad = join(dir, 'bad.db'); copyFileSync(file, bad); const broken = openDatabase(bad); broken.prepare('UPDATE spatial_assets SET body=? WHERE id=?').run('{}', a.id); broken.close();
  await assert.rejects(restoreDatabase(bad, join(dir, 'restored')), /空间资产|完整性/);
  const still = openDatabase(join(dir, 'restored/travel.db')); assert.equal(new MapStore(still).get(a.id).id, a.id); still.close();
});

test('MA14/16: resource allowlist, nested URL rewrite, authentication before warm cache and no credential exposure', async t => {
  const f = await fixture(t), path = '/api/maps/resources/v1/styles/positron/style.json';
  assert.equal((await f.app.inject({ url: path })).statusCode, 401);
  const first = await f.app.inject({ url: path, headers: f.headers() }); assert.equal(first.statusCode, 200); assert.ok(!first.body.includes('map-test-key')); assert.ok(!first.body.includes('apiKey=')); assert.ok(first.json().glyphs.startsWith('/api/maps/resources/'));
  const warm = await f.app.inject({ url: path, headers: f.headers() }); assert.equal(warm.headers['x-map-cache'], 'hit');
  assert.equal((await f.app.inject({ url: path })).statusCode, 401);
  assert.equal((await f.app.inject({ url: path + '?url=https://example.com', headers: f.headers() })).statusCode, 400);
  assert.equal((await f.app.inject({ url: '/api/maps/resources/v1/geocode/search', headers: f.headers() })).statusCode, 404);
  for (const input of ['https://example.com', '../etc/passwd', 'v1/tile/vector/2/9/0.pbf', 'v1/tile/vector/4/2/2.pbf?apiKey=x', 'v1/styles/positron/fonts/a/%2f.pbf']) assert.throws(() => resourcePath(input));
  assert.throws(() => rewriteMapResources({ sources: { evil: { url: 'https://evil.example/tile.json' } } }));
  const realStyle = JSON.parse(readFileSync(new URL('./fixtures/maps/geoapify-positron-style.json', import.meta.url), 'utf8'));
  const rewritten = JSON.stringify(rewriteMapResources(realStyle)); assert.ok(!rewritten.includes('apiKey=')); assert.ok(rewritten.includes('/api/maps/resources/'));
});

test('MA16: transport rejects arbitrary origins and oversized declared or streamed resources', async t => {
  for (const declared of [true,false]) {
    const db=openDatabase(':memory:');t.after(()=>db.close());let calls=0;
    const transport=new MapTransport(db,{apiKey:'test',fetch:async()=>{calls++;return declared ? new Response('x',{headers:{'content-length':String(9*1024*1024)}}) : new Response(new Uint8Array(8*1024*1024+1));}});t.after(()=>transport.close());
    for(const url of ['https://example.com/a','http://maps.geoapify.com/a','https://user:password@maps.geoapify.com/a'])await assert.rejects(transport.get(url,.25,'bad'),/来源/);
    assert.equal(calls,0);
    await assert.rejects(transport.get('https://maps.geoapify.com/v1/styles/positron/style.json',.25,'large'),/过大/);
    assert.equal(calls,1,'size rejection must not repeatedly download oversized resources');
  }
});

test('MA14/15: unavailable, authentication failure, bounded retry, timeout, cancellation and local budget', async t => {
  let calls = 0;
  const f = await fixture(t, { fetch: async () => { calls++; return json({}, 401); } });
  const auth = await f.search('auth'); assert.equal(auth.status, 'failed'); assert.match(auth.message, /鉴权/); assert.equal(calls, 1); assert.equal(auth.estimatedCredits, null);
  const g = await fixture(t, { fetch: async () => json({}, 429) }); assert.equal((await g.search('rate')).status, 'failed'); assert.equal(g.maps.status().requests, 2);
  const h = await fixture(t, { apiKey: '' }); assert.equal((await h.search('unavailable')).status, 'failed'); assert.equal(h.maps.status().requests, 0);
  const k = await fixture(t, { dailyBudget: 1 }); assert.equal((await k.search('first')).status, 'ok'); assert.equal((await k.search('second')).status, 'failed'); assert.equal(k.maps.status().requests, 1);
  const l = await fixture(t, { timeoutMs: 100, fetch: async (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
  const start = Date.now(); assert.match((await l.search('slow')).message, /超时/); assert.ok(Date.now() - start < 1500); assert.equal(l.maps.status().requests, 1);
  const controller = new AbortController(), pending = l.maps.query(l.owner.id, { action: 'search', text: 'cancelled', requestId: randomUUID() }, { signal: controller.signal }); controller.abort(); const result = await pending; assert.equal(result.status, 'cancelled');
});

test('MA15: transport uniformly limits upstream start times and coalesced cancellation preserves other readers', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); const times: number[] = [];
  const transport = new MapTransport(db, { apiKey: 'test', fetch: async () => { times.push(Date.now()); return json({ ok: true }); } }); t.after(() => transport.close());
  await Promise.all(Array.from({ length: 6 }, (_, i) => transport.get('https://maps.geoapify.com/v1/styles/positron/style.json', .25, 'different-' + i)));
  assert.equal(times.length, 6); for (let i = 4; i < times.length; i++) assert.ok(times[i] - times[i-4] >= 1000);
  let resolve!: (r: Response) => void, started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const shared = new MapTransport(db, { apiKey: 'test', fetch: async () => { started(); return new Promise<Response>(r => { resolve = r; }); } }); t.after(() => shared.close());
  const controller = new AbortController(), a = shared.get('https://maps.geoapify.com/v1/styles/positron/style.json', .25, 'same', { signal: controller.signal }), b = shared.get('https://maps.geoapify.com/v1/styles/positron/style.json', .25, 'same');
  await ready; controller.abort(); await assert.rejects(a, /取消/); resolve(json({ ok: true })); assert.equal((await b).cached, true);
});

test('MA08: bbox-only details never become a boundary and invalid provider polygons leave plans unchanged', async t => {
  const cases = [
    { name: 'bbox-only', geometry: { type: 'Point', coordinates: p1 }, status: 'no_match' },
    { name: 'unclosed', geometry: { type: 'Polygon', coordinates: [[[11.24,43.75],[11.26,43.75],[11.26,43.77],[11.24,43.77]]] }, status: 'failed' },
    { name: 'self-crossing', geometry: { type: 'Polygon', coordinates: [[[11.24,43.75],[11.26,43.77],[11.24,43.77],[11.26,43.75],[11.24,43.75]]] }, status: 'failed' },
  ];
  for (const sample of cases) {
    const f = await fixture(t, { fetch: async (url, init) => {
      if (!new URL(url).pathname.includes('place-details')) return fakeFetch(url, init);
      return json({ features: [{ ...feature('first', p1), bbox: [11.24,43.75,11.26,43.77], geometry: sample.geometry }] });
    } });
    const wid = f.create(), place = (await f.search('first', wid)).assets[0], before = f.plans.get(wid);
    const count = () => (f.db.prepare('SELECT count(*) n FROM spatial_assets').get() as {n:number}).n;
    const beforeCount = count();
    const result = await f.maps.query(f.owner.id, {action:'area', placeId:place.id, workspaceId:wid, requestId:randomUUID()});
    assert.equal(result.status, sample.status, sample.name); assert.deepEqual(result.assets, []);
    assert.ok(result.message); assert.equal(count(), beforeCount); assert.deepEqual(f.plans.get(wid), before);
    assert.deepEqual(f.maps.store.get(place.id), place, 'the original representative point remains unchanged');
  }
});

test('MA03/08: malformed geometry and coordinate precision cannot be silently accepted', () => {
  for (const g of [
    { type: 'Point', coordinates: [190, 20] }, { type: 'Point', coordinates: [10] },
    { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,1]]] },
    { type: 'Polygon', coordinates: [[[0,0],[2,2],[0,2],[2,0],[0,0]]] },
    { type: 'Polygon', coordinates: [[[0,0],[1,0],[2,0],[0,0]]] },
    { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]],[[1,1],[3,1],[1,1.5],[1,1]]] },
    { type: 'Polygon', coordinates: [[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]],[[1.5,1.5],[3,1.5],[3,3],[1.5,3],[1.5,1.5]]] },
  ]) assert.equal(geometrySchema.safeParse(g).success, false);
  assert.equal(geometrySchema.safeParse({ type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]],[[.5,.5],[.5,1],[1,1],[1,.5],[.5,.5]]] }).success, true);
  assert.equal(spatialBindingSchema.parse({ assetId: randomUUID() }).primary, false);
});


test('MA03: coordinate hints flag remote or possibly swapped input without changing it',()=>{
  const known={name:'Florence',address:'',lat:43.77,lng:11.25};
  const remote={name:'地点',address:'',lat:48.85,lng:2.35},swapped={...known,lat:11.25,lng:43.77};
  const original=structuredClone(swapped);
  assert.match(coordinateContextWarning(remote,[known]),/所在城市/);
  assert.match(coordinateContextWarning(swapped,[known]),/可能填反/);
  assert.deepEqual(swapped,original);
  assert.equal(coordinateContextWarning(known,[known]),'');
  assert.equal(coordinateContextWarning({...known,lat:null},[known]),'');
  assert.equal(coordinateContextWarning(remote,[]),'');
});

test('nearby places enforce radius/category, exclude duplicates and adopt atomically without inventing time', async t => {
  let nearbyCalls=0;
  const f=await fixture(t,{fetch:async(url,init)=>{
    if(String(url).includes('/v2/places')) {
      nearbyCalls++;
      return new Response(JSON.stringify({features:[
        {properties:{place_id:'near',name:'附近博物馆',categories:['entertainment.museum'],country_code:'it'},geometry:{type:'Point',coordinates:[11.251,43.7605]}},
        {properties:{place_id:'near',name:'重复地点',categories:['entertainment.museum'],country_code:'it'},geometry:{type:'Point',coordinates:[11.251,43.7605]}},
        {properties:{place_id:'remote',name:'远处博物馆',categories:['entertainment.museum'],country_code:'it'},geometry:{type:'Point',coordinates:[12,44]}},
        {properties:{place_id:'wrong',name:'餐馆',categories:['catering.restaurant'],country_code:'it'},geometry:{type:'Point',coordinates:[11.251,43.7605]}},
      ]}),{headers:{'content-type':'application/json'}});
    }
    return fakeFetch(url,init);
  }});
  const wid=f.create(),root=f.plans.get(wid).data.rootId,center=(await f.search('first',wid)).assets[0];
  const before=f.plans.get(wid);
  const input={action:'nearby',nearPlaceId:center.id,category:'museum',radiusMeters:1000,country:'it',workspaceId:wid,requestId:randomUUID()};
  const result=await f.maps.query(f.owner.id,input);
  assert.equal(result.assets.length,1);assert.equal(result.assets[0].name,'附近博物馆');
  assert.deepEqual(f.plans.get(wid),before);
  await f.maps.query(f.owner.id,{...input,requestId:randomUUID()});assert.equal(nearbyCalls,1);
  const added=f.command('adoptPlace',{parentId:root,assetId:result.assets[0].id},wid),after=f.plans.get(wid);
  const child=Object.values(after.data.nodes).find(n=>n.parentId===root)!;
  assert.equal(child.title,'附近博物馆');assert.equal(child.dates.mode,'unset');assert.equal(after.data.spatial![child.id][0].assetId,result.assets[0].id);
  assert.throws(()=>f.command('adoptPlace',{parentId:root,assetId:result.assets[0].id},wid),/已在当前安排/);
  f.command('undo',{changeId:added.changeId});assert.deepEqual(f.plans.get(wid).data,before.data);
});

test('saved place notes remain independent, follow adopted places and preserve shared access through backup', async t => {
 const {notesForPlan}=await import('../src/shared/notes.js');
 const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
 f.command('add',{parentId:root,node:nodeFields.parse({title:'散步'})},wid);
 const parent=Object.values(f.plans.get(wid).data.nodes).find(n=>n.parentId===root)!.id;
 const asset=(await f.search('first',wid)).assets[0];
 f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
 assert.throws(()=>f.maps.store.allowed(asset.id,f.peer.id,wid),/私人/);
 const beforeNodes=f.plans.get(wid).data.nodes;
 f.command('savePlaceNote',{assetId:asset.id},wid);
 const saved=f.plans.get(wid);
 assert.deepEqual(saved.data.nodes,beforeNodes);
 assert.equal(notesForPlan(saved.data,parent).length,0);
 assert.equal(notesForPlan(saved.data,root).length,1);
 assert.equal(f.maps.store.allowed(asset.id,f.peer.id,wid).id,asset.id);
 const adoption=f.command('adoptPlace',{parentId:parent,assetId:asset.id},wid);
 assert.equal(notesForPlan(f.plans.get(wid).data,parent).length,1);
 f.command('undo',{changeId:adoption.changeId});
 assert.equal(notesForPlan(f.plans.get(wid).data,parent).length,0);
 assert.equal(notesForPlan(f.plans.get(wid).data,root).length,1);
 const dir=mkdtempSync(join(tmpdir(),'place-note-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const backup=join(dir,'backup.db');await f.db.backup(backup);inspectBackup(backup);
 assert.throws(()=>f.command('savePlaceNote',{assetId:asset.id},wid,f.peer),/只读/);
});


test('place insertion matches plan order, rejects stale positions atomically and undo restores dates', async t => {
 const {itineraryGroups}=await import('../src/shared/itinerary.js');
 const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
 for(const title of ['老桥','圣十字']) f.command('add',{parentId:root,node:nodeFields.parse({title})},wid);
 const original=f.plans.get(wid).data;
 const children=itineraryGroups(original,root).flatMap(group=>group.nodes);
 const asset=(await f.search('first',wid)).assets[0];
 assert.throws(()=>f.command('adoptPlace',{parentId:root,assetId:asset.id,beforeNodeId:'missing'},wid),/插入位置/);
 assert.deepEqual(f.plans.get(wid).data,original);
 const added=f.command('adoptPlace',{parentId:root,assetId:asset.id,beforeNodeId:children[1].id},wid);
 const data=f.plans.get(wid).data,ordered=itineraryGroups(data,root).flatMap(group=>group.nodes);
 assert.deepEqual(ordered.map(node=>node.title),['老桥',asset.name,'圣十字']);
 for(const node of children) assert.deepEqual(data.nodes[node.id].dates,node.dates);
 assert.equal(ordered[1].dates.mode,'unset');
 f.command('undo',{changeId:added.changeId});
 assert.deepEqual(f.plans.get(wid).data,original);
});

test('removed places stay readable through notebook references and restore on undo',async t=>{
 const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
 const asset=(await f.search('first',wid)).assets[0];
 f.command('adoptPlace',{parentId:root,assetId:asset.id},wid);
 const before=f.plans.get(wid),node=Object.values(before.data.nodes).find(n=>n.parentId===root)!;
 f.db.prepare("INSERT INTO members VALUES(?,?,'reader')").run(wid,f.peer.id);
 assert.throws(()=>f.command('removePlan',{nodeId:node.id},wid,f.peer),/只读/);
 const removed=f.command('removePlan',{nodeId:node.id},wid),after=f.plans.get(wid);
 assert.equal(after.data.nodes[node.id],undefined);
 assert.ok(Object.values(after.data.notebook!).some(note=>note.spatialIds?.includes(asset.id)));
 assert.equal(f.maps.store.allowed(asset.id,f.peer.id,wid).id,asset.id);
 const dir=mkdtempSync(join(tmpdir(),'removed-place-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const backup=join(dir,'backup.db');await f.db.backup(backup);inspectBackup(backup);
 f.command('undo',{changeId:removed.changeId});assert.deepEqual(f.plans.get(wid).data,before.data);
});

test('along-route nearby resolves a permitted road position, validates indices before cache and separates cache centers',async t=>{
 const filters:string[]=[];
 const f=await fixture(t,{fetch:async(url,init)=>{
  const u=new URL(url);
  if(u.pathname==='/v2/places'){filters.push(u.searchParams.get('filter')!);return json({features:[]});}
  return fakeFetch(url,init);
 }});
 const wid=f.create(),a=(await f.search('first',wid)).assets[0],b=(await f.search('second',wid)).assets[0];
 const route=(await f.maps.query(f.owner.id,{action:'route',placeIds:[a.id,b.id],workspaceId:wid,requestId:randomUUID()})).assets[0];
 const input={action:'nearby',nearRouteId:route.id,routeCenterIndex:0,category:'museum',workspaceId:wid,requestId:randomUUID()};
 assert.equal((await f.maps.query(f.owner.id,input)).status,'no_match');
 assert.ok(filters[0].startsWith('circle:11.25,43.76,'));
 await f.maps.query(f.owner.id,{...input,routeCenterIndex:1,requestId:randomUUID()});
 assert.equal(filters.length,2);assert.notEqual(filters[0],filters[1]);
 await assert.rejects(f.maps.query(f.owner.id,{...input,routeCenterIndex:100,requestId:randomUUID()}),/位置无效/);
 await assert.rejects(f.maps.query(f.owner.id,{...input,nearRouteId:a.id,requestId:randomUUID()}),/步行路线/);
 await assert.rejects(f.maps.query(f.stranger.id,{...input,workspaceId:undefined,requestId:randomUUID()}));
 assert.equal(filters.length,2);
});

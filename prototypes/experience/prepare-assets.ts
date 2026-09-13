// Local review assets only. The source database is opened read-only; no sessions,
// conversations, user records, credentials or private plan text are exported.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { MapTransport } from '../../src/maps/transport.js';

const output = path.resolve('prototypes/experience/public');
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.copyFileSync('public/favicon.svg', path.join(output, 'favicon.svg'));
const db = new Database('.cache/map-integration/agent-qa/travel.db', { readonly: true });
const ids = ['d034dd86-a996-4a52-acb5-ceee0182cbc8', '27288673-d849-47ba-b647-e8a3f0b3e98f'];
const photos = ids.map((id, i) => {
  const row = db.prepare('SELECT metadata,bytes FROM media_assets WHERE id=?').get(id) as { metadata: string; bytes: Buffer };
  if (!row?.bytes) throw new Error('Required saved public photo missing');
  const m = JSON.parse(row.metadata);
  const file = `assets/uffizi-${i + 1}.webp`;
  fs.writeFileSync(path.join(output, file), row.bytes);
  return { file, sourceUrl: m.sourceUrl, sourceTitle: m.sourceTitle, retrievedAt: m.retrievedAt, sha256: m.sha256, license: m.license || 'Not established; retained for local review only.' };
});
const assets = (db.prepare('SELECT body FROM spatial_assets').all() as { body: string }[]).map(row => JSON.parse(row.body));
const places = assets.filter(a => ['8e60bf0f-7157-4b2d-9342-fc87dbea7bc8', 'b0718875-7070-45ae-97de-b75cf63a88a1', 'ed7c1f4b-b0e7-44b5-ba14-a0e534a7196a', '3c88f167-bdff-4a3a-8d83-81e08bed5cdd', '584d2d69-069c-4e66-bb4d-1b56e0750a2f'].includes(a.id)).map(a => ({ name: a.name, geometry: a.geometry, source: { url: a.source.url, retrievedAt: a.source.retrievedAt, attribution: a.source.attribution } }));
const routeResponse = JSON.parse(fs.readFileSync('tests/fixtures/maps/geoapify-florence-walk.json', 'utf8'));
const route = routeResponse.features[0];
const neri = route.properties.legs[0].steps.find((s: { name?: string }) => s.name === "Borgo de' Greci");
const coordinates = route.geometry.type === 'MultiLineString' ? route.geometry.coordinates.flat() : route.geometry.coordinates;
fs.writeFileSync(path.join(output, 'assets/map-data.json'), JSON.stringify({ route: { type: 'Feature', properties: { distanceMeters: route.properties.distance, movingSeconds: route.properties.time, sourceUrl: 'https://apidocs.geoapify.com/docs/routing/', retrievedAt: '2026-09-08' }, geometry: route.geometry }, streetPoint: coordinates[neri?.from_index ?? Math.floor(coordinates.length / 2)], streetName: neri?.name || '沿途街巷', places }));
fs.writeFileSync(path.join(output, 'assets/provenance.json'), JSON.stringify({ photos, geometry: 'Saved Geoapify/OSM results acquired 2026-09-08; source user database is read-only; composed schedule and recommendation text are fixed design samples.', route: 'tests/fixtures/maps/geoapify-florence-walk.json', scope: 'Local P1 review; no publication.' }, null, 2));
fs.copyFileSync(path.join(output, 'assets/map-data.json'), 'prototypes/experience/geometry.json');
db.close();
console.log('Exported two saved source photos and public geometry; no private records.');

// Small, bounded basemap capture for this fixed local review viewport.
// Reuse the application's budgeted, rate-limited transport; never export its key.
try { process.loadEnvFile(); } catch { /* Transport reports absent configuration. */ }
const ledgerPath = '.cache/experience-map-usage.db';
const ledger = new Database(ledgerPath);
ledger.exec('CREATE TABLE IF NOT EXISTS map_usage(day TEXT PRIMARY KEY,credits REAL NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0)');
const transport = new MapTransport(ledger, { dailyBudget: 5 });
const zoom = 16;
const tileX = (lng: number) => Math.floor((lng + 180) / 360 * 2 ** zoom);
const tileY = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom);
const bounds = [11.247, 43.765, 11.266, 43.773];
let captured = 0;
for (let x = tileX(bounds[0]); x <= tileX(bounds[2]); x++) {
  for (let y = tileY(bounds[3]); y <= tileY(bounds[1]); y++) {
    const filename = path.join(output, 'tiles', `${zoom}`, `${x}`, `${y}.png`);
    if (fs.existsSync(filename)) continue;
    const result = await transport.get(`https://maps.geoapify.com/v1/tile/positron/${zoom}/${x}/${y}.png`, .25, `${zoom}/${x}/${y}`);
    if (!result.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Tile response was not PNG');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, result.bytes);
    captured++;
  }
}
fs.writeFileSync(path.join(output, 'assets/tile-manifest.json'), JSON.stringify({ zoom, bounds, attribution: '© Geoapify · © OpenMapTiles · © OpenStreetMap contributors', capturedAt: new Date().toISOString(), usage: transport.usage() }, null, 2));
console.log(JSON.stringify({ captured, usage: transport.usage() }));
await transport.close();
ledger.close();
// Keep the captured Mercator tile coverage visible below zoom 16 on narrow screens.
// This is an exact 4×3 tile mosaic, with no new geography or remote requests.
const tileParts = [];
for (let x = 34815; x <= 34818; x++) {
  for (let y = 23887; y <= 23889; y++) {
    tileParts.push({ input: path.join(output, 'tiles/16', String(x), `${y}.png`), left: (x - 34815) * 256, top: (y - 23887) * 256 });
  }
}
await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#edf0f3' } })
  .composite(tileParts).png().toFile(path.join(output, 'assets/florence-basemap.png'));
process.exit(0);

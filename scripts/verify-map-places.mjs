// Real-service acceptance probe. Requires a production build and existing .env;
// it never creates or changes a user's workspace or calls a language model.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../dist/server/service/server/app.js';

const inputPath = 'tests/fixtures/place-sample-inputs.json';
const outputPath = process.argv[2] || 'docs/qa/map-integration/place-sample-first-run.json';
if (existsSync(outputPath)) throw new Error('Choose a new output path; preserve earlier acceptance results.');
const inputText = readFileSync(inputPath, 'utf8'), manifest = JSON.parse(inputText);
if (manifest.samples.length !== 20) throw new Error('Expected the frozen 20-row sample.');
const env = parseEnv(readFileSync('.env', 'utf8'));
if (!env.GEOAPIFY_API_KEY) throw new Error('Geoapify is not configured.');
const app = await createApp({ maps: { apiKey: env.GEOAPIFY_API_KEY, proxyUrl: env.MAPS_PROXY_URL, dailyBudget: 40 } });
const user = app.auth.create({ username: 'place-sample-qa', name: '地点独立样本', password: randomUUID() }, true);
const headers = { cookie: 'travel_session=' + app.auth.session(user), 'x-travel-app': '1', host: 'localhost' };
const hash = text => createHash('sha256').update(text).digest('hex');
const workspaceState = () => ({
  records: app.maps.db.prepare('SELECT id,version,data,deleted FROM workspaces ORDER BY id').all(),
  changes: app.maps.db.prepare('SELECT count(*) AS count FROM changes').get().count,
});
const before = workspaceState();
const report = {
  startedAt: new Date().toISOString(), inputPath, inputSha256: hash(inputText), frozenAt: manifest.frozenAt,
  sourceSha256: hash(readFileSync('src/maps/service.ts')), buildSha256: hash(readFileSync('dist/server/maps/service.js')),
  method: 'Actual authenticated application endpoint with Geoapify, in-memory isolated database; no model and no binding requests',
  workspaceBeforeSha256: hash(JSON.stringify(before)),
  anchors: [], samples: [], reviewStatus: 'pending independent semantic review',
};
const save = () => {
  const body = JSON.stringify(report, null, 2) + '\n';
  if (body.includes(env.GEOAPIFY_API_KEY)) throw new Error('Credential exposure detected.');
  writeFileSync(outputPath, body);
};
async function query(input) {
  const started = Date.now();
  const response = await app.app.inject({ method: 'POST', url: '/api/maps/queries', headers, payload: { ...input, action: 'search', requestId: randomUUID() } });
  return { httpStatus: response.statusCode, elapsedMs: Date.now() - started, result: response.json() };
}
const anchors = new Map();
try {
  for (const city of [...new Set(manifest.samples.map(s => s.nearCity).filter(Boolean))]) {
    const input = { text: city, context: 'Italy', country: 'it', searchType: 'city' };
    const response = await query(input);
    const names = city === 'Florence' ? ['florence', 'firenze'] : [city.toLowerCase()];
    const valid = (response.result.assets || []).filter(a => a.precision === 'city' && a.match?.countryCode === 'it' && [a.name, ...(a.match?.aliases || [])].some(n => names.includes(n.toLowerCase())));
    const record = { city, input, ...response, selectedAssetId: valid.length === 1 ? valid[0].id : null };
    report.anchors.push(record);
    if (record.selectedAssetId) anchors.set(city, record.selectedAssetId);
    save();
  }
  for (const sample of manifest.samples) {
    if (sample.nearCity && !anchors.has(sample.nearCity)) {
      report.samples.push({ id: sample.id, input: sample.input, status: 'anchor_unresolved', semanticReview: 'pending' });
    } else {
      const input = { ...sample.input, ...(sample.nearCity ? { nearPlaceId: anchors.get(sample.nearCity) } : {}) };
      const response = await query(input);
      report.samples.push({ id: sample.id, input, ...response, semanticReview: 'pending' });
      console.log(JSON.stringify({ id: sample.id, status: response.result.status, ms: response.elapsedMs, candidates: (response.result.assets || []).map(a => ({ name: a.name, category: a.category, address: a.address, city: a.match?.city })) }));
    }
    save();
  }
  report.finishedAt = new Date().toISOString();
  report.usage = app.maps.status();
  report.workspaceAfterSha256 = hash(JSON.stringify(workspaceState()));
  report.workspaceUnchanged = report.workspaceAfterSha256 === report.workspaceBeforeSha256;
  if (!report.workspaceUnchanged) throw new Error('Search unexpectedly changed workspace data or history.');
  report.workspaceWrites = 0;
  report.bindingExplanation = 'Only POST /api/maps/queries was called; no workspace or adoption endpoint was called. This verifies the endpoint workflow, not all future Agent behavior.';
  save();
} finally { await app.app.close(); }

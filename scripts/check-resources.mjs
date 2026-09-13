// Small, explicit resource probes. Uses public samples; never prints credentials or response bodies.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const authenticated = args.includes('--authenticated');
const modelTest = args.includes('--model-test');
const searchTest = args.includes('--search-test');
const codingPlanTest = args.includes('--coding-plan-test');
if (modelTest && !authenticated) throw new Error('--model-test requires --authenticated');
if (searchTest && !authenticated) throw new Error('--search-test requires --authenticated');
if (codingPlanTest && !authenticated) throw new Error('--coding-plan-test requires --authenticated');
const only = option('--only')?.split(',');
const envFile = resolve(option('--env-file') || '.env');
let fileConfig = {};
try { fileConfig = parseEnv(await readFile(envFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const value = (name) => process.env[name]?.trim() || fileConfig[name]?.trim() || '';
const keys = ['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'ZHIPU_CODING_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'GOOGLE_MAPS_API_KEY', 'OPENROUTESERVICE_API_KEY', 'TRIPADVISOR_API_KEY', 'VIATOR_API_KEY', 'GETYOURGUIDE_API_KEY'];
const credentials = Object.fromEntries(keys.map((name) => [name, Boolean(value(name))]));
const model = value('DEEPSEEK_MODEL') || 'deepseek-v4-flash';
const sampleCoordinates = [[11.2558, 43.7696], [11.2560, 43.7733]];
const probes = [
  { id: 'deepseek-models', capability: 'model_catalog', url: 'https://api.deepseek.com/models', key: 'DEEPSEEK_API_KEY', header: 'Authorization', prefix: 'Bearer ', kind: 'models' },
  { id: 'deepseek-tool-call', capability: 'model_tool_call', url: 'https://api.deepseek.com/chat/completions', key: 'DEEPSEEK_API_KEY', header: 'Authorization', prefix: 'Bearer ', kind: 'tool_call', modelTest: true,
    body: { model, thinking: { type: 'disabled' }, max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'Call record_probe with ready=true. This is a connectivity test, not a travel query.' }], tools: [{ type: 'function', function: { name: 'record_probe', description: 'Record a test result without external side effects.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false } } }], tool_choice: { type: 'function', function: { name: 'record_probe' } } } },
  { id: 'exa-search', capability: 'web_search', url: 'https://api.exa.ai/search', key: 'EXA_API_KEY', header: 'x-api-key', kind: 'search', body: { query: 'Florence Tuscany official tourism Uffizi', numResults: 3, type: 'auto' } },
  { id: 'deepseek-search', capability: 'native_web_search', url: 'https://api.deepseek.com/anthropic/v1/messages', key: 'DEEPSEEK_API_KEY', header: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' }, kind: 'native_search', searchTest: true,
    body: { model, max_tokens: 512, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Use web_search once to find the official Uffizi museum website. Return the source URL and a short title.' }] }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] } },
  { id: 'zhipu-endpoint', capability: 'model_endpoint_auth', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', kind: 'endpoint', authOnly: true, key: 'ZHIPU_API_KEY', header: 'Authorization', prefix: 'Bearer ', body: { model: value('ZHIPU_MODEL') || 'glm-5.2', max_tokens: 1, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Hi' }] } },
  { id: 'zhipu-tool-call', capability: 'model_tool_call', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: 'ZHIPU_API_KEY', header: 'Authorization', prefix: 'Bearer ', kind: 'tool_call', modelTest: true,
    body: { model: value('ZHIPU_MODEL') || 'glm-5.2', thinking: { type: 'disabled' }, max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'Call record_probe with ready=true. This is a connectivity test, not a travel query.' }], tools: [{ type: 'function', function: { name: 'record_probe', description: 'Record a test result without external side effects.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] } } }], tool_choice: 'auto' } },
  { id: 'google-places', capability: 'place_search', url: 'https://places.googleapis.com/v1/places:searchText', key: 'GOOGLE_MAPS_API_KEY', header: 'X-Goog-Api-Key', kind: 'places', headers: { 'X-Goog-FieldMask': 'places.id,places.displayName,places.location' }, body: { textQuery: 'Uffizi Gallery Florence Italy', languageCode: 'en', pageSize: 1 } },
  { id: 'google-routes', capability: 'walking_route', url: 'https://routes.googleapis.com/directions/v2:computeRoutes', key: 'GOOGLE_MAPS_API_KEY', header: 'X-Goog-Api-Key', kind: 'google_route', headers: { 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' }, body: { origin: { location: { latLng: { latitude: 43.7696, longitude: 11.2558 } } }, destination: { location: { latLng: { latitude: 43.7733, longitude: 11.2560 } } }, travelMode: 'WALK' } },
  { id: 'ors-walking', capability: 'walking_route', url: 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson', key: 'OPENROUTESERVICE_API_KEY', header: 'Authorization', kind: 'ors_route', body: { coordinates: sampleCoordinates } },
  { id: 'open-meteo-geocoding', capability: 'city_geocoding', url: 'https://geocoding-api.open-meteo.com/v1/search?name=Florence&count=5&language=en&format=json&countryCode=IT', kind: 'geocoding' },
  { id: 'open-meteo-weather', capability: 'weather', url: 'https://api.open-meteo.com/v1/forecast?latitude=43.7696&longitude=11.2558&current=temperature_2m,precipitation&daily=temperature_2m_max,precipitation_sum&forecast_days=1&timezone=Europe%2FRome', kind: 'weather' },
  { id: 'osrm-driving-demo', capability: 'driving_route_demo', url: 'https://router.project-osrm.org/route/v1/driving/11.2558,43.7696;11.3308,43.3188?overview=false&steps=false&generate_hints=false', kind: 'osrm_route', limitation: 'Single non-commercial demo query; no live traffic, departure time, availability, or production SLA. OSM attribution required.' },
  { id: 'uffizi-official', capability: 'official_visit_information', url: 'https://www.uffizi.it/en/the-uffizi', kind: 'page', markers: ['uffizi', 'opening', 'ticket'] },
  { id: 'visit-tuscany-scenic', capability: 'destination_experience_content', url: 'https://www.visittuscany.com/en/ideas/panoramic-roads-tuscany-5-itineraries/', kind: 'page', markers: ['tuscany', 'road', 'chiusure'] },
  { id: 'visit-tuscany-florence', capability: 'destination_itinerary', url: 'https://www.visittuscany.com/en/itineraries/3-days-in-florence-trip-plan/', kind: 'page', markers: ['florence', 'uffizi', 'michelangelo'] },
  { id: 'thefork-restaurant', capability: 'restaurant_menu_reviews', url: 'https://www.thefork.com/restaurant/alla-griglia-r62332', kind: 'page', markers: ['griglia', 'menu', 'review'] },
  { id: 'trenitalia-official', capability: 'operator_information', url: 'https://www.trenitalia.com/en/information/online-ticket.html', kind: 'page', markers: ['ticket', 'train', 'online'] },
  { id: 'rome-ztl-official', capability: 'official_local_rules', url: 'https://romamobilita.it/servizi-al-pubblico/ztl/', kind: 'page', markers: ['ztl', 'access', 'orari'] },
  { id: 'visit-florence-guide', capability: 'specialist_travel_content', url: 'https://www.visitflorence.com/florence-museums/uffizi-gallery.html', kind: 'page', markers: ['uffizi', 'museum', 'visit'] },
  { id: 'wikimedia-media-metadata', capability: 'media_discovery_metadata', url: 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=Uffizi%20Florence&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url%7Cextmetadata&format=json', kind: 'media' },
  { id: 'wikivoyage-guide', capability: 'travel_guide_search_and_read', url: 'https://en.wikivoyage.org/w/api.php?action=query&generator=search&gsrsearch=Florence&gsrnamespace=0&gsrlimit=1&prop=revisions%7Cinfo&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&inprop=url&format=json&formatversion=2&maxlag=5', kind: 'wiki_guide', expectedTitle: 'Florence', markers: ['Understand', 'Get in', 'See'] },
  { id: 'wikipedia-context', capability: 'encyclopedic_context_read', url: 'https://en.wikipedia.org/w/api.php?action=query&titles=Uffizi&prop=revisions%7Cinfo&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&inprop=url&format=json&formatversion=2&maxlag=5', kind: 'wiki_guide', expectedTitle: 'Uffizi', markers: ['Florence', 'museum', 'Medici'] },
  { id: 'wikidata-entity-search', capability: 'cultural_entity_search', url: 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Uffizi&language=en&uselang=en&limit=3&format=json&maxlag=5', kind: 'wikidata_search' },
  { id: 'rick-steves-forum-index', capability: 'travel_forum_index', url: 'https://www.ricksteves.com/travel-forum', kind: 'page', markers: ['forum', 'europe', 'trip'], limitation: 'Forum index only; no topic search, individual post, or comment retrieval tested.' },
  { id: 'atlas-obscura-index', capability: 'specialist_discovery_index', url: 'https://www.atlasobscura.com/', kind: 'page', markers: ['places', 'rome', 'wonders'], limitation: 'Homepage only; no programmatic search or individual place content tested.' },
  { id: 'seat61-italy-guide', capability: 'specialist_rail_guide', url: 'https://www.seat61.com/Italy.htm', kind: 'page', markers: ['italy', 'train', 'florence'], limitation: 'Travel guide only; not an operator timetable, live fare, inventory, or booking API.' },
];

const zhipuTemplate = probes.find((probe) => probe.id === 'zhipu-tool-call');
probes.push({ ...zhipuTemplate, id: 'zhipu-coding-tool-call', capability: 'coding_plan_tool_call_probe', url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', key: 'ZHIPU_CODING_API_KEY', modelTest: false, codingPlanTest: true, body: { ...zhipuTemplate.body, model: value('ZHIPU_CODING_MODEL') || 'glm-5.2', messages: [{ role: 'user', content: 'This is a development connectivity test. Call record_probe with ready=true.' }] }, limitation: 'One user-requested Coding Plan diagnostic. A successful response does not establish permission for use in the travel application.' });

function inspect(probe, body) {
  if (probe.kind === 'page') {
    const { document } = parseHTML(body);
    for (const node of document.querySelectorAll('script,style,noscript,nav,header,footer')) node.remove();
    const text = (document.documentElement?.textContent || '').replace(/\s+/g, ' ').trim();
    const title = (document.querySelector('title')?.textContent || document.querySelector('h1')?.textContent || '').trim().slice(0,140);
    if (/just a moment|access denied|attention required|captcha|robot check/i.test(title) || /verify you are human|enable JavaScript and cookies to continue/i.test(text)) return { status: 'blocked_or_challenge', details: { title } };
    const matchedMarkers = probe.markers.filter((marker) => text.toLowerCase().includes(marker));
    return { status: text.length > 1000 && matchedMarkers.length >= 2 ? 'page_content_observed' : 'content_unverified', details: { title, textCharacters: text.length, matchedMarkers, note: 'Content markers only; no date-specific facts, review samples, or booking availability validated.' } };
  }
  let data;
  try { data = JSON.parse(body); } catch { return { status: 'invalid_response', details: { reason: 'Expected JSON' } }; }
  switch (probe.kind) {
    case 'wiki_guide': {
      const page = data.query?.pages?.find((p) => p.title === probe.expectedTitle);
      const revision = page?.revisions?.[0];
      const content = revision?.slots?.main?.content || '';
      const matchedMarkers = probe.markers.filter((marker) => content.toLowerCase().includes(marker.toLowerCase()));
      return { status: page?.pageid && revision?.revid && content.length > 1000 && matchedMarkers.length === probe.markers.length ? 'api_sample_passed' : 'content_unverified', details: { title: page?.title, pageId: page?.pageid, sourceUrl: page?.fullurl, revisionId: revision?.revid, revisionTimestamp: revision?.timestamp, contentCharacters: content.length, matchedMarkers, note: 'Article and revision observed. Wikitext needs extraction; no date-specific travel fact verified. Retain source and license metadata.' } };
    }
    case 'wikidata_search': {
      const results = data.search?.map((s) => ({ id: s.id, label: s.label, description: s.description, sourceUrl: s.concepturi }));
      return { status: results?.some((s) => /^Q\d+$/.test(s.id) && /uffizi/i.test(s.label)) ? 'api_sample_passed' : 'content_unverified', details: { results, note: 'Entity candidates only; coordinates and cross-source identity not verified.' } };
    }
    case 'endpoint': return { status: 'content_unverified', details: { note: 'Unauthenticated endpoint probe; no model capability asserted.' } };
    case 'native_search': {
      const blocks = data.content?.filter((b) => b.type === 'web_search_tool_result') || [];
      const sources = blocks.flatMap((b) => Array.isArray(b.content) ? b.content : []).filter((s) => s.type === 'web_search_result' && /^https?:\/\//.test(s.url));
      return { status: sources.length ? 'api_sample_passed' : 'content_unverified', details: { sources: sources.map((s) => ({ title: s.title, url: s.url })), usage: data.usage, note: 'Requires actual structured search result blocks; prose URLs alone do not pass. Direct protocol probe, not Harness integration.' } };
    }
    case 'models': return { status: Array.isArray(data.data) && data.data.length ? 'api_sample_passed' : 'content_unverified', details: { modelIds: data.data?.map((m) => m.id), note: 'Model listing does not verify generation or tool calls.' } };
    case 'tool_call': {
      const tool = data.choices?.[0]?.message?.tool_calls?.[0];
      let toolArgs; try { toolArgs = JSON.parse(tool?.function?.arguments || '{}'); } catch { toolArgs = null; }
      return { status: tool?.function?.name === 'record_probe' && toolArgs?.ready === true ? 'api_sample_passed' : 'content_unverified', details: { model: data.model, finishReason: data.choices?.[0]?.finish_reason, toolName: tool?.function?.name, argumentsValid: toolArgs?.ready === true, usage: data.usage } };
    }
    case 'search': return { status: data.results?.some((r) => /^https?:\/\//.test(r.url)) ? 'api_sample_passed' : 'content_unverified', details: { results: data.results?.map((r) => ({ title: r.title, url: r.url })), note: 'Search results do not prove full text retrieval.' } };
    case 'places': return { status: data.places?.some((p) => p.id && Number.isFinite(p.location?.latitude)) ? 'api_sample_passed' : 'content_unverified', details: { results: data.places?.map((p) => ({ id: p.id, name: p.displayName?.text, location: p.location })), note: 'No reviews, photos or opening fields requested.' } };
    case 'google_route': return { status: data.routes?.[0]?.distanceMeters > 0 && data.routes?.[0]?.duration ? 'api_sample_passed' : 'content_unverified', details: { route: data.routes?.[0], travelMode: 'WALK' } };
    case 'ors_route': return { status: data.features?.[0]?.properties?.summary?.distance > 0 ? 'api_sample_passed' : 'content_unverified', details: { summary: data.features?.[0]?.properties?.summary, profile: 'foot-walking' } };
    case 'geocoding': {
      const city = data.results?.find((r) => r.country_code === 'IT' && /^(florence|firenze)$/i.test(r.name) && r.admin1 === 'Tuscany' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && /^PPL/.test(r.feature_code) && r.feature_code !== 'PPLX');
      return { status: city ? 'api_sample_passed' : 'content_unverified', details: { city, candidates: data.results?.map((r) => ({ name: r.name, country: r.country_code, region: r.admin1, featureCode: r.feature_code })), note: 'Exact city and region match required; a similarly named district does not pass. Not a restaurant or museum POI service.' } };
    }
    case 'weather': return { status: Number.isFinite(data.current?.temperature_2m) && data.daily?.time?.length === 1 && data.timezone === 'Europe/Rome' ? 'api_sample_passed' : 'content_unverified', details: { timezone: data.timezone, current: data.current, currentUnits: data.current_units, daily: data.daily, dailyUnits: data.daily_units } };
    case 'osrm_route': return { status: data.code === 'Ok' && data.routes?.[0]?.distance > 0 && data.routes?.[0]?.duration > 0 ? 'demo_sample_passed' : 'content_unverified', details: { code: data.code, distanceMeters: data.routes?.[0]?.distance, durationSeconds: data.routes?.[0]?.duration, waypoints: data.waypoints?.map((w) => ({ name: w.name, location: w.location })), attribution: '© OpenStreetMap contributors; route served by the OSRM demonstration service.' } };
    case 'media': {
      const page = Object.values(data.query?.pages || {})[0];
      const info = page?.imageinfo?.[0];
      return { status: info?.descriptionurl && info?.extmetadata?.LicenseShortName?.value ? 'api_sample_passed' : 'content_unverified', details: { title: page?.title, sourcePage: info?.descriptionurl, license: info?.extmetadata?.LicenseShortName?.value, note: 'Metadata only; no image downloaded and no travel image match approved.' } };
    }
    default: throw new Error(`Unknown probe kind: ${probe.kind}`);
  }
}

async function run(probe) {
  const base = { id: probe.id, capability: probe.capability, url: probe.url, method: probe.body ? 'POST' : 'GET', sampleInput: probe.body || null, credentialName: probe.key || null, credentialPresent: probe.key ? credentials[probe.key] : null, authenticated: Boolean(probe.key && authenticated && credentials[probe.key] && !probe.authOnly), checkedAt: new Date().toISOString(), limitation: probe.limitation || null };
  if (probe.modelTest && (!modelTest || !base.authenticated)) return { ...base, status: 'not_tested', reason: !credentials[probe.key] ? 'Missing model credential' : 'Requires --authenticated --model-test' };
  if (probe.searchTest && (!searchTest || !base.authenticated)) return { ...base, status: 'not_tested', reason: !credentials[probe.key] ? 'Missing search credential' : 'Requires --authenticated --search-test' };
  if (probe.codingPlanTest && (!codingPlanTest || !base.authenticated)) return { ...base, status: 'not_tested', reason: !credentials[probe.key] ? 'Missing Coding Plan credential' : 'Requires --authenticated --coding-plan-test' };
  const headers = { 'User-Agent': 'travel-assistant-resource-check/0.1 (local development; single sample)', ...probe.headers };
  if (probe.body) headers['Content-Type'] = 'application/json';
  if (base.authenticated) headers[probe.header] = (probe.prefix || '') + value(probe.key);
  const start = Date.now();
  try {
    const response = await fetch(probe.url, { method: base.method, headers, body: probe.body ? JSON.stringify(probe.body) : undefined, redirect: base.authenticated ? 'manual' : 'follow', signal: AbortSignal.timeout(probe.modelTest || probe.searchTest || probe.codingPlanTest ? 30000 : 15000) });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 2_000_000) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    const transport = { httpStatus: response.status, effectiveUrl: response.url, contentType: response.headers.get('content-type'), responseBytes: bytes, durationMs: Date.now() - start, sha256: createHash('sha256').update(raw).digest('hex') };
    if (!response.ok) {
      const authResponse = Boolean(probe.key) && [401, 403].includes(response.status) && /auth|api.?key|credential|permission|unregistered caller/i.test(body) && !/captcha|just a moment|verify you are human/i.test(body);
      return { ...base, ...transport, status: authResponse ? (base.authenticated ? 'credential_or_permission_rejected' : 'reachable_auth_required') : 'http_error', reason: authResponse ? 'Endpoint responded with an authentication/permission error; capability not verified.' : 'Non-success HTTP response; capability not verified.' };
    }
    return { ...base, ...transport, ...inspect(probe, body) };
  } catch (error) { return { ...base, durationMs: Date.now() - start, status: 'transport_failed', error: { name: error.name, code: error.cause?.code || (error.message === 'RESPONSE_TOO_LARGE' ? error.message : null) } }; }
}

const selected = only ? probes.filter((p) => only.includes(p.id)) : probes;
if (only?.some((id) => !probes.some((p) => p.id === id))) throw new Error('Unknown --only probe id');
const startedAt = new Date().toISOString();
const results = [];
// Each batch has different endpoints; the public OSRM instance receives one request in a run.
for (let offset = 0; offset < selected.length; offset += 3) {
  const batch = await Promise.allSettled(selected.slice(offset, offset + 3).map(run));
  for (const result of batch) {
    if (result.status !== 'fulfilled') throw result.reason;
    results.push(result.value);
    console.log(`${result.value.id}: ${result.value.status}${result.value.httpStatus ? ` (HTTP ${result.value.httpStatus})` : ''}`);
  }
}
const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch }, credentials, authenticatedMode: authenticated, modelTestRequested: modelTest, searchTestRequested: searchTest, codingPlanTestRequested: codingPlanTest, notes: ['Public synthetic inputs only; no user itinerary or credential values recorded.', 'Direct Node fetch probes, not calls through the Harness provider.', 'A single sample does not validate sustained access, production permission, or destination-wide coverage.'], results };
const defaultOutput = `docs/qa/resource-check-${startedAt.replace(/[:.]/g, '-')}.json`;
const output = resolve(option('--output') || defaultOutput);
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`Saved ${output}`);

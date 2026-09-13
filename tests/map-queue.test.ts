import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.js';
import { MapTransport } from '../src/maps/transport.js';

test('interactive map queries make progress during a tile burst without bypassing the shared rate limit', async t => {
  const db = openDatabase(':memory:');
  const starts: { kind: string; at: number }[] = [];
  const transport = new MapTransport(db, { apiKey: 'queue-test', fetch: async url => {
    starts.push({ kind: new URL(url).hostname === 'api.geoapify.com' ? 'query' : 'resource', at: Date.now() });
    return new Response('{}');
  } });
  t.after(async () => { await transport.close(); db.close(); });
  const cancel = new AbortController();
  const tiles = Array.from({ length: 40 }, (_, i) => transport.get(`https://maps.geoapify.com/v1/tile/vector/14/${i}/0.pbf`, .25, `resource:${i}`, { signal: cancel.signal }));
  const settled = Promise.allSettled(tiles);
  const begun = Date.now();
  try {
    await transport.get('https://api.geoapify.com/v1/geocode/search?text=sample', 1, 'query:sample');
    assert.ok(Date.now() - begun < 1500, 'tile backlog must not consume the query deadline');
  } finally { cancel.abort(); await settled; }
  assert.ok(starts.findIndex(x => x.kind === 'query') <= 3);
  for (let i = 4; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 4].at >= 1000);
  assert.equal(transport.usage().requests, starts.length, 'cancelled queued tiles must not debit usage');
});

test('query priority still lets resources progress and retries stop at the common budget', async t => {
  const db = openDatabase(':memory:');
  const starts: { kind: string; at: number }[] = [];
  const transport = new MapTransport(db, { apiKey: 'queue-test', dailyBudget: 4.25, fetch: async url => {
    starts.push({ kind: new URL(url).hostname === 'api.geoapify.com' ? 'query' : 'resource', at: Date.now() });
    return new Response('{}', { status: 429, headers: { 'retry-after': '0.5' } });
  } });
  t.after(async () => { await transport.close(); db.close(); });
  await Promise.allSettled([
    ...Array.from({ length: 8 }, (_, i) => transport.get(`https://api.geoapify.com/v1/geocode/search?text=${i}`, 1, `query:${i}`)),
    transport.get('https://maps.geoapify.com/v1/tile/vector/1/0/0.pbf', .25, 'resource:one'),
  ]);
  assert.ok(starts.findIndex(x => x.kind === 'resource') <= 3, 'resources must not starve behind query priority');
  for (let i = 4; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 4].at >= 1000);
  assert.ok(transport.usage().credits <= 4.25);
  assert.equal(transport.usage().requests, starts.length);
  const before = starts.length;
  await assert.rejects(transport.get('https://api.geoapify.com/v1/geocode/search?text=more', 1, 'query:more'), /预算/);
  assert.equal(starts.length, before);
});

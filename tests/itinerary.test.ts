import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFields, type PlanNode, type WorkspaceData } from '../src/shared/model.js';
import { itineraryGroups, itineraryNodes } from '../src/shared/itinerary.js';
import { bindingStale, spatialDependency, type SpatialBinding } from '../src/shared/maps.js';

function node(id: string, order: number, dates = {}, parentId: string | null = 'root'): PlanNode {
  return { ...nodeFields.parse({ title: id, dates }), id, parentId, order };
}
function workspace(nodes: PlanNode[]): WorkspaceData {
  return { rootId: 'root', kind: 'trip', nodes: Object.fromEntries([node('root', 0, {}, null), ...nodes].map(n => [n.id, n])), preparations: {}, progress: {}, sample: false };
}
const fixed = (day: string, time = '', end = day) => ({ mode: 'fixed', start: day, end, startTime: time });

test('plan and map use chronological direct-child order without duplicating a multiday plan', () => {
  const data = workspace([
    node('late', 0, fixed('2026-10-02', '15:00')),
    node('early', 1, fixed('2026-10-02', '09:00')),
    node('multiday', 2, fixed('2026-10-01', '', '2026-10-03')),
    node('inside', 0, fixed('2026-10-02', '08:00'), 'early'),
    node('untimed', 3, fixed('2026-10-02')),
  ]);
  const before = JSON.stringify(data);
  const groups = itineraryGroups(data, 'root');
  assert.deepEqual(groups.flatMap(g => g.nodes.map(n => n.id)), ['multiday', 'early', 'late', 'untimed']);
  assert.equal(groups.at(-1)?.label, '2026-10-02 · 时间待定');
  assert.deepEqual(itineraryNodes(data, 'root').map(n => n.id), ['root', 'multiday', 'early', 'inside', 'late', 'untimed']);
  assert.equal(JSON.stringify(data), before, 'presentation must not alter persisted order or dates');
});

test('unknown dates, windows and durations preserve their existing sequence', () => {
  const data = workspace([
    node('day-two', 2), node('day-one', 1),
    node('window', 3, { mode: 'window', start: '2026-10-01', end: '2026-10-05' }),
    node('duration', 4, { mode: 'duration', minDays: 2, maxDays: 3 }),
  ]);
  const groups = itineraryGroups(data, 'root');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].nodes.map(n => n.id), ['day-one', 'day-two', 'window', 'duration']);
  assert.equal(groups[0].label, '已排顺序 · 日期待定');
});

test('equal times keep the saved sequence and pending plans remain after dated plans', () => {
  const data = workspace([node('pending', 0), node('second', 2, fixed('2026-10-01', '09:00')), node('first', 1, fixed('2026-10-01', '09:00'))]);
  assert.deepEqual(itineraryGroups(data, 'root').flatMap(g => g.nodes.map(n => n.id)), ['first', 'second', 'pending']);
  assert.deepEqual(itineraryGroups(data, 'missing'), []);
});

test('saved route becomes stale after schedule or matched-place changes, but not prose edits', () => {
  const data = workspace([node('stop', 0, fixed('2026-10-01', '09:00'))]);
  const binding: SpatialBinding = { assetId: 'route', primary: false, optional: false, nodeIds: ['stop'], mediaIds: [], dependency: spatialDependency(data, ['stop']) };
  data.nodes.stop.notes = 'A new introduction';
  assert.equal(bindingStale(data, binding), false);
  data.nodes.stop.dates.startTime = '10:00';
  assert.equal(bindingStale(data, binding), true);
  binding.dependency = spatialDependency(data, ['stop']);
  data.spatial = { stop: [{ assetId: 'new-place', primary: true, optional: false, nodeIds: [], mediaIds: [] }] };
  assert.equal(bindingStale(data, binding), true);
});

test('adding or replacing a sibling stop invalidates a saved route without editing existing stops', () => {
  const data=workspace([node('a',0),node('b',1)]);
  const binding:SpatialBinding={assetId:'route',primary:false,optional:false,mediaIds:[],nodeIds:['a','b'],dependency:spatialDependency(data,['a','b'])};
  data.nodes.c=node('c',2);
  assert.equal(bindingStale(data,binding),true);
  binding.dependency=spatialDependency(data,['a','b']);
  delete data.nodes.c;data.nodes.d=node('d',2);
  assert.equal(bindingStale(data,binding),true);
});

test('different zones sort by actual instant across local calendar dates without changing source dates',()=>{
 const data=workspace([
  node('new-york',0,{...fixed('2026-10-01','23:00'),timezone:'America/New_York'}),
  node('rome',1,{...fixed('2026-10-02','04:00'),timezone:'Europe/Rome'}),
 ]);
 data.nodes.root.dates.timezone='Europe/Rome';
 const before=JSON.stringify(data),groups=itineraryGroups(data,'root');
 assert.deepEqual(groups.flatMap(group=>group.nodes.map(node=>node.id)),['rome','new-york']);
 assert.equal(groups.length,1);assert.equal(groups[0].label,'2026-10-02 · 按 Europe/Rome 排序');
 assert.equal(JSON.stringify(data),before);
});

test('ambiguous and missing daylight-saving times are flagged instead of guessing their order',()=>{
 const data=workspace([
  node('ambiguous',0,{...fixed('2026-11-01','01:30'),timezone:'America/New_York'}),
  node('missing',1,{...fixed('2026-03-08','02:30'),timezone:'America/New_York'}),
  node('valid',2,{...fixed('2026-03-08','03:30'),timezone:'America/New_York'}),
 ]);
 const groups=itineraryGroups(data,'root');
 assert.deepEqual(groups[0].nodes.map(node=>node.id),['valid']);
 assert.equal(groups[1].key,'uncertain-clock');
 assert.deepEqual(groups[1].nodes.map(node=>node.id),['ambiguous','missing']);
});

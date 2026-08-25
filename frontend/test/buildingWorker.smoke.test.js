/**
 * End-to-end smoke test for the building worker.
 *
 * WHY THIS EXISTS. On 2026-08-25 the P3-01 pre-pass referenced `cx`/`cy` — which are the BUILDING's
 * centroid, computed per-building INSIDE the main loop — from outside that loop. Every tile threw a
 * ReferenceError and NOT ONE BUILDING RENDERED IN THE CITY. Fifteen unit tests on the geometry
 * functions passed throughout, because none of them ever called the worker.
 *
 * The lesson: unit-testing the pieces proves nothing about the pipeline. This test calls the real
 * entry point with real-shaped input and asserts geometry comes out the other end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { processBuildingsInWorker } from '../src/workers/buildingWorker.js';

const square = (s = 12) => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
const mk = (id, height, type = 'residential') =>
  ({ id, footprint: square(), height, type, shapeType: 'polygon' });
const run = (buildings) =>
  processBuildingsInWorker({ buildings, roads: [], cx: 0, cy: 0, tileId: '16_0_0' }, {});

test('the worker produces wall geometry — the city is not empty', () => {
  const r = run([mk(1, 21)]);
  assert.ok(r?.buildingGroups?.length, 'no buildingGroups came back');
  const g = r.buildingGroups[0];
  assert.ok(g.positions?.length > 0, 'a building group with no positions is an invisible building');
  assert.ok(g.indices?.length > 0, 'no indices — nothing would rasterise');
});

test('it does not throw on the height range a real tile contains', () => {
  // The bug threw on EVERY building; a single tall test case would have caught it, and there was none.
  for (const h of [2, 3.8, 4, 5, 9, 15, 21, 30, 55, 120]) {
    assert.doesNotThrow(() => run([mk(1, h)]), `threw at height ${h} m`);
  }
});

test('it does not throw for any painted category', () => {
  for (const type of ['residential', 'commercial', 'office', 'hospital', 'school', 'industrial', 'religious', 'retail']) {
    assert.doesNotThrow(() => run([mk(1, 21, type)]), `threw for ${type}`);
  }
});

test('v3 P3-02: a normal building emits 3 storey bands per face', () => {
  const g = run([mk(1, 21)]).buildingGroups[0];
  assert.equal(g.positions.length / 3, 4 * 3 * 4, '4 edges x 3 bands x 4 verts');
});

test('v3 P3-02: a short building degrades to fewer bands rather than throwing', () => {
  const g = run([mk(1, 4)]).buildingGroups[0];
  const verts = g.positions.length / 3;
  assert.ok(verts > 0 && verts < 4 * 3 * 4, `expected fewer than 3 bands, got ${verts / 16} bands/face`);
});

test('many buildings at once — the fair-share budget path does not throw', () => {
  // P3-01's pre-pass runs over the whole tile before the main loop; exercise it with a crowd.
  const many = Array.from({ length: 200 }, (_, i) => mk(i + 1, 8 + (i % 40)));
  assert.doesNotThrow(() => run(many));
  const r = run(many);
  assert.ok(r.buildingGroups?.length, 'a dense tile produced nothing');
});

test('degenerate input is survived, not thrown on', () => {
  assert.doesNotThrow(() => run([]));
  assert.doesNotThrow(() => run([{ id: 1, footprint: [], height: 10, type: 'residential' }]));
  assert.doesNotThrow(() => run([{ id: 2, footprint: square(), height: 0, type: 'residential' }]));
});

test('v3 P3-04: aLayer survives the whole worker path to the group', () => {
  // It did not, first time. The bands emitted `layers` and mergeBufferSets carried them, but the
  // group-assembly object literal listed attributes by hand and simply did not mention them — so the
  // attribute reached the GPU as nothing at all. Unit tests on the two halves both passed.
  const r = run([mk(902208621, 21), mk(20353556, 21), mk(7, 21)]);
  const g = r.buildingGroups[0];
  assert.ok(g.layers, 'group.layers is missing — the attribute is being dropped in assembly');
  assert.equal(g.layers.length, g.positions.length / 3, 'one layer index per vertex');
});

test('v3 P3-04: different buildings get different facade variants', () => {
  // A single-variant city is the failure mode where the hash is broken but nothing errors.
  const many = Array.from({ length: 60 }, (_, i) => mk(1000 + i * 7, 21));
  const g = run(many).buildingGroups[0];
  const distinct = new Set(g.layers);
  assert.ok(distinct.size >= 3, `only ${distinct.size} variant(s) across 60 buildings — hash is clustering`);
});

test('v3 P3-04: every layer index is inside the 8-layer array', () => {
  const g = run(Array.from({ length: 40 }, (_, i) => mk(i + 1, 21))).buildingGroups[0];
  for (const l of g.layers) {
    assert.ok(Number.isInteger(l) && l >= 0 && l < 8, `layer ${l} is outside the array — samples garbage`);
  }
});

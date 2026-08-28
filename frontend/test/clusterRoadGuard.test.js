/**
 * N-9 — rocks and bushes were being placed ON the carriageway.
 *
 * Every cluster item WAS already checked with `isVegetationAllowed(vegMask, x, z, 4)`. That looked
 * like a road guard and was not one: the mask is a grid over the tile plus a pad, and
 * `isVegetationAllowed` returns TRUE for anything OUTSIDE that grid. Correct for "we do not know",
 * wrong as the last word before placing a rock — so a cluster centre near a tile edge scattered
 * items past the grid boundary and every one of them was waved through.
 *
 * It stayed invisible because cluster LOD used `dist` (distance to the tile CENTRE, which includes
 * camera altitude) against TREE_MAX_DISTANCE = 170 m: from any height the clusters were never
 * DRAWN. Commit 917c625 moved that to `nearEdgeDist` and the pre-existing placement bug surfaced.
 *
 * `isOnAnyRoad` is the direct geometric test that replaces the assumption. It is pinned here
 * because it was written twice before anyone checked whether it fired.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
// ONE shared copy in vegetationMask.js — imported by environmentClusterRenderer AND
// propRenderer. Today produced four cases of identical logic living in two files and diverging,
// so this guard is deliberately not duplicated.
import { __test__ } from '../src/map/vegetationMask.js';

const { isOnAnyRoad } = __test__;

/** Frontend road records: points are {x, y} where y is world Z. */
const road = (kerbToKerbW, sidewalkW, points, extra = {}) => ({
  id: 1, highwayType: 'residential',
  kerbToKerbW, width: kerbToKerbW, carriagewayW: kerbToKerbW,
  parkingLeftW: 0, parkingRightW: 0, shoulderW: 0,
  sidewalkW, corridorW: kerbToKerbW + sidewalkW * 2,
  layer: 0, points, ...extra,
});
// A 10.4 m residential with 3 m pavements: corridor 16.4 m, so the guard rejects within 8.2 m.
const eastWest = road(10.4, 3, [{ x: -100, y: 0 }, { x: 100, y: 0 }]);

test('a rock on the centreline is rejected', () => {
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, 0), true);
});

test('a rock anywhere across the carriageway is rejected', () => {
  for (const z of [-5, -2, 0, 2, 5]) {
    assert.equal(isOnAnyRoad({ roads: [eastWest] }, 10, z), true, `z=${z} is on the asphalt`);
  }
});

test('THE PAVEMENT IS ALLOWED — a street tree lives there', () => {
  // Guarding at corridorWidth (kerb-to-kerb PLUS both pavements) deleted every plane tree on
  // Gran Via along with the rocks. The thing to keep clear is the ASPHALT.
  // 5.2 m kerb + 0.3 m allowance = 5.5 m; a tree pit at 6.5 m is on the pavement and must survive.
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, 6.5), false);
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, -6.5), false);
});

test('the kerb allowance keeps items from sitting half on the asphalt', () => {
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, 5.4), true, 'inside kerb + 0.3 m');
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, 5.6), false, 'clear of it');
});

test('ground well clear of the road is allowed — the guard must not sterilise the city', () => {
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, 12), false);
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 0, -12), false);
});

test('past the END of a road is allowed — segment distance, not infinite line', () => {
  // The line through the road continues, but the polyline stops at x=100.
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 140, 0), false);
  assert.equal(isOnAnyRoad({ roads: [eastWest] }, 101, 0), true, 'just past the end is still within half');
});

test('tunnels and other layers are ignored — a rock above a tunnel is on the ground', () => {
  const tunnel = road(10.4, 3, [{ x: -100, y: 0 }, { x: 100, y: 0 }], { tunnel: true });
  const upper  = road(10.4, 3, [{ x: -100, y: 0 }, { x: 100, y: 0 }], { layer: 1 });
  assert.equal(isOnAnyRoad({ roads: [tunnel] }, 0, 0), false);
  assert.equal(isOnAnyRoad({ roads: [upper] }, 0, 0), false);
});

test('non-drivable ways do not block — a rock beside a footpath is fine', () => {
  const path = road(2, 0, [{ x: -100, y: 0 }, { x: 100, y: 0 }], { highwayType: 'footway' });
  assert.equal(isOnAnyRoad({ roads: [path] }, 0, 0), false);
});

test('THE ACTUAL BUG: an item beyond the mask grid is still rejected by geometry', () => {
  // The mask says "allowed" for anything off-grid. This test stands in for that case: the guard
  // must not consult the mask at all, only the road geometry it was given.
  const far = road(14.15, 3.5, [{ x: 9000, y: 9000 }, { x: 9200, y: 9000 }]);
  assert.equal(isOnAnyRoad({ roads: [far] }, 9100, 9000), true,
    'distance from any grid is irrelevant — the point is on a carriageway');
});

test('empty or missing road data is safe', () => {
  assert.equal(isOnAnyRoad({ roads: [] }, 0, 0), false);
  assert.equal(isOnAnyRoad({}, 0, 0), false);
  assert.equal(isOnAnyRoad(null, 0, 0), false);
});

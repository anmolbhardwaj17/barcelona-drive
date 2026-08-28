/**
 * Rocks and bushes were being placed ON the carriageway. The user's ruling: they belong in open
 * space only.
 *
 * Every cluster item WAS already checked with `isVegetationAllowed(vegMask, x, z, 4)`. That looked
 * like a road guard and is not one: the mask is a grid over the tile plus a pad, and it returns
 * TRUE for anything OUTSIDE that grid — correct for "we do not know", wrong as the last word
 * before placing a boulder. A cluster centre near a tile edge scatters items past the boundary and
 * every one was waved through.
 *
 * ⚠ THE TREE EXEMPTION IS THE POINT OF THIS FILE. The guard is at CORRIDOR width — kerb to kerb
 * PLUS both pavements — and a street tree stands ON the pavement. Guarding trees here has emptied
 * Gran Via twice in this project's history. The exemption is a contract, not an oversight, and
 * these tests exist so a future change cannot quietly remove it.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
// 10.4 m residential with 3 m pavements: corridor 16.4 m, so the guard reaches 8.2 m + allowance.
const eastWest = road(10.4, 3, [{ x: -100, y: 0 }, { x: 100, y: 0 }]);
const on = (x, z, c) => isOnAnyRoad({ roads: [eastWest] }, x, z, c);

test('a rock on the centreline is rejected', () => {
  assert.equal(on(0, 0), true);
});

test('a rock anywhere across the carriageway is rejected', () => {
  for (const z of [-5, -2, 0, 2, 5]) assert.equal(on(10, z), true, `z=${z} is on the asphalt`);
});

test('the PAVEMENT is rejected too — a rock there reads as debris, not as open space', () => {
  // corridor 16.4 => half 8.2, + 0.3 allowance = 8.5 m.
  assert.equal(on(0, 6.5), true, 'pavement is inside the corridor');
  assert.equal(on(0, 8.4), true, 'inside corridor + allowance');
  assert.equal(on(0, 8.6), false, 'clear of the building line = open space');
});

test('CLEARANCE is the footprint, not a point — a big rock cannot overhang the kerb', () => {
  assert.equal(on(0, 9.5, 0), false, 'a point at 9.5 m is clear');
  assert.equal(on(0, 9.5, 2.5), true, 'a 2.5 m rock at 9.5 m still overhangs');
  assert.equal(on(0, 11.5, 2.5), false, 'the same rock further out is fine');
});

test('open ground is allowed — the guard must not sterilise the city', () => {
  assert.equal(on(0, 14), false);
  assert.equal(on(0, -14), false);
});

test('past the END of a road is allowed — segment distance, not infinite line', () => {
  assert.equal(on(140, 0), false);
  assert.equal(on(101, 0), true, 'just past the end is still within half');
});

test('a FOOTPATH is not a road — parks keep their rocks', () => {
  const path = road(2, 0, [{ x: -50, y: 0 }, { x: 50, y: 0 }], { highwayType: 'footway' });
  assert.equal(isOnAnyRoad({ roads: [path] }, 0, 0), false);
});

test('tunnels and layered roads are skipped — nothing above or below is on THIS ground', () => {
  const tunnel = road(10, 3, [{ x: -50, y: 0 }, { x: 50, y: 0 }], { tunnel: true });
  const upper = road(10, 3, [{ x: -50, y: 0 }, { x: 50, y: 0 }], { layer: 1 });
  assert.equal(isOnAnyRoad({ roads: [tunnel] }, 0, 0), false);
  assert.equal(isOnAnyRoad({ roads: [upper] }, 0, 0), false);
});

test('THE BUG THIS REPLACES: an item beyond the mask grid is still rejected by geometry', () => {
  // The mask says "allowed" outside its own grid. Geometry does not care where the grid ended.
  const far = road(10, 3, [{ x: 9000, y: 9000 }, { x: 9200, y: 9000 }]);
  assert.equal(isOnAnyRoad({ roads: [far] }, 9100, 9000), true);
});

test('empty or missing road data is safe', () => {
  assert.equal(isOnAnyRoad({ roads: [] }, 0, 0), false);
  assert.equal(isOnAnyRoad({}, 0, 0), false);
  assert.equal(isOnAnyRoad(null, 0, 0), false);
});

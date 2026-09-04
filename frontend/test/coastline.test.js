/**
 * The sea must not swallow the city.
 *
 * ⚠ THE BUG (user screenshot, Carrer del Gas, 2026-09-04): the Mediterranean was drawn over several
 * blocks of Poblenou, buildings standing in blue water behind a dead-straight diagonal waterline.
 *
 * `ingestCoastline` was FIRST-TILE-WINS. It stitched whatever `natural=coastline` ways were in the
 * first tile that carried any, and the sea polygon closes 30 km offshore FROM THAT CHAIN'S TWO ENDS
 * — so a chain that stops mid-city closes with a straight line through the city, with "sea" on one
 * side. The straight diagonal in the screenshot was that closure edge.
 *
 * State is module-global and these run in file order on purpose: the baseline is asserted first,
 * then bad input is fed, then the baseline is re-asserted to prove the bad input was refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSeaAt, coastVersion, ingestCoastline, seaPolygonWorld } from '../src/map/coastline.js';
import { latLonToWorld } from '../src/projection.js';

const at = (lat, lon) => { const w = latLonToWorld(lat, lon); return isSeaAt(w.x, w.z); };

const LAND = [
  ['Plaça Catalunya', 41.3870, 2.1700],
  ['Sagrada Família', 41.4036, 2.1744],
  ['Camp Nou', 41.3809, 2.1228],
  ["Plaça d'Espanya", 41.3754, 2.1490],
  ['Park Güell', 41.4145, 2.1527],
  ['Glòries', 41.4030, 2.1870],
  ['Poblenou / Carrer del Gas', 41.3995, 2.1955],   // the block that was under water
  ['Diagonal Mar', 41.4100, 2.2170],                // reported flooded 2026-09-04
  ['Mar Bella blocks', 41.4040, 2.2100],            // the grid in the second screenshot
  ['Rambla de Prim', 41.4130, 2.2050],
];
const SEA = [
  ['open Mediterranean', 41.3350, 2.2450],
  ['off Barceloneta', 41.3750, 2.2100],
];

// ⚠ THE MISSING GUARD. The land anchors were only ever applied to a CANDIDATE OSM chain, so a wrong
// HAND TRACE — the fallback, the thing that runs when the OSM chain is rejected — was never checked
// against anything. It was 310-500 m inland along Mar Bella and flooded Diagonal Mar for however
// long it had been that way. `backend/tools/coastlineProbe.mjs` measured the correction.
test('THE FALLBACK IS CHECKED TOO: the hand trace itself keeps the city dry', () => {
  for (const [name, lat, lon] of LAND) assert.equal(at(lat, lon), false, `${name} is under water`);
  for (const [name, lat, lon] of SEA) assert.equal(at(lat, lon), true, `${name} is not sea`);
});

test('a PARTIAL coast is refused — this is the bug, in one assertion', () => {
  // A plausible fragment: ~1 km of real Poblenou shoreline, the kind one tile carries. Closing it
  // offshore sweeps a wedge across the city.
  const frag = [[41.4040, 2.2120], [41.3985, 2.2060], [41.3935, 2.2020]]
    .map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, y: w.z }; });
  const before = coastVersion();
  ingestCoastline([{ type: 'coastline', polygon: frag }]);
  assert.equal(coastVersion(), before, 'a 1 km fragment was adopted as the whole coast');
  for (const [name, lat, lon] of LAND) assert.equal(at(lat, lon), false, `${name} went under water`);
});

test('a LONG but wrong chain is refused too — length alone is not the test', () => {
  // 15 km, comfortably past any length gate, but it runs inland: the resulting sea would cover
  // half the city. A length threshold cannot catch this; a land anchor can.
  const bad = [];
  for (let i = 0; i <= 60; i++) bad.push([41.34 + i * 0.0015, 2.24 - i * 0.0018]);   // sea → inland
  const poly = bad.map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, y: w.z }; });
  const before = coastVersion();
  ingestCoastline([{ type: 'coastline', polygon: poly }]);
  for (const [name, lat, lon] of LAND) assert.equal(at(lat, lon), false, `${name} went under water`);
  for (const [name, lat, lon] of SEA) assert.equal(at(lat, lon), true, `${name} stopped being sea`);
  assert.equal(coastVersion(), before, 'a chain that floods the city was adopted');
});

test('non-coastline water features are ignored entirely', () => {
  const before = coastVersion();
  ingestCoastline([{ type: 'riverbank', polygon: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }]);
  ingestCoastline([]);
  ingestCoastline(null);
  assert.equal(coastVersion(), before);
});

test('the sea polygon is closed and encloses the offshore anchors', () => {
  const poly = seaPolygonWorld();
  assert.ok(Array.isArray(poly) && poly.length > 4);
  for (const [name, lat, lon] of SEA) assert.equal(at(lat, lon), true, `${name} outside the sea polygon`);
});

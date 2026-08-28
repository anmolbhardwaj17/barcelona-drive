/**
 * N-2 — every water polygon in the region was written into every tile.
 *
 * `splitWatersByTile` guards each assignment with `bboxIntersects(waterBbox, tileBbox)`. It passed
 * `tileToBBox`'s output straight in, and that returns `{south, west, north, east}` while
 * `bboxIntersects` reads `minLon / maxLon / minLat / maxLat`. Every field it read was `undefined`,
 * every comparison against `undefined` is false, and `!(false || false || false || false)` is TRUE.
 *
 * So the guard never rejected anything, and it was invisible: the tiles rendered correctly, just
 * enormously. Measured on the shipped tiles — 254 unique polygons becoming **71,120 records, a 280x
 * replication, with min = median = max = 280 tiles per polygon.** A pond with a four-tile footprint
 * shipped into 280 tiles. After the fix: 1,012 records, 4.0x, median 1 tile per polygon.
 *
 * The lesson these tests encode: a guard that always passes looks exactly like a guard with nothing
 * to reject. Pin the REJECTION, not just the acceptance — `a pond reaches only its own tiles` is
 * the test that would have caught this, and `every tile` is what the old code did.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitWatersByTile } from '../../backend/worldBuilder/waterNormalize.js';
import { latLonToMercator, mercatorToWorld } from '../../backend/projection.js';

const ZOOM = 16;
// A slice of the real Barcelona region, ~8 x 6 km => a few hundred tiles at z16.
const BBOX = { minLon: 2.1198, minLat: 41.3580, maxLon: 2.2230, maxLat: 41.4130 };

/** Build a water record whose polygon is a small square around (lat, lon), sized in degrees. */
function pondAt(id, lat, lon, sizeDeg = 0.0006) {
  const corners = [
    [lat - sizeDeg, lon - sizeDeg], [lat - sizeDeg, lon + sizeDeg],
    [lat + sizeDeg, lon + sizeDeg], [lat + sizeDeg, lon - sizeDeg],
  ];
  const polygon = corners.map(([la, lo]) => {
    const m = latLonToMercator(la, lo);
    const w = mercatorToWorld(m.x, m.y);
    return [w.x, w.z];   // splitWatersByTile expects WORLD, as normalizeWater emits
  });
  return { id, type: 'water', closed: true, polygon };
}

/** How many tiles did this polygon get assigned to? */
function tileCountFor(map, id) {
  let n = 0;
  for (const [, list] of map) if (list.some((w) => w.id === id)) n++;
  return n;
}

test('a small pond reaches only the tiles it actually touches — NOT every tile', () => {
  const pond = pondAt(1, 41.3866, 2.1640);           // ~130 m square near Placa Universitat
  const map = splitWatersByTile([pond], ZOOM, BBOX);
  const n = tileCountFor(map, 1);
  assert.ok(n >= 1, 'it must land somewhere');
  // THE REGRESSION GUARD. The broken version put this in all ~280 tiles of the region.
  assert.ok(n <= 4, `a 130 m pond should touch at most a few tiles, got ${n}`);
});

test('two distant ponds do not share tiles', () => {
  const a = pondAt(1, 41.3620, 2.1250);
  const b = pondAt(2, 41.4100, 2.2200);              // opposite corner of the region
  const map = splitWatersByTile([a, b], ZOOM, BBOX);
  for (const [, list] of map) {
    const ids = new Set(list.map((w) => w.id));
    assert.ok(!(ids.has(1) && ids.has(2)), 'no tile should contain both distant ponds');
  }
});

test('a LONG feature still spans many tiles — the fix must not over-reject', () => {
  // A stream crossing the region: legitimately in many tiles. Measured on real data, the widest
  // real feature lands in 110 tiles, so breadth itself is not the bug — indiscriminate breadth is.
  const m0 = latLonToMercator(41.3600, 2.1250);
  const m1 = latLonToMercator(41.4100, 2.2200);
  const w0 = mercatorToWorld(m0.x, m0.y), w1 = mercatorToWorld(m1.x, m1.y);
  const stream = {
    id: 9, type: 'water', closed: true,
    polygon: [[w0.x, w0.z], [w1.x, w1.z], [w1.x + 30, w1.z + 30], [w0.x + 30, w0.z + 30]],
  };
  const map = splitWatersByTile([stream], ZOOM, BBOX);
  assert.ok(tileCountFor(map, 9) > 20, 'a region-crossing feature must still reach many tiles');
});

test('polygons with fewer than 2 points are skipped', () => {
  const map = splitWatersByTile([{ id: 3, type: 'water', polygon: [[0, 0]] }], ZOOM, BBOX);
  assert.equal(tileCountFor(map, 3), 0);
});

test('a bbox with the WRONG FIELD NAMES throws instead of silently matching everything', () => {
  // This is the actual defect, stated as a test: tileToBBox's {south,west,north,east} passed into a
  // min/max-lon/lat comparison read undefined everywhere and returned true for every pair.
  // Reaching bboxIntersects requires a polygon, so drive it through the public function with a
  // region bbox that has the tile-shaped field names.
  const pond = pondAt(1, 41.3866, 2.1640);
  const wrongShape = { south: 41.3580, west: 2.1198, north: 41.4130, east: 2.2230 };
  assert.throws(() => splitWatersByTile([pond], ZOOM, wrongShape), /minLon|not a .*box|NaN/i);
});

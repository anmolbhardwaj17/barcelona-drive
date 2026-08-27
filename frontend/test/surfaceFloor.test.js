/**
 * R-P1 — drivable-surface-implies-floor, the SURFACE half.
 *
 * The tunnel validator and this one look like the same check and are mirror images:
 *
 *   TUNNEL   the carved floor must be UNDER the road, so a violation is the grid too HIGH —
 *            terrain rising into the roadway.
 *   SURFACE  the terrain IS the floor and the physics heightfield is built from it, so a violation
 *            is the grid too LOW — the visual asphalt hanging in the air with the collider metres
 *            below. That is "there are roads in some places from where I fall": the car is on the
 *            collider the whole time; it is the road that is not where it looks.
 *
 * Widening the tunnel whitelist without flipping the sign would have flagged BURIED roads — a
 * cosmetic problem you drive over — and missed every floating one, which is the problem you fall
 * through. These tests exist because that error is invisible in review and passes a bake.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSurfaceFloorViolations, SURFACE_DROP_BUCKETS,
} from '../../backend/worldBuilder/terrain/validateTunnelFloors.js';

// A 1-degree-ish tile around the equator-side origin keeps the mercator maths simple; what matters
// is that the road's samples land inside `bounds` so they are validated at all.
const BOUNDS = { south: 0.0, west: 0.0, north: 0.01, east: 0.01 };
const GRID = 8;

/** A flat terrain grid at `h` metres. */
const flatGrid = (h) => new Float32Array(GRID * GRID).fill(h);

const R_EARTH = 6378137;
const lonToMerc = (lon) => (lon * Math.PI / 180) * R_EARTH;
const latToMerc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R_EARTH;

/**
 * A road across the middle of the tile at constant height `roadY`.
 * Points are [mercX, yUp, mercZ, absRoadY] — the DRAPED shape the collector expects.
 */
function road(id, roadY, extra = {}) {
  const z = latToMerc(0.005);
  const pts = [];
  for (let i = 0; i <= 4; i++) {
    pts.push([lonToMerc(0.002 + i * 0.0015), roadY, z, roadY]);
  }
  return { id, highwayType: 'residential', points: pts, ...extra };
}

const collect = (roads, terrainH) => {
  const stats = { samples: 0, maxDrop: -Infinity, minDrop: Infinity };
  const v = collectSurfaceFloorViolations('t', roads, flatGrid(terrainH), BOUNDS, GRID, stats);
  return { violations: v, stats };
};

test('a road FLOATING above the terrain is flagged — the fall-through case', () => {
  const { violations, stats } = collect([road(1, 20)], 10);   // road 20 m, ground 10 m
  assert.ok(stats.samples > 0, 'the check must actually sample something (D-23)');
  assert.ok(violations.length > 0, 'a 10 m drop must be flagged');
  assert.ok(violations[0].drop > 9, `drop should be ~10, got ${violations[0].drop}`);
});

test('a road BURIED under the terrain is NOT flagged — the opposite defect', () => {
  // Terrain above the road is a bump you drive over, not a hole you fall into. Flagging it would
  // be the tunnel check's sign applied to a surface road, which is the exact mistake this guards.
  const { violations, stats } = collect([road(1, 10)], 20);   // road 10 m, ground 20 m
  assert.ok(stats.samples > 0);
  assert.equal(violations.length, 0);
  assert.ok(stats.minDrop < 0, 'the negative drop must still be SEEN, so the range line is honest');
});

test('a road sitting ON the terrain is clean', () => {
  const { violations } = collect([road(1, 10)], 10);
  assert.equal(violations.length, 0);
});

test('a road under the smallest bucket is not flagged', () => {
  const { violations } = collect([road(1, 10 + SURFACE_DROP_BUCKETS[0] * 0.5)], 10);
  assert.equal(violations.length, 0, 'the designed road lift must not read as a fall');
});

test('roads that carry their OWN deck are excluded, and that is not a loophole', () => {
  // A bridge, a ramp, a layer>0 deck and an Option-L trench crossing are SUPPOSED to be above the
  // terrain; each gets its own collider in tileManager. Same four booleans as the guard-rail and
  // street-parking gates, so three systems cannot drift apart on what "carries its own surface" is.
  for (const extra of [{ bridge: true }, { isRamp: true }, { layer: 1 }, { crossesTrench: true }]) {
    const { violations } = collect([road(1, 30, extra)], 10);
    assert.equal(violations.length, 0, `must be excluded: ${JSON.stringify(extra)}`);
  }
});

test('a tunnel is left to the OTHER half of the invariant', () => {
  const { violations } = collect([road(1, 30, { tunnel: true, layer: -1 })], 10);
  assert.equal(violations.length, 0);
});

test('a non-drivable way is not a drivable surface', () => {
  const { violations } = collect([road(1, 30, { highwayType: 'footway' })], 10);
  assert.equal(violations.length, 0);
});

test('stats record the extremes, not just the violations', () => {
  // The report prints this range even on success. Without it, "0 violations" and "sampled nothing"
  // are the same line — which is how the light-grid A/B reported a false PASS (D-23).
  const { stats } = collect([road(1, 12), road(2, 6)], 10);
  assert.ok(stats.samples > 0);
  assert.ok(stats.maxDrop > 1.5, `max drop ~2, got ${stats.maxDrop}`);
  assert.ok(stats.minDrop < -3, `min drop ~-4, got ${stats.minDrop}`);
});

test('a road with no samples inside the tile yields no stats, not a false pass', () => {
  // Samples outside `bounds` are skipped — they belong to the tile that owns that grid. If EVERY
  // sample is skipped the collector must report zero samples so the report can say VOID.
  const far = road(1, 30);
  for (const p of far.points) { p[0] += lonToMerc(10); }
  const { violations, stats } = collect([far], 10);
  assert.equal(violations.length, 0);
  assert.equal(stats.samples, 0, 'and the report turns 0 samples into VOID, not a green tick');
});

/**
 * R-J5 — the tile clipper silently ate any road that LEFT the tile.
 *
 * `clipRoadToTile` accumulates surviving segments into a `run`, and pushes that run in exactly two
 * places: when a NEW run starts, and when the polyline ends. On a segment falling outside it did a
 * bare `run = null` — discarding everything gathered so far. So the common case, a road that enters
 * the tile, crosses it and exits, produced NOTHING.
 *
 * Measured before the fix: a 103-point path with 42 consecutive segments fully inside tile
 * 16_33153_24471 clipped to ZERO runs, while a 2-point road cut from the same polyline clipped
 * correctly — which is why it survived: reproducing it needs a polyline that both enters and leaves.
 *
 * This almost certainly explains `noClipTileStrategy: true` in the bake config. With the clipper
 * eating roads, not clipping was the only setting that produced a complete city. R-J5's render-side
 * clip depends on this being right, so it is pinned here.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipRoadsForTile } from '../../backend/worldBuilder/tileSplit.js';

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
/** Points are [x, yUp, z]; the clipper works in (x, z). */
const road = (points, extra = {}) => ({ id: 1, width: 6, highwayType: 'residential', points, ...extra });
const runLen = (pts) => pts.reduce((L, p, i) => (i ? L + Math.hypot(p[0] - pts[i-1][0], p[2] - pts[i-1][2]) : 0), 0);

test('a road that crosses the tile and LEAVES keeps the part inside', () => {
  // THE bug: enters at x=10, runs to x=90, then exits east. Everything inside was discarded.
  const pts = [];
  for (let x = 10; x <= 90; x += 10) pts.push([x, 0, 50]);
  pts.push([150, 0, 50]);            // leaves the tile
  const out = clipRoadsForTile([road(pts)], BOUNDS);
  assert.equal(out.length, 1, 'the inside portion must survive the road leaving');
  assert.ok(runLen(out[0].points) >= 89, `expected ~90 m of road, got ${runLen(out[0].points).toFixed(1)}`);
});

test('a road that ENTERS, LEAVES and RE-ENTERS yields two runs', () => {
  const pts = [
    [-50, 0, 50], [20, 0, 50], [40, 0, 50],   // in
    [40, 0, 150],                              // out (north)
    [60, 0, 150],
    [60, 0, 50], [90, 0, 50],                  // back in
  ];
  const out = clipRoadsForTile([road(pts)], BOUNDS);
  assert.equal(out.length, 2, 'each visit to the tile is its own run');
  for (const r of out) assert.ok(runLen(r.points) > 1, 'both runs must be real road, not slivers');
});

test('a road entirely inside is returned whole', () => {
  const pts = [[10, 0, 10], [50, 0, 10], [90, 0, 90]];
  const out = clipRoadsForTile([road(pts)], BOUNDS);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(runLen(out[0].points) - runLen(pts)) < 1e-6, 'nothing may be lost');
});

test('a road entirely outside is dropped', () => {
  assert.equal(clipRoadsForTile([road([[200, 0, 200], [300, 0, 300]])], BOUNDS).length, 0);
});

test('the width SECTION survives the clip — it is a field whitelist (D-42)', () => {
  const pts = [[10, 0, 50], [90, 0, 50], [150, 0, 50]];
  const [out] = clipRoadsForTile([road(pts, {
    carriagewayW: 6, parkingLeftW: 2.2, parkingRightW: 2.2, shoulderW: 0,
    kerbToKerbW: 10.4, sidewalkW: 3, corridorW: 16.4, lanes: 2,
  })], BOUNDS);
  assert.ok(out, 'the road must survive at all');
  for (const [k, v] of Object.entries({ kerbToKerbW: 10.4, sidewalkW: 3, corridorW: 16.4, carriagewayW: 6, lanes: 2 })) {
    assert.equal(out[k], v, `${k} was dropped by the clip — R-W1 consumers fall back to guessing`);
  }
});

test('per-point elevation (the 4th component) is interpolated, not dropped', () => {
  // The bakers read heights from a parallel array derived from points[3]; losing it bakes flat road.
  const pts = [[10, 0, 50, 100], [90, 0, 50, 180], [150, 0, 50, 240]];
  const [out] = clipRoadsForTile([road(pts)], BOUNDS);
  assert.ok(out.points.every((p) => p.length >= 4), 'every clipped point must keep its height');
  const cut = out.points[out.points.length - 1];
  assert.ok(Math.abs(cut[0] - 100) < 1e-6, 'the run should end at the tile edge, x=100');
  assert.ok(cut[3] > 180 && cut[3] < 200, `height must be lerped at the cut, got ${cut[3]}`);
});

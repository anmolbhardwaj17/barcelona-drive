/**
 * Pedestrian pavement paths (P-1).
 *
 * The old build made a walk candidate out of every SUB-SEGMENT of a road and offset each one on its
 * own, so (a) a person's whole world was one 10-30 m stretch they paced back and forth over, and
 * (b) at every bend the two offset sub-segments did not meet, leaving a lateral step in the walk
 * line. These pin the replacement: ONE mitred polyline per side of the whole road, parameterised by
 * arc length.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPavementPaths, samplePath } from '../src/car/pedestrians.js';

const ORIGIN = { x: 1000, z: 2000 };
const flat = () => 0;

test('a straight road yields two paths, one either side, offset by exactly `off`', () => {
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2100 }];
  const paths = buildPavementPaths(pts, 5, flat, ORIGIN);
  assert.equal(paths.length, 2);
  for (const p of paths) assert.ok(Math.abs(p.len - 100) < 1e-3, `len ${p.len}`);
  // Physics X is mirrored, so the two sides land at ∓5 about the centreline's px = 0.
  const xs = paths.map((p) => p.p[0]).sort((a, b) => a - b);
  assert.deepEqual(xs.map((v) => Math.round(v)), [-5, 5]);
});

test('a path that is too short to walk is refused rather than shipped as a stub', () => {
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2003 }];
  assert.equal(buildPavementPaths(pts, 5, flat, ORIGIN), null);
});

test('THE CORNER: a mitred offset stays continuous — no lateral step at the bend', () => {
  // 90° corner. Offsetting each sub-segment on its own leaves the inner walk line with a 5 m gap
  // between the end of one offset segment and the start of the next; a walker crossing it teleports.
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2050 }, { x: 1050, y: 2050 }];
  const paths = buildPavementPaths(pts, 5, flat, ORIGIN);
  assert.equal(paths.length, 2);
  for (const path of paths) {
    // Walk the whole path in 0.5 m steps; no step may move the walker more than ~0.55 m.
    const out = { i: 0 };
    samplePath(path, 0, out);
    let px = out.x, pz = out.z, worst = 0;
    for (let s = 0.5; s <= path.len; s += 0.5) {
      samplePath(path, s, out);
      worst = Math.max(worst, Math.hypot(out.x - px, out.z - pz));
      px = out.x; pz = out.z;
    }
    assert.ok(worst < 0.6, `lateral jump of ${worst.toFixed(2)} m at the corner`);
  }
  // And the mitre actually moved the corner vertex off the naive per-segment offset: on the OUTER
  // side the corner sits further than `off` from the centreline vertex (that is what a mitre is).
  const outer = paths.map((p) => Math.hypot(p.p[3] - -(1000 - ORIGIN.x), p.p[5] - (2050 - ORIGIN.z)));
  assert.ok(Math.max(...outer) > 5.5, `no mitre applied: ${outer.map((v) => v.toFixed(2))}`);
});

test('arc length is monotonic and sampling is exact at the vertices', () => {
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2040 }, { x: 1030, y: 2080 }];
  const [path] = buildPavementPaths(pts, 3, flat, ORIGIN);
  for (let i = 1; i < path.cum.length; i++) assert.ok(path.cum[i] > path.cum[i - 1]);
  const out = { i: 0 };
  for (let i = 0; i < path.cum.length; i++) {
    samplePath(path, path.cum[i], out);
    assert.ok(Math.abs(out.x - path.p[i * 3]) < 1e-3 && Math.abs(out.z - path.p[i * 3 + 2]) < 1e-3);
  }
});

test('sampling walks BACKWARDS from a cached index without losing the position', () => {
  // A pedestrian who turns round re-enters samplePath with a stale forward index. The old
  // per-segment scheme could not hit this because it never had an index to be stale.
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2030 }, { x: 1000, y: 2060 }, { x: 1000, y: 2090 }];
  const [path] = buildPavementPaths(pts, 3, flat, ORIGIN);
  const fwd = { i: 0 }, back = { i: 3 };
  samplePath(path, 12, fwd);
  samplePath(path, 12, back);
  assert.ok(Math.abs(fwd.x - back.x) < 1e-6 && Math.abs(fwd.z - back.z) < 1e-6);
  assert.equal(fwd.i, back.i);
});

test('the walk line is draped on the ground, not left at y=0', () => {
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2100 }];
  const [path] = buildPavementPaths(pts, 4, (wx, wy) => (wy - 2000) * 0.05, ORIGIN);
  assert.ok(Math.abs(path.p[1] - 0) < 1e-6);
  assert.ok(Math.abs(path.p[path.p.length - 2] - 5) < 1e-6, `end y ${path.p[path.p.length - 2]}`);
});

test('ground height is sampled at the OFFSET point, not at the centreline', () => {
  // Cross-slope: sampling at the centreline puts both pavements at the road's height, which is how
  // a pavement ends up buried on the uphill side and floating on the downhill one.
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2100 }];
  const paths = buildPavementPaths(pts, 6, (wx) => (wx - 1000) * 0.2, ORIGIN);
  const ys = paths.map((p) => p.p[1]).sort((a, b) => a - b);
  assert.deepEqual(ys.map((v) => +v.toFixed(2)), [-1.2, 1.2]);
});

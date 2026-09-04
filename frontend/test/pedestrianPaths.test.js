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

// ── P-2: marked crossings ──────────────────────────────────────────────────────────────────────
// Pedestrians could not leave the pavement they spawned on, so a street was two conveyor belts
// facing each other. The blocker was one missing field in a whitelist projection, not a design.
import { buildCrossingPath, attachCrossings, nearestPathPoint } from '../src/car/pedestrians.js';

/** Two pavements either side of a N-S street, and a crossing between them. */
function street() {
  const road = [{ x: 1000, y: 2000 }, { x: 1000, y: 2200 }];
  const paths = buildPavementPaths(road, 6, flat, ORIGIN);          // ±6 m either side
  const crossPts = [{ x: 994, y: 2100 }, { x: 1006, y: 2100 }];     // straight across, 12 m
  const cross = buildCrossingPath(crossPts, flat, ORIGIN);
  return { paths, cross };
}

test('a crossing becomes a walkable polyline of the right length', () => {
  const { cross } = street();
  assert.ok(cross, 'no crossing path built');
  assert.ok(Math.abs(cross.len - 12) < 1e-3, `len ${cross.len}`);
});

test('crossings that are stubs or absurdly long are refused', () => {
  // The baked tiles hold crossings from 0.9 m to 101 m (backend/tools/crossingCount.mjs). The short
  // ones are kerb ramps and the long ones are not a crossing of anything.
  assert.equal(buildCrossingPath([{ x: 1000, y: 2000 }, { x: 1000.9, y: 2000 }], flat, ORIGIN), null);
  assert.equal(buildCrossingPath([{ x: 1000, y: 2000 }, { x: 1101, y: 2000 }], flat, ORIGIN), null);
});

test('BOTH pavements pick the crossing up, one hook each', () => {
  // A pedestrian may arrive at either kerb, so each side must see its own end of it.
  const { paths, cross } = street();
  assert.equal(paths.length, 2);
  for (const p of paths) {
    const hooks = attachCrossings(p, [cross], 1);
    assert.equal(hooks.length, 1, 'a pavement should hook the near end only, not both');
    // It meets the pavement halfway along its 200 m length.
    assert.ok(Math.abs(hooks[0].s - 100) < 1.5, `hook at ${hooks[0].s.toFixed(1)} m, expected ~100`);
  }
  // The two sides must take OPPOSITE ends, or everyone walks the same way and lands where they were.
  const a = attachCrossings(paths[0], [cross], 2)[0];
  const b = attachCrossings(paths[1], [cross], 2)[0];
  assert.notEqual(a.fromStart, b.fromStart);
});

test('hooks are cached against a version, not recomputed every frame', () => {
  const { paths, cross } = street();
  const first = attachCrossings(paths[0], [cross], 7);
  const again = attachCrossings(paths[0], [cross], 7);
  assert.equal(first, again, 'same version should return the identical array');
  assert.notEqual(attachCrossings(paths[0], [], 8), first, 'a new version must recompute');
});

test('a crossing that touches nothing attaches nowhere', () => {
  const { paths } = street();
  const far = buildCrossingPath([{ x: 1500, y: 2100 }, { x: 1512, y: 2100 }], flat, ORIGIN);
  assert.equal(attachCrossings(paths[0], [far], 3).length, 0);
});

test('stepping off a crossing finds the pavement on the FAR side', () => {
  // The end of the walk must re-join the other pavement, not the one just left — otherwise crossing
  // is an animation that returns you to where you started.
  const { paths, cross } = street();
  const out = { i: 0 };
  samplePath(cross, cross.len, out);
  const hit = nearestPathPoint(paths, out.x, out.z);
  assert.ok(hit, 'no pavement found at the far kerb');
  samplePath(cross, 0, out);
  const back = nearestPathPoint(paths, out.x, out.z);
  assert.ok(back && back.path !== hit.path, 'both ends resolved to the same pavement');
});

test('nearestPathPoint refuses a match beyond its radius', () => {
  const { paths } = street();
  assert.equal(nearestPathPoint(paths, 999999, 999999), null);
});

/**
 * ── P-6: DESTINATIONS ───────────────────────────────────────────────────────────────────────────
 *
 * Every walk used to be a direction. These pin the shop→pavement snap that turns one into a
 * destination, and specifically the facing vector, which is the whole visible difference between
 * "stopped at a shop" and "stopped".
 */
import { attachDestinations } from '../src/car/pedestrians.js';

/** A 100 m straight pavement pair, as buildPavementPaths returns them. */
function street100() {
  const pts = [{ x: 1000, y: 2000 }, { x: 1000, y: 2100 }];
  return buildPavementPaths(pts, 5, flat, ORIGIN);
}

test('a shop beside the pavement becomes a hook at the arc length it sits at', () => {
  const [path] = street100();
  // 30 m along, 3 m off the walk line.
  const px = path.p[0], sign = px > 0 ? 1 : -1;
  const dests = attachDestinations(path, [{ x: px + sign * 3, z: 30, name: 'Ester Optics' }], 1);
  assert.equal(dests.length, 1);
  assert.ok(Math.abs(dests[0].s - 30) < 0.5, `s ${dests[0].s}`);
  assert.equal(dests[0].name, 'Ester Optics');
});

test('the facing vector points AT the shop, not along the street', () => {
  // Without this a pedestrian "arrives" and stands facing down the pavement like everyone else,
  // which is indistinguishable from the pause they already had.
  const [path] = street100();
  const px = path.p[0], sign = px > 0 ? 1 : -1;
  const [d] = attachDestinations(path, [{ x: px + sign * 4, z: 50 }], 1);
  assert.ok(Math.abs(Math.hypot(d.dx, d.dz) - 1) < 1e-6, 'not a unit vector');
  assert.ok(Math.abs(d.dx - sign) < 0.05, `dx ${d.dx} should point across the pavement`);
  assert.ok(Math.abs(d.dz) < 0.05, `dz ${d.dz} should not point along it`);
});

test('a shop on the far side of the block is not this pavement’s destination', () => {
  const [path] = street100();
  assert.equal(attachDestinations(path, [{ x: path.p[0] + 400, z: 30 }], 1).length, 0);
});

test('a shop sitting exactly ON the walk line still yields a usable facing vector', () => {
  // The degenerate case: zero length to normalise. A zero vector would snap yaw to due north and
  // read as one person in the crowd inexplicably facing the wrong way.
  const [path] = street100();
  const [d] = attachDestinations(path, [{ x: path.p[0], z: 40 }], 1);
  assert.ok(d, 'a coincident shop was dropped rather than handled');
  assert.ok(Math.abs(Math.hypot(d.dx, d.dz) - 1) < 1e-6, `not unit: ${d.dx},${d.dz}`);
});

test('hooks are cached against the version and rebuilt when it moves', () => {
  const [path] = street100();
  const a = attachDestinations(path, [{ x: path.p[0] + 3, z: 10 }], 7);
  const b = attachDestinations(path, [{ x: path.p[0] + 3, z: 10 }, { x: path.p[0] + 3, z: 60 }], 7);
  assert.equal(b, a, 'same version must not rescan');
  const c = attachDestinations(path, [{ x: path.p[0] + 3, z: 10 }, { x: path.p[0] + 3, z: 60 }], 8);
  assert.equal(c.length, 2, 'a bumped version must rescan');
});

test('destinations come back sorted by arc length', () => {
  // A walker scans them against its own `s`; unsorted hooks make "the next one" meaningless.
  const [path] = street100();
  const px = path.p[0];
  const d = attachDestinations(path, [{ x: px + 3, z: 80 }, { x: px + 3, z: 20 }, { x: px + 3, z: 50 }], 1);
  assert.deepEqual(d.map((h) => Math.round(h.s)), [20, 50, 80]);
});

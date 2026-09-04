/**
 * The invisible world-boundary wall.
 *
 * ⚠ THE FAILURE THIS EXISTS FOR: an inward push with the wrong sign builds a wall that EJECTS you.
 * World +x is east, physics X is mirrored (`worldGroup.scale.x = -1`), and the push crosses that
 * boundary — which is precisely the class of bug the CLAUDE.md danger note is about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryPush, outOfBoundsM, isInsidePlayArea } from '../src/map/worldBoundary.js';
import { latLonToWorld } from '../src/projection.js';

// The bake's bbox, inset — mirrored from worldBoundary's own constants.
const IN = { lat: 41.385, lon: 2.170 };           // comfortably inside
const OUT_E = { lat: 41.385, lon: 2.2280 };       // past maxLon 2.2230
const OUT_W = { lat: 41.385, lon: 2.1150 };
const OUT_N = { lat: 41.4180, lon: 2.170 };       // past maxLat 41.4130
const OUT_S = { lat: 41.3530, lon: 2.170 };
const w = (p) => latLonToWorld(p.lat, p.lon);

test('inside the play area there is no push at all', () => {
  const c = w(IN);
  const p = boundaryPush(c.x, c.z);
  assert.equal(p.depth, 0, `pushed ${p.x},${p.z} while inside`);
  assert.ok(isInsidePlayArea(c.x, c.z));
  assert.equal(outOfBoundsM(c.x, c.z), 0);
});

test('the push always points BACK INTO the world, on every edge', () => {
  // The sign test. East of the boundary must push west (−x); north must push south (−z).
  const e = w(OUT_E), p_e = boundaryPush(e.x, e.z);
  assert.ok(p_e.x < 0, `east of the edge pushed ${p_e.x} — that is further out`);
  const wst = w(OUT_W), p_w = boundaryPush(wst.x, wst.z);
  assert.ok(p_w.x > 0, `west of the edge pushed ${p_w.x}`);
  const n = w(OUT_N), p_n = boundaryPush(n.x, n.z);
  assert.ok(p_n.z < 0, `north of the edge pushed ${p_n.z}`);
  const s = w(OUT_S), p_s = boundaryPush(s.x, s.z);
  assert.ok(p_s.z > 0, `south of the edge pushed ${p_s.z}`);
});

test('applying the push actually lands you back inside — it is not merely the right direction', () => {
  for (const pt of [OUT_E, OUT_W, OUT_N, OUT_S]) {
    const c = w(pt);
    const p = boundaryPush(c.x, c.z);
    assert.ok(p.depth > 0, `no push at ${pt.lat},${pt.lon}`);
    const after = boundaryPush(c.x + p.x, c.z + p.z);
    // One application must clear it EXACTLY — a push that only ever gets halfway is a wall you can
    // walk through by leaning on it. The first implementation converted degrees to metres by hand
    // and landed 0.69 m short every time; the box is projected now, so this is float slop only.
    assert.ok(after.depth < 1e-6, `still ${after.depth} out after one push`);
  }
});

test('a corner pushes on BOTH axes, so corners feel like corners', () => {
  const c = w({ lat: 41.4180, lon: 2.2280 });     // past the NE corner on both
  const p = boundaryPush(c.x, c.z);
  assert.ok(p.x < 0 && p.z < 0, `corner pushed ${p.x},${p.z}`);
  const after = boundaryPush(c.x + p.x, c.z + p.z);
  assert.ok(after.depth < 1e-6);
});

test('the wall engages BEFORE the teleport arms — otherwise it is decorative', () => {
  // Walk out from inside. The frame the wall first pushes must come before the frame the teleport
  // would fire, or the player still gets yanked, which is the behaviour the wall replaces.
  const start = w(IN);
  let wallAt = -1, teleAt = -1;
  // Range: the play area is several km across in world units, so a short walk never reaches the
  // edge — the first cut used 4000 and concluded the wall did not exist.
  for (let d = 0; d < 40000; d += 5) {
    const x = start.x + d;
    if (wallAt < 0 && boundaryPush(x, start.z).depth > 0) wallAt = d;
    if (teleAt < 0 && outOfBoundsM(x, start.z) > 45) teleAt = d;
    if (wallAt >= 0 && teleAt >= 0) break;
  }
  assert.ok(wallAt >= 0, 'the wall never engaged');
  assert.ok(teleAt >= 0, 'the teleport band was never reached');
  assert.ok(wallAt < teleAt, `wall at ${wallAt} m, teleport at ${teleAt} m — the teleport wins`);
});

test('the push grows with how far out you are — it is a plane, not a magnet', () => {
  const near = w({ lat: 41.385, lon: 2.2240 });
  const far = w({ lat: 41.385, lon: 2.2400 });
  assert.ok(Math.abs(boundaryPush(far.x, far.z).x) > Math.abs(boundaryPush(near.x, near.z).x));
});

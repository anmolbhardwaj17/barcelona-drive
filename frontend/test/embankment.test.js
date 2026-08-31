/**
 * N-54 — approach embankments.
 *
 * The measurement that produced this feature is worth restating, because it overturned the reading
 * everyone (me included) started with: of the 21 drivable surface roads floating >2 m above clear
 * ground, the layer model causes ZERO. 18 are bridge APPROACHES at the correct height with no fill
 * beneath them, 3 are orphan ramps. So this is fill geometry, not a height correction — and a
 * height "fix" would have torn 18 roads off the decks they meet.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleForSkirt, findEmbankedRuns } from '../src/map/embankment.js';

const line = (n, spacing) =>
  Array.from({ length: n }, (_, i) => ({ x: i * spacing, y: 0 }));

test('a sparse polyline is resampled to the requested spacing, not left at its own points', () => {
  // The case this exists for: two points 50 m apart describe the deck perfectly and the ground
  // not at all.
  const r = resampleForSkirt([{ x: 0, y: 0 }, { x: 50, y: 0 }], [10, 10], 4);
  assert.ok(r.pts.length >= 13, `expected ~13 samples across 50 m at 4 m, got ${r.pts.length}`);
  for (let i = 1; i < r.pts.length - 1; i++) {
    const d = Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].y - r.pts[i - 1].y);
    assert.ok(Math.abs(d - 4) < 1e-6, `sample ${i} is ${d} m from the previous, not 4`);
  }
});

test('the final point is always emitted — an open-ended run caps at the wrong section', () => {
  const r = resampleForSkirt([{ x: 0, y: 0 }, { x: 10.5, y: 0 }], [0, 0], 4);
  const last = r.pts[r.pts.length - 1];
  assert.ok(Math.abs(last.x - 10.5) < 1e-9, `run must reach the road's end, stopped at ${last.x}`);
});

test('heights are interpolated along the resampled points, not carried from the last road point', () => {
  // A ramp climbing 0 -> 12 m over 12 m, sampled every 4: the wall top must climb with it.
  const r = resampleForSkirt([{ x: 0, y: 0 }, { x: 12, y: 0 }], [0, 12], 4);
  assert.ok(Math.abs(r.heights[0] - 0) < 1e-9);
  assert.ok(Math.abs(r.heights[1] - 4) < 1e-6, `expected 4 m at the 4 m mark, got ${r.heights[1]}`);
  assert.ok(Math.abs(r.heights[2] - 8) < 1e-6, `expected 8 m at the 8 m mark, got ${r.heights[2]}`);
});

test('duplicate points do not divide by zero or emit NaN', () => {
  const r = resampleForSkirt([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }], [5, 5, 5], 4);
  assert.ok(r, 'a degenerate leading segment must not kill the whole road');
  for (const p of r.pts) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'NaN sample');
  for (const h of r.heights) assert.ok(Number.isFinite(h), 'NaN height');
});

test('a road too short to resample returns null rather than a one-sample run', () => {
  assert.equal(resampleForSkirt([{ x: 0, y: 0 }], [0], 4), null);
  assert.equal(resampleForSkirt(null, [], 4), null);
});

test('contiguous eligible sections group into one run', () => {
  assert.deepEqual(findEmbankedRuns([false, true, true, true, false]), [{ s: 1, e: 3 }]);
});

test('an isolated eligible section builds nothing — it is a sliver, not an embankment', () => {
  // Zero wall quads and two coincident end caps: a flat card standing in the road.
  assert.deepEqual(findEmbankedRuns([false, true, false]), []);
  assert.deepEqual(findEmbankedRuns([true, false, true]), []);
});

test('two separate runs stay separate — the gap is where something passes beneath', () => {
  // The gap is a real underpass: walling across it is the failure this separation prevents.
  assert.deepEqual(findEmbankedRuns([true, true, false, false, true, true]),
    [{ s: 0, e: 1 }, { s: 4, e: 5 }]);
});

test('all-eligible and none-eligible are both handled', () => {
  assert.deepEqual(findEmbankedRuns([true, true, true]), [{ s: 0, e: 2 }]);
  assert.deepEqual(findEmbankedRuns([false, false]), []);
  assert.deepEqual(findEmbankedRuns([]), []);
});

// ── N-64 · AN EMBANKMENT IS AN APPROACH, A VIADUCT IS NOT ──────────────────────────────────────
// The rule "clear ground beneath -> embankment" shipped the wrong structure. Measured on the drive
// that exposed it: `embanked 67` pillar spots against `built 5` pillars, and a flyover over a park
// rendered as two long hollow concrete boxes under the deck.
import { keepApproachRuns } from '../src/map/embankment.js';

test('a run that comes down to grade after it IS an approach', () => {
  // sections:      0 elevated, 1 elevated, 2 at grade
  const runs = [{ s: 0, e: 1 }];
  assert.deepEqual(keepApproachRuns(runs, [false, false, true], 3), [{ s: 0, e: 1 }]);
});

test('a run elevated at BOTH ends is mid-span — piers, not fill', () => {
  // The deck is high before AND after: nothing to fill against. This is the park flyover.
  const runs = [{ s: 2, e: 3 }];
  const atGrade = [false, false, false, false, false, false];
  assert.deepEqual(keepApproachRuns(runs, atGrade, 6), []);
});

test('a run touching the way\'s own end is kept — the road continues into another way', () => {
  // Refusing here would drop the approach at every tile boundary, which is where ways are split.
  assert.deepEqual(keepApproachRuns([{ s: 0, e: 2 }], [false, false, false], 3), [{ s: 0, e: 2 }]);
  assert.deepEqual(keepApproachRuns([{ s: 1, e: 3 }], [false, false, false, false], 4),
    [{ s: 1, e: 3 }]);
});

test('grade on either side qualifies — an approach can descend at either end', () => {
  const before = keepApproachRuns([{ s: 1, e: 2 }], [true, false, false, false], 4);
  const after = keepApproachRuns([{ s: 1, e: 2 }], [false, false, false, true], 4);
  assert.equal(before.length, 1, 'descends before the run');
  assert.equal(after.length, 1, 'descends after the run');
});

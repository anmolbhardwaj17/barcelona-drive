/**
 * v3 P3-01 — fair-share detail budgets.
 *
 * The bug being guarded: each detail cap was ONE tile-wide counter tested as `verts < CAP` inside
 * the building loop, so buildings claimed detail in TILE ORDER until the pot ran dry. Measured
 * consequence — the median tile delivered detail to 26.6% of eligible buildings, p10 14.6%, and
 * 127 of 158 dense tiles sat below 50%. A queue, not a budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFairBudget } from '../src/workers/buildingWorker.js';

/** Run one building's turn: claim, spend up to `want`, close. Returns what it actually got. */
function turn(bud, want, suppressed = false) {
  if (!bud.claim(!suppressed)) return 0;
  let got = 0;
  while (got < want && bud.has(8)) { bud.add(8); got += 8; }
  bud.close();
  return got;
}

test('the cap is never exceeded, however greedy the buildings are', () => {
  const bud = createFairBudget(40000);
  bud.setEligible(100);
  let total = 0;
  for (let i = 0; i < 100; i++) total += turn(bud, 1e6);   // every building wants everything
  assert.ok(total <= 40000, `spent ${total}, cap 40000`);
});

test('NO STARVATION BY TILE ORDER — the last building gets what the first did', () => {
  // The whole point. Under the old first-come counter the first ~10 buildings took all 40000 and
  // building 11..100 got zero, which is the 26.6% median coverage that was measured.
  const bud = createFairBudget(40000);
  bud.setEligible(100);
  const got = [];
  for (let i = 0; i < 100; i++) got.push(turn(bud, 1e6));
  assert.ok(got[99] > 0, 'the last building got nothing — this is the bug the task exists to fix');
  assert.equal(got[0], got[99], 'first and last must receive the same slice when both want everything');
  assert.equal(got.filter((g) => g > 0).length, 100, 'every eligible building must get a share');
});

test('an unspent slice is REDISTRIBUTED, not stranded', () => {
  // 10 eligible, cap 1000 → 100 each. If the first 9 take nothing, the 10th should be able to draw
  // far more than its opening 100.
  const bud = createFairBudget(1000);
  bud.setEligible(10);
  for (let i = 0; i < 9; i++) turn(bud, 0);
  const last = turn(bud, 1e6);
  assert.ok(last > 100, `last building got ${last}; the 900 the others left should have flowed to it`);
  assert.ok(last <= 1000, 'still bounded by the cap');
});

test('a modest building is not forced to spend its whole slice', () => {
  const bud = createFairBudget(1000);
  bud.setEligible(10);
  assert.equal(turn(bud, 16), 16);
  assert.equal(bud.stats().remaining, 984, 'only what was actually spent leaves the pot');
});

test('a SUPPRESSED building consumes its slot but spends nothing', () => {
  // _detailSuppressed is set from the running vertex total, so the pre-pass cannot know it. Such a
  // building must still take its turn, or the denominator stays too high and every later slice
  // comes out too small.
  const a = createFairBudget(1000); a.setEligible(10);
  turn(a, 1e6, true);                       // suppressed
  assert.equal(a.stats().remaining, 1000, 'a suppressed building must not spend');
  assert.equal(a.stats().eligibleLeft, 9,  'but it MUST consume its slot');
});

test('over-counting eligibility is self-correcting, never a cap breach', () => {
  // The pre-pass predicate is a superset (it cannot see _detailSuppressed). An inflated denominator
  // must only make early slices conservative — it must never let the total exceed the cap.
  const bud = createFairBudget(40000);
  bud.setEligible(500);                     // claim only 100 actually turn up
  let total = 0;
  for (let i = 0; i < 100; i++) total += turn(bud, 1e6);
  assert.ok(total <= 40000, `spent ${total}`);
  assert.ok(total > 0, 'and it must still hand out detail rather than freezing');
});

test('zero eligible buildings hands out nothing and does not divide by zero', () => {
  const bud = createFairBudget(40000);
  bud.setEligible(0);
  assert.equal(bud.claim(true), false);
  assert.ok(Number.isFinite(bud.stats().share));
});

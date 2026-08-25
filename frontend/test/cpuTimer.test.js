/**
 * cpuTimer — the long-frame report BUDGET must be armed, not merely capped.
 *
 * Measured 2026-08-26: `longSeen` increments inside cpuTimer, but main.js DISCARDS every report
 * until the car is drivable ("loading is expected to produce long frames"). A 21 s load therefore
 * spent all 40 slots on frames that were thrown away, and not one `[frame]` line printed for the
 * whole session — it silently cost a full diagnostic drive. A 12 s load left slots over, so the SAME
 * build produced data on one run and nothing on the next. Intermittent blindness is worse than an
 * instrument that fails outright, because you trust the empty output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpuTimer } from '../src/ui/cpuTimer.js';

/** Drive `n` frames that each exceed the 50 ms long-frame threshold, through the real API. */
function longFrames(timer, n) {
  for (let i = 0; i < n; i++) {
    timer.start();          // frame boundary — finalizes the PREVIOUS frame
    timer.lap('rend');
    busyUntil(60);          // wall time is what the timer measures, so it must actually pass
  }
  timer.start();            // flush the last one
}

function busyUntil(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* the timer reads the clock, so burn real time */ }
}

test('a held budget is NOT consumed by frames nobody reports', () => {
  const seen = [];
  const t = createCpuTimer();
  t.onLongFrame((wall) => seen.push(wall), 50);
  t.holdLongFrames();
  longFrames(t, 6);                 // a slow load
  assert.equal(seen.length, 0, 'reports leaked out while held');
  t.armLongFrames();
  longFrames(t, 3);                 // now the measured thing starts
  assert.ok(seen.length > 0,
    'no report after arming — the load consumed a budget it was never allowed to spend');
});

test('arming RESETS the budget, so load length cannot decide whether a drive yields data', () => {
  const runs = [];
  for (const loadFrames of [2, 12]) {
    const out = [];
    const t = createCpuTimer();
    t.onLongFrame((wall) => out.push(wall), 50);
    t.holdLongFrames();
    longFrames(t, loadFrames);
    t.armLongFrames();
    longFrames(t, 3);
    runs.push(out.length);
  }
  assert.equal(runs[0], runs[1],
    `a short load yielded ${runs[0]} reports and a long load yielded ${runs[1]} — load length must ` +
    'not change how much diagnostic data the drive produces');
});

/**
 * The initial load is YIELD-BOUND, and the budget that fixes it must not survive the load.
 *
 * MEASURED 2026-08-27, the first time anything read the per-phase build totals:
 *
 *     initial tile load COMPLETE after 108 polls (~16200 ms), 14 tiles resident
 *     main-thread time by build phase (3095 ms total): p1 physics 752ms/132 · p4 clusters 589ms/124
 *       · p2 buildings 465ms/163 · p4 urban 389ms/263 · p1 rg:markings 256ms/251 · ...
 *
 * 3,095 ms of work, 16,200 ms of wall time. ~1,180 chunks averaging 2.63 ms — exactly
 * `FRAME_BUDGET_MS` — and each chunk ends in a yield costing a whole 16.7 ms frame. The main thread
 * is idle for ~84% of the load.
 *
 * The 3 ms cap is correct while DRIVING: it exists so tile work never piles onto a frame already
 * missing 60 fps, which was the measured high-speed stutter. It is wrong behind a loading overlay,
 * where nothing is being kept smooth.
 *
 * ⚠ SO THE RISK IS THE OPPOSITE ONE. If `LOAD_BUDGET_MS` leaks past the load — or the latch can
 * flip back — every tile that streams in at 80 km/h gets a 12 ms budget and the stutter the 3 ms cap
 * was introduced to fix comes straight back, in the exact regime the benchmark measures. These tests
 * read the source because `tileManager.js` cannot be imported outside Vite
 * (`./tileParserWorker.js?worker`), and are written to fail on the shapes that would cause that.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/map/tileManager.js', 'utf8');

const num = (name) => {
  const m = SRC.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)`));
  assert.ok(m, `${name} not found — it was renamed or removed; re-anchor this test`);
  return parseFloat(m[1]);
};

test('the drive-time budget is still the small one', () => {
  // If this grows, the high-speed streaming stutter is back and this file is the wrong place to
  // have changed it — the load budget is what should move.
  assert.ok(num('FRAME_BUDGET_MS') <= 4, 'FRAME_BUDGET_MS must stay small; it protects the drive');
  assert.ok(num('BUDGET_MAX') <= 5, 'BUDGET_MAX must stay small for the same reason');
});

test('the load budget is meaningfully larger, but not a whole frame', () => {
  const load = num('LOAD_BUDGET_MS');
  assert.ok(load >= 8, `LOAD_BUDGET_MS ${load} is too small to matter — the load stays yield-bound`);
  assert.ok(load <= 14, `LOAD_BUDGET_MS ${load} leaves the browser no frame at all`);
  assert.ok(load > num('FRAME_BUDGET_MS') * 2, 'it must be well clear of the drive budget');
});

test('the latch is ONE-WAY — the load budget can never come back mid-drive', () => {
  // The failure this prevents: a tile streaming in at 80 km/h gets 12 ms of build time and lands on
  // a frame that was already missing vsync.
  assert.match(SRC, /if \(!_initialLoadDone\) \{[\s\S]*?_initialLoadDone = true;/,
    'the latch must be set inside a `if (!_initialLoadDone)` guard');
  const assignments = SRC.match(/_initialLoadDone\s*=\s*(true|false)/g) || [];
  assert.deepEqual(assignments, ['_initialLoadDone = false', '_initialLoadDone = true'],
    'exactly one initialiser and one set-to-true — anything that sets it back to false reopens the ' +
    'load budget during a drive');
});

test('the adaptive drive budget only runs AFTER the load is done', () => {
  // Otherwise the two fight: the adaptive rule sees a long frame during the load (which is expected,
  // that is the point) and shrinks the budget the load needs.
  assert.match(SRC, /if \(_initialLoadDone && _lastUpdateAt\) \{/,
    'the adaptive shrink/grow must be gated on _initialLoadDone');
});

test('completing the load restores the drive budget in the same breath', () => {
  // Latching without resetting would leave _budgetMs at 12 until the adaptive rule walked it down
  // 0.6 ms at a time — about twenty frames of drive-time stutter right after the loader lifts.
  assert.match(SRC, /_initialLoadDone = true;\s*_budgetMs = FRAME_BUDGET_MS;/,
    'set the drive budget at the moment the latch flips, not eventually');
});

test('the load budget is applied to _budgetMs, not to a second variable', () => {
  // yieldToMain reads _budgetMs and nothing else. A parallel budget would be ignored in silence,
  // which is this codebase's favourite failure mode.
  assert.match(SRC, /else _budgetMs = LOAD_BUDGET_MS;/);
  assert.match(SRC, /const elapsed = performance\.now\(\) - _frameBudgetStart;\s*\n\s*if \(elapsed < _budgetMs\)/,
    'yieldToMain must still be the thing reading _budgetMs');
});

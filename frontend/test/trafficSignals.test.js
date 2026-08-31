/**
 * T-3 — the phase a car OBEYS must be the phase a driver SEES.
 *
 * The lamp is chosen in the fragment shader from `uSignalTime`; `isRedFor` is what the traffic AI
 * tests. If those two ever disagree, cars stop at green and drive through red — the worst class of
 * bug here, because every frame looks deliberate and nothing errors. These pin the timing so an
 * edit to one side without the other fails loudly.
 *
 * Cycle (per axis): green 0-10, amber 10-12, red 12-24. Axis B runs half a cycle behind A.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRedFor, axisForHeading, SIGNAL_CYCLE_S } from '../src/map/trafficSignalRenderer.js';

test('axis A: green early, amber mid, red late', () => {
  assert.equal(isRedFor(0, 0), false, 'green at t=0');
  assert.equal(isRedFor(0, 9), false, 'still green at 9');
  assert.equal(isRedFor(0, 10.5), true, 'amber counts as stop');
  assert.equal(isRedFor(0, 20), true, 'red');
});

test('the two axes are never both green — that is the whole point', () => {
  for (let t = 0; t < SIGNAL_CYCLE_S; t += 0.25) {
    const aGo = !isRedFor(0, t);
    const bGo = !isRedFor(1, t);
    assert.ok(!(aGo && bGo), `both axes green at t=${t}`);
  }
});

test('each axis does get a green — neither is starved', () => {
  let aGreen = 0, bGreen = 0;
  for (let t = 0; t < SIGNAL_CYCLE_S; t += 0.25) {
    if (!isRedFor(0, t)) aGreen++;
    if (!isRedFor(1, t)) bGreen++;
  }
  assert.ok(aGreen > 20, 'axis A gets a green window');
  assert.ok(bGreen > 20, 'axis B gets a green window');
  assert.equal(aGreen, bGreen, 'and the windows are equal — no favoured direction');
});

test('the cycle repeats exactly, so a long session cannot drift', () => {
  for (const t of [0, 3, 7.5, 11, 18, 23.9]) {
    assert.equal(isRedFor(0, t), isRedFor(0, t + SIGNAL_CYCLE_S));
    assert.equal(isRedFor(0, t), isRedFor(0, t + SIGNAL_CYCLE_S * 10));
  }
});

test('axis is chosen by the dominant heading component', () => {
  assert.equal(axisForHeading(0, 1), 0, 'north-south → axis A');
  assert.equal(axisForHeading(1, 0), 1, 'east-west → axis B');
  assert.equal(axisForHeading(0.2, 0.98), 0, 'mostly north-south');
  assert.equal(axisForHeading(-0.99, 0.1), 1, 'mostly east-west, direction-agnostic');
});

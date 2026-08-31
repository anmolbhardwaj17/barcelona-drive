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

// ── T-4 · per-junction phases ─────────────────────────────────────────────────────────────────
import { clusterJunctions } from '../src/map/trafficSignalRenderer.js';

test('signals at one crossing share a junction; the next crossing does not', () => {
  // Four corners of a junction, then a separate junction ~80 m away.
  const pts = [
    { x: 0, z: 0 }, { x: 9, z: 0 }, { x: 0, z: 9 }, { x: 9, z: 9 },
    { x: 80, z: 0 }, { x: 89, z: 0 },
  ];
  const g = clusterJunctions(pts);
  assert.equal(g[0].cluster, g[1].cluster, 'same crossing');
  assert.equal(g[0].cluster, g[3].cluster, 'opposite corner, same crossing');
  assert.notEqual(g[0].cluster, g[4].cluster, 'a junction 80 m away is a different junction');
});

test('a junction keeps its phase across rebuilds — no shared counter to lose', () => {
  // The offset is derived from the cluster centroid, so a tile reloading (or a neighbouring tile
  // containing the same crossing) must produce the SAME phase, or a junction would visibly jump.
  const a = clusterJunctions([{ x: 120, z: -40 }, { x: 128, z: -40 }]);
  const b = clusterJunctions([{ x: 120, z: -40 }, { x: 128, z: -40 }]);
  assert.equal(a[0].offset, b[0].offset);
  assert.equal(a[0].offset, a[1].offset, 'both poles of one junction share its phase');
});

test('different junctions genuinely land on different phases', () => {
  // The whole point of T-4: a single global phase made every junction in the city flip together.
  const offs = new Set();
  for (let i = 0; i < 40; i++) offs.add(clusterJunctions([{ x: i * 137, z: i * 91 }])[0].offset);
  assert.ok(offs.size > 8, `expected a spread of phases, got ${offs.size}`);
});

test('the offset never pushes a signal outside the cycle', () => {
  for (let i = 0; i < 200; i++) {
    const o = clusterJunctions([{ x: i * 53, z: -i * 31 }])[0].offset;
    assert.ok(o >= 0 && o < SIGNAL_CYCLE_S, `offset ${o} out of range`);
  }
});

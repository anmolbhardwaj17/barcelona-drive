/**
 * junctionContinuity — including N-58, the distinction that explained a wrong prediction.
 *
 * `junctionStepAudit.mjs` (offline, reads tiles) reported ~121 drivable junction height-steps. The
 * bake, looking at the same city, found **36 disagreeing nodes out of 130,308**. Both were correct:
 * the audit matches endpoints by POSITION within 1 m, the bake by shared NODE ID. Tiles carry no
 * node ids, so the offline tool cannot tell "one road at a join" from "two unconnected ways that
 * happen to end at the same spot" — and I read the gap as N-57 failing when it was not.
 *
 * The distinction decides which subsystem owns a defect, so it is worth pinning:
 *   shared node, heights disagree  -> RAMP PROFILE. There is no distance to ramp over.
 *   coincident, different nodes    -> TOPOLOGY. The ways are not connected at all.
 *
 * Run: npm test (in backend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectJunctionContinuity, collectCoincidentUnjoined }
  from '../worldBuilder/roads/junctionContinuity.js';

/** points are [x, y, z, absY]; the collectors read absY when present. */
function road(id, { nodeIds, xs, ys, type = 'residential', name = '' }) {
  return {
    id, nodeIds, highwayType: type, name,
    points: xs.map((x, i) => [x, ys[i], 0, ys[i]]),
  };
}

test('two ways sharing a node at the same height are continuous', () => {
  const a = road('a', { nodeIds: ['n0', 'JOIN'], xs: [0, 50], ys: [0, 0] });
  const b = road('b', { nodeIds: ['JOIN', 'n2'], xs: [50, 100], ys: [0, 0] });
  const res = collectJunctionContinuity([a, b]);
  assert.equal(res.totalDrivable, 0, 'no step where the heights agree');
});

test('two ways sharing a node at different heights are a step', () => {
  const a = road('a', { nodeIds: ['n0', 'JOIN'], xs: [0, 50], ys: [0, 0] });
  const b = road('b', { nodeIds: ['JOIN', 'n2'], xs: [50, 100], ys: [6, 6] });
  const res = collectJunctionContinuity([a, b]);
  assert.ok(res.totalDrivable > 0, 'a 6 m disagreement at a shared node must be reported');
});

test('N-58 — ends that coincide but do NOT share a node are counted separately', () => {
  // The exact case the offline audit cannot distinguish: same spot, different node ids.
  const a = road('a', { nodeIds: ['a0', 'a1'], xs: [0, 50], ys: [0, 0] });
  const b = road('b', { nodeIds: ['b0', 'b1'], xs: [50, 100], ys: [6, 6] });
  const joined = collectJunctionContinuity([a, b]);
  const coincident = collectCoincidentUnjoined([a, b]);
  assert.equal(joined.totalDrivable, 0,
    'no node is shared, so this is NOT a continuity defect — that was the misreading');
  assert.equal(coincident.pairs, 1, 'the ends coincide in plan');
  assert.equal(coincident.disagreeing, 1, 'and they disagree in height');
});

test('N-58 — a genuine shared node is NOT double-counted as coincident', () => {
  // Otherwise the two instruments would overlap and their sum would be meaningless.
  const a = road('a', { nodeIds: ['n0', 'JOIN'], xs: [0, 50], ys: [0, 0] });
  const b = road('b', { nodeIds: ['JOIN', 'n2'], xs: [50, 100], ys: [6, 6] });
  const coincident = collectCoincidentUnjoined([a, b]);
  assert.equal(coincident.pairs, 0, 'a shared node belongs to the continuity check, not this one');
});

test('N-58 — coincident ends at the SAME height are not a defect', () => {
  const a = road('a', { nodeIds: ['a0', 'a1'], xs: [0, 50], ys: [0, 0] });
  const b = road('b', { nodeIds: ['b0', 'b1'], xs: [50, 100], ys: [0, 0] });
  const res = collectCoincidentUnjoined([a, b]);
  assert.equal(res.pairs, 1, 'still a coincident pair');
  assert.equal(res.disagreeing, 0, 'but nothing disagrees, so nothing to report');
});

test('non-drivable ways are excluded — a car cannot drive a metro corridor', () => {
  // The first run of the continuity check reported 938 breaks, 586 of them "surface meets tunnel",
  // and 464 of the 466 non-drivable underground ways in this city are indoor metro `corridor`.
  // Counting them made the number big and unactionable.
  const a = road('a', { nodeIds: ['a0', 'a1'], xs: [0, 50], ys: [0, 0], type: 'corridor' });
  const b = road('b', { nodeIds: ['b0', 'b1'], xs: [50, 100], ys: [6, 6], type: 'corridor' });
  const res = collectCoincidentUnjoined([a, b]);
  assert.equal(res.pairs, 0, 'corridors must not appear in a drivable defect count');
});

/**
 * RampResolver — the FIRST backend tests in this project.
 *
 * ⚠ WHY THIS FILE EXISTS. Every ramp fix of the last week — N-41, N-45, N-46, N-47, N-52, N-56,
 * N-57 — lives in the bake, and the bake had **no tests at all**. All 395 tests were frontend. The
 * only instrument was a 10-minute full re-bake followed by an offline audit, which is why N-56
 * shipped a change that made junction steps 33% WORSE (133 -> 177) and nothing caught it until the
 * bake finished and the audit was run by hand.
 *
 * These assert the INVARIANTS the reconciler promises, because those are what a wrong fix breaks
 * first and they are exactly what a bake cannot tell you.
 *
 * Run: node --test backend/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRamps } from '../worldBuilder/roads/RampResolver.js';
import { LAYER_STEP } from '../worldBuilder/roads/LayerResolver.js';

/**
 * Build a graph of straight ways laid along +x, one metre per unit of `len`.
 * Points are Mercator {x, y}; `mercatorToWorld` turns them into real metres, and the ways here are
 * deliberately long enough that the grade limits are not the thing under test unless stated.
 */
function makeWay(id, { nodeIds, len = 100, pts = 11, tags = {}, bridge = false, tunnel = false, x0 = 0 }) {
  const points = [];
  for (let i = 0; i < pts; i++) points.push({ x: x0 + (i * len) / (pts - 1), y: 0 });
  return { id, nodeIds: nodeIds || Array.from({ length: pts }, (_, i) => `${id}n${i}`), points, tags, bridge, tunnel };
}

function graphOf(ways) {
  const wayMap = new Map(ways.map((w) => [w.id, w]));
  const nodeToWays = new Map();
  for (const w of ways) {
    for (const nid of w.nodeIds) {
      if (!nodeToWays.has(nid)) nodeToWays.set(nid, []);
      if (!nodeToWays.get(nid).includes(w.id)) nodeToWays.get(nid).push(w.id);
    }
  }
  return { wayMap, nodeToWays };
}

/** Heights a way ended up with, whether it ramped or stayed flat. */
function heights(result, id, n) {
  const r = result.get(id);
  assert.ok(r, `no result for way ${id}`);
  return r.vertexHeights || new Array(n).fill(r.baseHeight);
}

test('a way whose two ends want the same height is not a ramp', () => {
  const a = makeWay('a', {});
  const res = resolveRamps(graphOf([a]));
  assert.equal(res.get('a').isRamp, false, 'an isolated flat street must not be given a ramp profile');
});

test('an at-grade street meeting a bridge climbs, and ends at the bridge height', () => {
  // Shared END node: street 'a' ends where bridge 'b' begins.
  const a = makeWay('a', { nodeIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'JOIN'], pts: 6, len: 120 });
  const b = makeWay('b', { nodeIds: ['JOIN', 'b1', 'b2'], pts: 3, len: 60, bridge: true, x0: 120 });
  const res = resolveRamps(graphOf([a, b]));
  const ha = heights(res, 'a', 6);
  assert.ok(Math.abs(ha[5] - LAYER_STEP) < 0.51,
    `the joining end should reach the deck (${LAYER_STEP} m), got ${ha[5]}`);
  assert.ok(Math.abs(ha[0]) < 0.51, `the far end must stay on the ground, got ${ha[0]}`);
});

test('N-41 — the climb is local: a long street does not float halfway along', () => {
  // The bug this encodes: interpolating start->end across the WHOLE way lifted an ordinary street
  // that merely touched a flyover, so its midpoint sat half a layer step in the air. Measured at
  // the time: ramped surface roads floated >2 m 27.5% of the time against 4.4% for everything else.
  const a = makeWay('a', { nodeIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'JOIN'], pts: 6, len: 400 });
  const b = makeWay('b', { nodeIds: ['JOIN', 'b1'], pts: 2, len: 60, bridge: true, x0: 400 });
  const res = resolveRamps(graphOf([a, b]));
  const ha = heights(res, 'a', 6);
  // 400 m of street, a 6 m rise: at 0.12 the climb needs 50 m, so the first 300 m must be flat.
  assert.ok(Math.abs(ha[0]) < 0.01, `start must be flat, got ${ha[0]}`);
  assert.ok(Math.abs(ha[2]) < 0.01, `240 m from the deck must still be flat, got ${ha[2]}`);
  assert.ok(ha[5] > ha[4], 'the climb must happen adjacent to the elevated end');
});

test('N-57 — reconciliation leaves the FAR end of a way exactly where it was', () => {
  // The guard that stops the fix relocating the defect instead of removing it. Without it, closing
  // one node drags the other end and simply moves the step down the road — which is how N-56 turned
  // 133 steps into 177.
  const a = makeWay('a', { nodeIds: ['a0', 'a1', 'a2', 'a3', 'JOIN'], pts: 5, len: 200 });
  const b = makeWay('b', { nodeIds: ['JOIN', 'b1', 'b2'], pts: 3, len: 80, bridge: true, x0: 200 });
  const res = resolveRamps(graphOf([a, b]));
  const ha = heights(res, 'a', 5);
  assert.ok(Math.abs(ha[0]) < 0.01,
    `the far end must be untouched by any reconciliation, got ${ha[0]}`);
});

test('N-57 — a tunnel is never moved: floor slabs are baked under it', () => {
  // Moving a tunnel would lift it off its floor, and drivable-surface-implies-floor is
  // COMMIT-BLOCKING — that trades a visible step for an aborted bake.
  const t = makeWay('t', { nodeIds: ['t0', 't1', 'JOIN'], pts: 3, len: 150, tunnel: true });
  const s = makeWay('s', { nodeIds: ['JOIN', 's1', 's2'], pts: 3, len: 150, x0: 150 });
  const res = resolveRamps(graphOf([t, s]));
  const ht = heights(res, 't', 3);
  for (const h of ht) {
    assert.ok(Number.isFinite(h), 'tunnel heights must stay finite');
    assert.ok(h <= 0.01, `a tunnel must never be raised above grade by reconciliation, got ${h}`);
  }
});

test('every way gets a result, and no height is NaN', () => {
  // A NaN here does not throw — it silently produces geometry at an undefined height, and the
  // symptom is a road that vanishes rather than an error.
  const ways = [
    makeWay('flat', {}),
    makeWay('br', { bridge: true }),
    makeWay('tun', { tunnel: true }),
    makeWay('degenerate', { pts: 2, len: 0 }),
  ];
  const res = resolveRamps(graphOf(ways));
  for (const w of ways) {
    const r = res.get(w.id);
    assert.ok(r, `way ${w.id} produced no result`);
    for (const h of r.vertexHeights || [r.baseHeight]) {
      assert.ok(Number.isFinite(h), `way ${w.id} produced a non-finite height: ${h}`);
    }
  }
});

/**
 * Traffic turns through a junction instead of cutting across it.
 *
 * THE BUG. Traffic paths are LANE-OFFSET polylines (LANE_OFFSET = 2.2 m). At a 90-degree junction
 * the outgoing lane line does not start where the incoming one ends: driving east, the last point
 * sits 2.2 m south of centreline; the new northbound road's first point sits 2.2 m east of ITS
 * centreline — about 3.1 m away, in a different direction. extendPath called that "the dup join
 * point", skipped it, and appended from index 1, so a turning car jumped from its lane to a point
 * already up the next street and slid diagonally across the intersection.
 *
 * ⚠ NOT the turn-SELECTION logic. That was fixed earlier (the dot threshold, re-derived over
 * 20,902 way-ends) and is not what "traffic doesn't turn properly" was about the second time. The
 * cars were choosing turns correctly and then driving them as diagonals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { junctionArc } from '../src/car/trafficSystem.js';

/** East-then-north right angle, both ends offset into their own lane. */
const P0 = { x: 0, y: 10, z: 0 };        // arriving, heading +x
const P2 = { x: 4, y: 10, z: 4 };        // leaving, heading +z

test('a right-angle turn produces intermediate points', () => {
  const arc = junctionArc(P0, P2, 1, 0, 0, 1);
  assert.ok(arc && arc.length >= 2, 'a 90 degree turn must be rounded');
});

test('the arc bows toward the corner, not straight across', () => {
  const arc = junctionArc(P0, P2, 1, 0, 0, 1);
  // The straight cut is the P0->P2 diagonal. Every arc point must sit on the CORNER side of it,
  // i.e. further along +x for its z than the diagonal would be. That is the whole fix.
  for (const p of arc) {
    const onDiagonalX = p.z;             // diagonal is x === z between (0,0) and (4,4)
    assert.ok(p.x > onDiagonalX, `arc point (${p.x},${p.z}) must bow past the diagonal cut`);
  }
});

test('a straight continuation gets no arc', () => {
  assert.equal(junctionArc(P0, { x: 8, y: 10, z: 0 }, 1, 0, 1, 0), null);
});

test('a gentle bend gets no arc — it needs no help', () => {
  const d = 8 * Math.PI / 180;
  assert.equal(junctionArc(P0, { x: 8, y: 10, z: 0.5 }, 1, 0, Math.cos(d), Math.sin(d)), null);
});

test('elevation is carried across the junction', () => {
  const arc = junctionArc({ x: 0, y: 10, z: 0 }, { x: 4, y: 14, z: 4 }, 1, 0, 0, 1);
  for (const p of arc) {
    assert.ok(p.y >= 10 && p.y <= 14, `y ${p.y} must stay between the two ends`);
  }
  // Monotonic — a turning car should not bob.
  for (let i = 1; i < arc.length; i++) assert.ok(arc[i].y >= arc[i - 1].y);
});

test('a junction BEHIND the car is rejected rather than arced backwards', () => {
  // Outgoing heading that puts the ray intersection behind p0 — bad OSM geometry, not a turn.
  assert.equal(junctionArc(P0, { x: -4, y: 10, z: 4 }, 1, 0, 0, 1), null);
});

test('the arc never returns the endpoints themselves', () => {
  // extendPath still appends best.pts from index 1, so a duplicated P2 would stall the car.
  const arc = junctionArc(P0, P2, 1, 0, 0, 1);
  for (const p of arc) {
    assert.ok(!(p.x === P0.x && p.z === P0.z), 'must not repeat p0');
    assert.ok(!(p.x === P2.x && p.z === P2.z), 'must not repeat p2');
  }
});

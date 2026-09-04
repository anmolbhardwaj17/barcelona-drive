/**
 * S-2 · `connectedRoads[].tx/tz` must ALWAYS point away from the junction.
 *
 * `findIntersections` records every road twice — once at each endpoint. The start record used
 * `pts[1] - pts[0]` (outward) and the end record used `pts[last] - pts[last-1]` (INWARD), so the two
 * halves of every list carried opposite conventions. Its one consumer, `generateTrafficLights`,
 * derives WHICH SIDE OF THE ROAD a signal stands on from that vector — so signals stood on the
 * correct kerb at start-endpoints and the opposite kerb at end-endpoints. Every road contributes
 * exactly one of each, so this was structurally half of them, and nothing errored: a traffic light
 * on the wrong kerb still looks like a traffic light.
 *
 * `generateLaneArrows` had already hit the same inconsistency and worked around it locally with its
 * own `isAtEnd` test instead of fixing the source, which is how the shared value stayed wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIntersections } from '../src/map/roadInfraRenderer.js';

/** Two roads meeting at (100, 100): one starting there, one ending there. */
function tJunction() {
  return [
    // starts AT the junction and runs east
    { id: 1, name: 'A', highwayType: 'primary', width: 10,
      points: [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 180, y: 100 }] },
    // runs from the north and ENDS at the junction
    { id: 2, name: 'B', highwayType: 'primary', width: 10,
      points: [{ x: 100, y: 20 }, { x: 100, y: 60 }, { x: 100, y: 100 }] },
  ];
}

test('the tangent points AWAY from the junction at BOTH kinds of endpoint', () => {
  const inters = findIntersections(tJunction());
  const j = inters.find((i) => Math.hypot(i.x - 100, i.z - 100) < 1);
  assert.ok(j, 'the shared endpoint was not detected as a junction');
  assert.equal(j.connectedRoads.length, 2);

  for (const cr of j.connectedRoads) {
    // Step one metre along the tangent from the junction; it must move INTO that road, i.e. toward
    // the road's own far end, never back through the junction.
    const px = j.x + cr.tx, pz = j.z + cr.tz;
    const pts = cr.road.points;
    const far = Math.hypot(pts[0].x - j.x, pts[0].y - j.z) > 1 ? pts[0] : pts[pts.length - 1];
    const before = Math.hypot(far.x - j.x, far.y - j.z);
    const after = Math.hypot(far.x - px, far.y - pz);
    assert.ok(after < before,
      `road ${cr.road.id}: tangent (${cr.tx.toFixed(2)}, ${cr.tz.toFixed(2)}) points back through the junction`);
  }
});

test('the road that ENDS at the junction is the one the old code got backwards', () => {
  // Pinning the specific value, so a future refactor that "tidies" the negation fails here rather
  // than silently moving half the city's traffic lights across the road again.
  const j = findIntersections(tJunction()).find((i) => Math.hypot(i.x - 100, i.z - 100) < 1);
  const b = j.connectedRoads.find((cr) => cr.road.id === 2);
  // Road B approaches from the north (-z); outward from the junction is back north.
  assert.ok(Math.abs(b.tx) < 1e-6, `tx ${b.tx}`);
  assert.ok(b.tz < -0.99, `tz ${b.tz} — should point back up the road, not into the junction`);
});

test('THE ONE THAT MATTERS: the signal lands on the approaching driver\'s RIGHT', () => {
  // ⚠ My first version of this test could not fail. It compared the normal `(T_z, -T_x)` against an
  // approach direction `-T` — both linear in T, so the cross product is invariant under T → -T and
  // the assertion held with the bug in place. A test that passes either way is worse than no test.
  //
  // The fix is to define the approach WITHOUT the tangent record: a driver reaches this junction
  // travelling from the road's far end toward it. That is geometry, not convention, so it stays
  // fixed while the thing under test moves.
  const j = findIntersections(tJunction()).find((i) => Math.hypot(i.x - 100, i.z - 100) < 1);
  for (const cr of j.connectedRoads) {
    const pts = cr.road.points;
    const far = Math.hypot(pts[0].x - j.x, pts[0].y - j.z) > 1 ? pts[0] : pts[pts.length - 1];
    let ax = j.x - far.x, az = j.z - far.y;               // approach, from the far end inward
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;

    const nx = cr.tz, nz = -cr.tx;                        // the formula in generateTrafficLights

    // Right of a heading in this WORLD frame is (-D_z, D_x) — anchored to trafficSystem.buildPath,
    // the code that visibly puts cars in the right-hand lane. See the note at that call site.
    const rightX = -az, rightZ = ax;
    const dot = nx * rightX + nz * rightZ;
    assert.ok(dot > 0.99,
      `road ${cr.road.id}: signal is on the driver's ${dot < 0 ? 'LEFT' : 'wrong side'} (dot ${dot.toFixed(2)})`);
  }
});

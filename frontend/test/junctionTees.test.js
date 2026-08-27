/**
 * T-JUNCTIONS, and the guard rail that walls one off.
 *
 * USER-REPORTED, 2026-08-27: "in some intersections a railing is there so I can't cross the road."
 *
 * Cause: `getJunctionPoints` counts places where TWO OR MORE ROAD ENDPOINTS meet. At a T-junction
 * the side street ends but the through road passes straight through — one endpoint, not two — so the
 * cell is not a junction and nothing is clipped. Measured over the shipped v10 tiles, **11,934 of
 * 31,015 junctions (38.5%) are invisible to that rule.**
 *
 * For a guard rail this is not cosmetic: rails carry COLLIDERS (`buildBridgeGuardRailGeometry` and
 * the collider builder share one mask), so an unclipped rail on the through road is a wall across
 * the mouth of the side street.
 *
 * R-W1 did not cause this — it made it visible. The rail used to sit at half of a 4 m width, i.e.
 * INSIDE the carriageway; now it sits correctly at the kerb, which is exactly where a side street's
 * mouth opens.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getJunctionPoints } from '../src/map/roadRenderer.js';

/** A road as the renderer sees it: points are {x, y} in the world plane (y is the Z axis). */
const road = (id, pts, extra = {}) => ({
  id, highwayType: 'residential', points: pts.map(([x, y]) => ({ x, y })), ...extra,
});

/**
 * A T: the through road runs west→east through the origin WITH A VERTEX THERE, and the side street
 * ends on it. Two endpoints never coincide, which is the whole point.
 */
const TEE = [
  road(1, [[-50, 0], [0, 0], [50, 0]]),   // through road — passes through, does not end
  road(2, [[0, 0], [0, -40]]),            // side street — ends on the through road
];

/** A crossroads: four ways all ENDING at the origin. The rule has always seen these. */
const CROSS = [
  road(1, [[-50, 0], [0, 0]]),
  road(2, [[0, 0], [50, 0]]),
  road(3, [[0, 0], [0, -40]]),
  road(4, [[0, 0], [0, 40]]),
];

const near = (js, x, z, r = 3) => js.some((j) => Math.hypot(j.x - x, j.z - z) <= r);

test('a crossroads is found by the default rule (this is not what was broken)', () => {
  const js = getJunctionPoints(CROSS, 2);
  assert.ok(near(js, 0, 0), 'four ways ending at a point must be a junction');
});

test('a T-JUNCTION is INVISIBLE to the default rule — the defect, stated', () => {
  const js = getJunctionPoints(TEE, 2);
  assert.equal(near(js, 0, 0), false,
    'if this starts passing, the default rule changed — check every consumer (lane paint, ' +
    'sidewalks, kerbs) before celebrating, because they all clip on it');
});

test('includeTees finds the T-junction', () => {
  const js = getJunctionPoints(TEE, 2, true);
  assert.ok(near(js, 0, 0), 'a road ENDING on another road must open a junction');
});

test('includeTees does not invent junctions where roads merely pass near each other', () => {
  // Two parallel streets 8 m apart, neither touching. Opening a gap here would punch holes in
  // rails and kerbs along every road that runs beside another one.
  const parallel = [
    road(1, [[-50, 0], [50, 0]]),
    road(2, [[-50, 8], [50, 8]]),
  ];
  assert.equal(getJunctionPoints(parallel, 2, true).length, 0);
});

test('includeTees adds nothing for a road touching only ITSELF', () => {
  // A closed loop (a roundabout, a cul-de-sac ring) starts and ends at the same point.
  //
  // ⚠ The DEFAULT rule already calls that seam a junction, because the loop's own two endpoints
  // land in one cell and `count >= 2`. That is PRE-EXISTING and this change does not touch it —
  // asserting 0 here would be claiming a fix that was never made. What is asserted is the thing
  // `includeTees` is responsible for: it must not ADD anything, which is why `ids` is a Set of road
  // IDs rather than a count. (Whether a loop seam should be a junction at all is a separate
  // question; roundabouts are handled by detectRoundaboutZonesForRails on their own path.)
  const loop = [road(1, [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]])];
  assert.equal(getJunctionPoints(loop, 2, true).length, getJunctionPoints(loop, 2).length,
    'includeTees must not invent a junction where only one road is involved');
});

test('the junction radius covers the widest road meeting there', () => {
  // The gap in the through road's rail has to be at least as wide as the street opening into it.
  const wide = [
    road(1, [[-50, 0], [0, 0], [50, 0]], { highwayType: 'primary', kerbToKerbW: 17.4, carriagewayW: 13 }),
    road(2, [[0, 0], [0, -40]], { kerbToKerbW: 10.4, carriagewayW: 6 }),
  ];
  const js = getJunctionPoints(wide, 2, true);
  assert.ok(js.length >= 1);
  const j = js.find((q) => Math.hypot(q.x, q.z) <= 3);
  assert.ok(j.radius >= 17.4 - 0.01,
    `radius ${j.radius} must cover the widest road at the node, or the gap is narrower than the street`);
});

test('the default stays the default — no caller gets tee behaviour by accident', () => {
  // Lane paint, sidewalks and kerbs share this function and have the same blind spot. Fixing them
  // opens ~11,934 new gaps across the city, which is a look change to be made deliberately (R-J2),
  // not a side effect of a rail fix.
  assert.equal(getJunctionPoints(TEE, 2).length, getJunctionPoints(TEE, 2, false).length);
  assert.ok(getJunctionPoints(TEE, 2, true).length > getJunctionPoints(TEE, 2).length);
});

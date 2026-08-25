/**
 * The ground stack: who sits how high above the road, and in what order.
 *
 * WHY ASSERT THIS. Road paint drifted for months because each family measured its height from a
 * DIFFERENT base — some from the drawn road surface, some from the road base before its visual
 * lift, one (drain covers) from nothing at all. Every failure looked the same on screen: paint
 * buried in some places and floating in others, with polygonOffset hiding the burial at the grazing
 * angles distant road is viewed at. Nothing ever threw.
 *
 * These tests pin the RELATIONSHIPS, not the numbers — the numbers are art-tunable, the ordering is
 * not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUND_LAYERS, GROUND_LIFT, groundLift, roadSurfaceY, sidewalkSurfaceY, CURB_HEIGHT,
         ROAD_VISUAL_ABOVE_TERRAIN } from '../src/map/groundLayers.js';

test('the drawn road surface sits above the road base by exactly the visual lift', () => {
  assert.equal(roadSurfaceY(0), ROAD_VISUAL_ABOVE_TERRAIN);
  assert.equal(roadSurfaceY(12.5), 12.5 + ROAD_VISUAL_ABOVE_TERRAIN);
});

test('every paint class sits ABOVE the drawn road surface', () => {
  for (const [cls, lift] of Object.entries(GROUND_LIFT)) {
    assert.ok(lift > 0, `${cls} lift must be positive — a zero or negative lift is z-fighting at best`);
  }
});

test('paint order matches the depth order — a class drawn on top must also BE on top', () => {
  // If the depth bias says stencil beats marking but the geometry puts stencil lower, the two
  // disagree and which one wins becomes a function of viewing angle. That is the whole bug.
  const paint = ['marking', 'crossing', 'stencil'];
  for (let i = 1; i < paint.length; i++) {
    const lower = paint[i - 1], upper = paint[i];
    assert.ok(GROUND_LIFT[upper] > GROUND_LIFT[lower],
      `${upper} draws over ${lower} (bias ${GROUND_LAYERS[upper]} vs ${GROUND_LAYERS[lower]}) so it must sit higher too`);
    assert.ok(GROUND_LAYERS[upper] < GROUND_LAYERS[lower],
      `${upper} must have the more negative bias`);
  }
});

test('lane arrows clear the road surface by enough to survive a crowned ribbon', () => {
  // The reported failure: 0.06 measured from the road BASE was 0.01 above the SURFACE, which a
  // triangulated ribbon with any crown or junction blend swallows whole.
  const clearance = groundLift('stencil');
  assert.ok(clearance >= 0.035,
    `stencil clearance ${clearance} is under the ~3.5-4.5cm burial buildOnewayArrows recorded`);
});

test('the sidewalk is a kerb above the road, and tactile paving sits on the SIDEWALK', () => {
  assert.equal(sidewalkSurfaceY(0), roadSurfaceY(0) + CURB_HEIGHT);
  const tactile = sidewalkSurfaceY(0) + groundLift('tactile');
  assert.ok(tactile > sidewalkSurfaceY(0), 'tactile must sit on the sidewalk surface');
  assert.ok(tactile > roadSurfaceY(0) + groundLift('stencil'),
    'tactile is on a raised sidewalk — it must be above any paint lying on the road');
});

test('both surface helpers track the road, so nothing is placed at an absolute height', () => {
  // Drain covers used a bare constant with no elevation term: fine at sea level, metres wrong on
  // any of Barcelona's sloped streets.
  const slope = 37.25;
  // Tolerance, not equality: the sidewalk stack adds a kerb height at both ends, so the
  // difference carries normal binary-float residue. What matters is that the helpers TRACK the
  // road 1:1 — a constant would give a delta of 0 here, which is the bug being guarded against.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(roadSurfaceY(slope) - roadSurfaceY(0), slope);
  near(sidewalkSurfaceY(slope) - sidewalkSurfaceY(0), slope);
});

test('unknown classes fail loudly rather than silently placing geometry at zero', () => {
  assert.throws(() => groundLift('not-a-class'), /no lift for class/);
});

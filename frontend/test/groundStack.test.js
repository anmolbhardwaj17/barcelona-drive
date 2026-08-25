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
import { GROUND_LAYERS, GROUND_LIFT, groundLift, roadDeckY, sidewalkSurfaceY, CURB_HEIGHT,
         ROAD_VISUAL_ABOVE_TERRAIN, BAKED_SURFACE_ABOVE_ROAD_Y, MIN_PAINT_CLEARANCE }
  from '../src/map/groundLayers.js';

test('the drawn road surface sits above the road base by exactly the visual lift', () => {
  assert.equal(roadDeckY(0), ROAD_VISUAL_ABOVE_TERRAIN);
  assert.equal(roadDeckY(12.5), 12.5 + ROAD_VISUAL_ABOVE_TERRAIN);
});

test('every paint class sits ABOVE the drawn road surface', () => {
  for (const [cls, lift] of Object.entries(GROUND_LIFT)) {
    assert.ok(lift > 0, `${cls} lift must be positive — a zero or negative lift is z-fighting at best`);
  }
});

test('every paint class clears the TOP OF THE ASPHALT, not just the road deck', () => {
  // The invariant that actually matters, and the one the bug violated. roadDeckY() is base+0.05,
  // but the drawn asphalt is base+0.07 plus a per-vertex bump — so a lift under ~0.029 leaves
  // millimetres of clearance and the paint vanishes wherever the surface bumps up.
  // bikeLane is a road SURFACE, not paint laid on it, so it is exempt by design.
  for (const [cls, lift] of Object.entries(GROUND_LIFT)) {
    if (cls === 'tactile' || cls === 'bikeLane' || cls === 'gore' || cls === 'drain') continue;
    const clearance = lift - BAKED_SURFACE_ABOVE_ROAD_Y + ROAD_VISUAL_ABOVE_TERRAIN;
    assert.ok(clearance >= MIN_PAINT_CLEARANCE,
      `${cls} clears the asphalt by only ${(clearance * 100).toFixed(1)}cm — under ` +
      `${MIN_PAINT_CLEARANCE * 100}cm it disappears under surface bumps, which is the reported bug`);
  }
});

test('the shipped paint stack is reproduced exactly — these numbers were audited', () => {
  // 2026-07-16 paint-stack audit. Changing any of these moves shipped art, so it must be a
  // deliberate edit, not a side effect of refactoring the constants into a shared table.
  // Tolerance: these are sums of binary floats, so exact equality fails on 0.105 alone.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(roadDeckY(0) + groundLift('marking'), 0.10);              // lane lines
  near(roadDeckY(0) + groundLift('crossing'), 0.095);            // crosswalks
  near(roadDeckY(0) + groundLift('stencil'), 0.095);             // arrows / pictos / zona30
  near(roadDeckY(0) + groundLift('parkingZone'), 0.105);         // blue-zone / no-parking stripes
  near(roadDeckY(0) + groundLift('bikeLane'), 0.09);             // bike lane surface
});

test('lane arrows clear the road surface by enough to survive a crowned ribbon', () => {
  // The reported failure: 0.06 measured from the road BASE was 0.01 above the SURFACE, which a
  // triangulated ribbon with any crown or junction blend swallows whole.
  const clearance = groundLift('stencil');
  assert.ok(clearance >= 0.035,
    `stencil clearance ${clearance} is under the ~3.5-4.5cm burial buildOnewayArrows recorded`);
});

test('the sidewalk is a kerb above the road, and tactile paving sits on the SIDEWALK', () => {
  assert.equal(sidewalkSurfaceY(0), roadDeckY(0) + CURB_HEIGHT);
  const tactile = sidewalkSurfaceY(0) + groundLift('tactile');
  assert.ok(tactile > sidewalkSurfaceY(0), 'tactile must sit on the sidewalk surface');
  assert.ok(tactile > roadDeckY(0) + groundLift('stencil'),
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
  near(roadDeckY(slope) - roadDeckY(0), slope);
  near(sidewalkSurfaceY(slope) - sidewalkSurfaceY(0), slope);
});

test('unknown classes fail loudly rather than silently placing geometry at zero', () => {
  assert.throws(() => groundLift('not-a-class'), /no lift for class/);
});

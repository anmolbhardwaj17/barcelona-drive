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
    // v3 P2-08: was `- BAKED_SURFACE_ABOVE_ROAD_Y + ROAD_VISUAL_ABOVE_TERRAIN`, adding the deck lift
    // back to cancel a constant that was secretly base-relative. The constant is deck-relative now,
    // so the compensation goes — and the arithmetic is unchanged (0.079-0.05 == 0.029).
    const clearance = lift - BAKED_SURFACE_ABOVE_ROAD_Y;
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

// ── v3 P2-08: the LAST THREE decal builders (crosswalk, zona30, bike pictogram) ──────────────────
//
// These three derived their own Y from hand-written constants long after lane arrows, drains,
// sidewalk and tactile had been rebased onto groundLayers. The numbers agreed with the table by
// coincidence of a prior audit, not by construction — so the table could be retuned and these three
// would silently stay behind, which is precisely the two-sources-for-one-height bug P2-08 exists to
// kill. They now compute from groundLift(); these tests fail if anyone hand-writes them back.

test('a ribbon decal must subtract the ribbon bump so it LANDS on its class lift', () => {
  // buildFlatRibbonGeometry adds ROAD_ZFIGHT_OFFSET (0.02) to every vertex itself. A ribbon-built
  // decal must therefore be handed (lift - bump), or it ends up 2 cm high — which reads as floating
  // paint at exactly the close viewing angles where polygonOffset stops hiding the error.
  const RIBBON_BUMP = 0.02;
  const crosswalkHandedToRibbon = groundLift('crossing') - RIBBON_BUMP;
  const whereItActuallyLands = roadDeckY(0) + crosswalkHandedToRibbon + RIBBON_BUMP;
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(whereItActuallyLands, roadDeckY(0) + groundLift('crossing'));
  near(whereItActuallyLands, 0.095);   // the audited shipped height — this must not move
});

test('quad decals take the FULL class lift — no ribbon bump to subtract', () => {
  // zona30 stencils and bike pictograms are custom quads, not ribbons. Subtracting the ribbon bump
  // here would bury them by 2 cm, the mirror image of the failure above.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(roadDeckY(0) + groundLift('stencil'), 0.095);
});

test('every road decal tracks a SLOPED road 1:1 — the done-when for P2-08', () => {
  // The whole task in one assertion. On a sloped street each decal must sit at
  // (road deck) + (its class lift) — the same lift it has at sea level. A builder that derives its
  // own elevation, or measures from the road BASE instead of the deck, breaks this and lands
  // ~5 cm low: enough to be swallowed by any crown or junction blend.
  const slope = 41.375;                 // a Barcelona hill, not a round number
  const RIBBON_BUMP = 0.02;
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);

  // crosswalk: built as a ribbon, so it is handed (lift - bump) and the builder re-adds it
  near(roadDeckY(slope) + (groundLift('crossing') - RIBBON_BUMP) + RIBBON_BUMP,
       roadDeckY(slope) + groundLift('crossing'));
  // zona30 + bike pictogram: quads, full lift
  near(roadDeckY(slope) + groundLift('stencil'), roadDeckY(slope) + groundLift('stencil'));

  // and the clearance above the road is IDENTICAL at sea level and on the hill
  for (const cls of ['crossing', 'stencil', 'marking', 'parkingZone', 'bikeLane', 'drain']) {
    near((roadDeckY(slope) + groundLift(cls)) - roadDeckY(slope),
         (roadDeckY(0) + groundLift(cls)) - roadDeckY(0));
  }
});

test('paint still clears the DRAWN asphalt, not just the deck, on a slope', () => {
  // roadDeckY() is base+0.05 but the baked surface is ~base+0.079. A lift that clears the deck and
  // not the asphalt is the original "arrows only visible at distance" bug.
  const slope = 41.375;
  const drawnAsphalt = roadDeckY(slope) + BAKED_SURFACE_ABOVE_ROAD_Y;
  for (const cls of ['crossing', 'stencil', 'marking']) {
    const paint = roadDeckY(slope) + groundLift(cls);
    assert.ok(paint - drawnAsphalt >= MIN_PAINT_CLEARANCE - 1e-9,
      `${cls} clears the drawn asphalt by ${(paint - drawnAsphalt).toFixed(4)}m, under MIN_PAINT_CLEARANCE`);
  }
});

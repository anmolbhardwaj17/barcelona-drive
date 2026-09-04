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
import { readFileSync } from 'node:fs';
import { GROUND_LAYERS, GROUND_LIFT, groundLift, roadDeckY, sidewalkSurfaceY, CURB_HEIGHT,
         ROAD_VISUAL_ABOVE_TERRAIN, BAKED_SURFACE_ABOVE_ROAD_Y, MIN_PAINT_CLEARANCE,
         ROAD_BASED_LIFTS, TERRAIN_LIFT, TERRAIN_BASED_LIFTS, TERRAIN_LIFT_CLASS, terrainLift }
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

test('the shipped paint stack is pinned — these numbers move art, so they move deliberately', () => {
  // 2026-07-16 paint-stack audit, RE-ORDERED by Z-1 (2026-09-04). Changing any of these moves
  // shipped art, so it must be a deliberate edit, not a side effect of refactoring constants.
  // Tolerance: these are sums of binary floats, so exact equality fails on 0.105 alone.
  //
  // The audited 2026-07 values were marking 0.100 · crossing 0.095 · stencil 0.095 ·
  // parkingZone 0.105. They encoded the EXACT REVERSE of the depth-bias order for all four paint
  // classes, so which paint won depended on viewing angle.
  //
  // ⚠ Z-1 rebuilt the ladder in bias order at a 5 mm step held one step off the floor, and that was
  // an over-correction: crossings went from 1.6 cm proud of the asphalt to 3.1 cm and read as
  // FLOATING on screen. The order was the bug; the height was not. Now a 2 mm step at the lowest
  // base that clears MIN_PAINT_CLEARANCE — every class sits within 6 mm of where it shipped.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(roadDeckY(0) + groundLift('bikeLane'), 0.090);            // bike lane SURFACE (unchanged)
  near(roadDeckY(0) + groundLift('parkingZone'), 0.095);         // blue-zone / no-parking stripes
  near(roadDeckY(0) + groundLift('marking'), 0.097);             // lane lines
  near(roadDeckY(0) + groundLift('crossing'), 0.099);            // crosswalks — over the lines
  near(roadDeckY(0) + groundLift('stencil'), 0.101);             // arrows / pictos / zona30 — topmost
});

// ── Z-1: THE ASSERTION THIS WHOLE TASK EXISTS FOR ──────────────────────────────────────────────
test('depth-bias order and physical order AGREE for every pair that shares a base', () => {
  // groundLayers.js has two tables. Each was internally consistent and they encoded OPPOSITE orders
  // for the four paint classes — 5 inverted pairs of 21. Nothing looked wrong enough to chase
  // because the two orders swap over as the camera moves: polygonOffset's slope term grows with the
  // depth gradient and road is seen at a grazing angle, so the BIAS order wins down the street while
  // the few millimetres of real separation win under the bumper.
  const inverted = [];
  for (let i = 0; i < ROAD_BASED_LIFTS.length; i++) {
    for (let j = i + 1; j < ROAD_BASED_LIFTS.length; j++) {
      const a = ROAD_BASED_LIFTS[i], b = ROAD_BASED_LIFTS[j];
      const dBias = GROUND_LAYERS[a] - GROUND_LAYERS[b];   // negative => a is drawn on top
      const dLift = GROUND_LIFT[a] - GROUND_LIFT[b];       // positive => a is physically higher
      if (dBias === 0 || dLift === 0) continue;            // a tie in either is broken by the other
      if (Math.sign(dBias) === Math.sign(dLift)) {
        inverted.push(`${a} vs ${b}: bias puts ${dBias < 0 ? a : b} on top, height puts ${dLift > 0 ? a : b} on top`);
      }
    }
  }
  assert.deepEqual(inverted, [], `\n  ${inverted.join('\n  ')}\n`);
});

test('no paint class floats — clearance has a CEILING as well as a floor', () => {
  // The floor stops burial; this stops the opposite mistake, which shipped: Z-1 raised the whole
  // ladder to fix an ORDERING bug and the zebra crossings visibly lifted off the road. Paint is
  // paint — a couple of centimetres proud is a marking, four is a kerb.
  const MAX_PAINT_CLEARANCE = 0.025;
  for (const cls of ROAD_BASED_LIFTS) {
    if (cls === 'gore' || cls === 'drain' || cls === 'bikeLane') continue;   // surfaces, not paint
    const clearance = GROUND_LIFT[cls] - BAKED_SURFACE_ABOVE_ROAD_Y;
    assert.ok(clearance <= MAX_PAINT_CLEARANCE,
      `${cls} stands ${(clearance * 100).toFixed(1)}cm proud of the asphalt — that reads as floating`);
  }
});

test('tactile is excluded from the comparison because it measures from a different base', () => {
  // Its 0.005 is above the SIDEWALK, not the road deck. Ranking it against a paint lift compares
  // two numbers that are not in the same coordinate — the exact mistake the module documents twice.
  assert.ok(!ROAD_BASED_LIFTS.includes('tactile'));
  assert.ok(GROUND_LIFT.tactile !== undefined);
  assert.ok(sidewalkSurfaceY(0) > roadDeckY(0), 'the sidewalk is above the road deck');
});

test('Z-2a: terrain-relative classes agree too — the check that only covered road paint', () => {
  // The agreement assertion existed for ROAD_BASED_LIFTS only, so `parkingRenderer` could sit
  // outside the scheme with its markings at terrain+0.06 — ABOVE the road deck by height while its
  // absent bias put them below it — and nothing caught it. Same invariant, second base.
  const inverted = [];
  for (let i = 0; i < TERRAIN_BASED_LIFTS.length; i++) {
    for (let j = i + 1; j < TERRAIN_BASED_LIFTS.length; j++) {
      const a = TERRAIN_BASED_LIFTS[i], b = TERRAIN_BASED_LIFTS[j];
      const dBias = GROUND_LAYERS[TERRAIN_LIFT_CLASS[a]] - GROUND_LAYERS[TERRAIN_LIFT_CLASS[b]];
      const dLift = TERRAIN_LIFT[a] - TERRAIN_LIFT[b];
      if (dBias === 0 || dLift === 0) continue;
      if (Math.sign(dBias) === Math.sign(dLift)) {
        inverted.push(`${a} vs ${b}: bias puts ${dBias < 0 ? a : b} on top, height puts ${dLift > 0 ? a : b} on top`);
      }
    }
  }
  assert.deepEqual(inverted, [], `\n  ${inverted.join('\n  ')}\n`);
});

test('Z-2a: a street crossing a car park wins by HEIGHT as well as by bias', () => {
  // Both must hold, or which surface you see depends on the viewing angle — the Z-1 failure, in a
  // renderer that had never been enrolled. The markings were the offender at terrain+0.06.
  for (const k of ['parkingLot', 'parkingPaint']) {
    assert.ok(TERRAIN_LIFT[k] < ROAD_VISUAL_ABOVE_TERRAIN,
      `${k} sits at ${TERRAIN_LIFT[k]}, at or above the road deck (${ROAD_VISUAL_ABOVE_TERRAIN})`);
    assert.ok(GROUND_LAYERS[TERRAIN_LIFT_CLASS[k]] > GROUND_LAYERS.road,
      `${k}'s bias draws it OVER the road`);
  }
  // And the stall paint is above its own apron, or it is buried in the concrete it belongs to.
  assert.ok(TERRAIN_LIFT.parkingPaint > TERRAIN_LIFT.parkingLot);
  assert.ok(GROUND_LAYERS.parkingPaint < GROUND_LAYERS.parkingLot);
});

test('terrain-relative lifts are ordered by their biases too, and exist exactly once', () => {
  // GREEN_OFFSET_Y was declared identically in greensRenderer.js AND vegetationRenderer.js, and
  // areaFeaturesRenderer carried "above greens' 0.01" as a comment rather than as an import.
  assert.ok(TERRAIN_LIFT.green < TERRAIN_LIFT.area, 'greens sit under plaza/beach fills');
  assert.ok(GROUND_LAYERS.green > GROUND_LAYERS.beach, 'and the bias must say the same');
  assert.ok(GROUND_LAYERS.green > GROUND_LAYERS.pedArea);
  assert.equal(terrainLift('green'), TERRAIN_LIFT.green);
  assert.throws(() => terrainLift('nope'), /no terrain lift/);
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
  // The absolute height is NOT restated here. It was (`0.095`), and Z-1's re-order broke this test
  // for a reason that had nothing to do with what it tests — three tests each carried their own copy
  // of the shipped stack, which is the same duplication the module exists to end, reproduced in the
  // suite. One test owns the absolutes now: 'the shipped paint stack is pinned'.
});

test('quad decals take the FULL class lift — no ribbon bump to subtract', () => {
  // zona30 stencils and bike pictograms are custom quads, not ribbons. Subtracting the ribbon bump
  // here would bury them by 2 cm, the mirror image of the failure above.
  // Relationship only — the absolute lives in 'the shipped paint stack is pinned', once.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);
  near(roadDeckY(0) + groundLift('stencil'), roadDeckY(0) + GROUND_LIFT.stencil);
  assert.ok(GROUND_LIFT.stencil > GROUND_LIFT.marking,
    'a stencil is the topmost paint — if this flips, the bike pictograms go under the lane lines');
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

test('every ground CLASS is used by something — a dead row is an ordering guarantee that applies to nothing', () => {
  // ⚠ Found by a `_ddPick` on a Carrer de Badajoz zebra: `"what": "crosswalk", "depthBias": -14`.
  // Crosswalks were LIFTED as class `crossing` but DRAWN with the lane-line material, class
  // `marking` — so the `crossing` bias (−16) that Z-1 spent a whole pass ordering was applied to
  // nothing, and a zebra tied a lane line in bias while sitting 2 mm above it. Which won where they
  // cross came down to 2 mm of depth precision: the viewing-angle failure Z-1 exists to remove.
  //
  // This is a source grep rather than a runtime check because the renderers need a WebGL context —
  // but it catches the thing that actually went wrong: a class nobody asks for by name.
  const src = readFileSync(new URL('../src/map/roadRenderer.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/map/roadInfraRenderer.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/map/parkingRenderer.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/map/greensRenderer.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/map/areaFeaturesRenderer.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/map/busStopRenderer.js', import.meta.url), 'utf8');
  const unused = Object.keys(GROUND_LAYERS).filter((cls) => {
    if (cls === 'terrain') return false;              // the base — nothing declares it
    return !src.includes(`'${cls}'`);
  });
  assert.deepEqual(unused, [], `ground classes declared but never applied: ${unused.join(', ')}`);
});

/**
 * ── Z-2b ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The bus bay outline was enrolled in the DEPTH table (v3 P1 gave it `applyGroundLayer(mat,
 * 'marking')`) and never in the HEIGHT table: it kept a hand-rolled `MARKING_Y_OFFSET = 0.15`
 * measured from RAW TERRAIN, so it floated ~5 cm over the lane paint it is coplanar with. That is
 * the same bias/height disagreement Z-1 found across the road ladder — surviving in a renderer that
 * looked finished because the loud half of the fix had been applied.
 */
test('Z-2b: the bus bay outline takes its height from the marking class, not a literal', () => {
  const src = readFileSync(new URL('../src/map/busStopRenderer.js', import.meta.url), 'utf8');
  assert.match(src, /const MARKING_Y_OFFSET = groundLift\('marking'\)/,
    'a literal here silently re-opens the bias/height disagreement Z-1 closed');
  // and it must stack on the ROAD DECK, not on the terrain sample under the bay
  assert.match(src, /const y = roadDeckY\(oy\) \+ MARKING_Y_OFFSET/,
    'measuring paint from terrain ignores the road ribbon it is painted on');
});

test('Z-2b: the bus bay outline lands at the same height as the lane paint beside it', () => {
  // The number that matters on screen: both are class `marking` on the same road, so both must
  // resolve to one height. Before this they were 9.7 cm and 15 cm.
  const terrain = 12.5;
  const busBay = roadDeckY(terrain) + groundLift('marking');
  const laneLine = roadDeckY(terrain) + groundLift('marking');
  assert.equal(busBay, laneLine);
  assert.ok(Math.abs(busBay - (terrain + 0.097)) < 1e-9, `bus bay at ${busBay}`);
});

test('Z-2b: the two dead hand-rolled offsets stay deleted', () => {
  // BLEND_STRIP_Y_OFFSET (0.10) outlived buildRoadsideBlendStrip(), deleted in v3 P1-15.
  // APPROACH_Y_BIAS (0.06) belonged to _buildApproachAtPortal(), which nothing ever called — and it
  // was an ABSOLUTE Y, so on a real DEM the quad it placed would have sat at sea level.
  // Both were on the Z-2b list as surfaces to enrol; neither was a surface.
  for (const [file, name] of [['roadRenderer.js', 'BLEND_STRIP_Y_OFFSET'],
                              ['tunnelRenderer.js', 'APPROACH_Y_BIAS']]) {
    const src = readFileSync(new URL(`../src/map/${file}`, import.meta.url), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, new RegExp(name), `${name} is back in ${file}`);
  }
});

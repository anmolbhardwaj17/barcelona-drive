/**
 * groundLayers.js — THE authoritative stacking order for co-planar ground surfaces.
 *
 * Every flat surface that shares (or nearly shares) the ground plane used to carry its own ad-hoc
 * polygonOffset / Y-bump, and half of them collided at factor -2 — stacking became GPU luck
 * (footpath-over-road artifacts, marking flicker at distance). This table assigns each CLASS a
 * unique polygonOffset depth bias, ordered bottom → top. More negative = wins the depth test =
 * drawn on top. Numbers are spaced by 2 so a subclass can slot between neighbours without a
 * global renumber.
 *
 * RULES:
 * - New flat ground surface? Add a class here — do NOT hand-roll polygonOffset elsewhere.
 * - 3D geometry (curbs, buildings) doesn't belong here; it wins by having real height.
 * - Transparent ADDITIVE decals (streetlight pools, hero spills) are ordered by renderOrder +
 *   depthWrite:false, not polygonOffset — they layer above everything opaque by design.
 * - The bake-level clipping (bake-surface-clipping.md) removes true overlaps at the source; this
 *   table deterministically orders what legitimately remains stacked (paint ON asphalt etc.).
 */

import { BCN_DIMS } from './barcelona-constants.js';
import { registerMaterial } from './materialRegistry.js';
const CURB_HEIGHT = BCN_DIMS.CURB_HEIGHT;

export const GROUND_LAYERS = {
  terrain:      0,     // base — no bias
  green:       -2,     // parks / gardens / grass polygons over terrain
  beach:       -3,     // sand polygons — beat greens at the coast edge, lose to roads/promenades
  pedArea:     -3.4,   // plazas / pedestrian squares — over greens+beach, UNDER roads/sidewalks
                       //  (conservative: promote above roads only after checking plaza-road overlaps)
  // Z-2a: car parks. Both sit UNDER `road`, so a street crossing a car park covers it — by bias AND
  // by height, which is the whole point. Before this they had NO depth class at all and relied on a
  // hand-rolled Y: the surface at terrain+0.04 (below the road deck's +0.05, fine) but its MARKINGS
  // at +0.06, i.e. ABOVE the road deck while their absent bias put them below it. Exactly the
  // inversion Z-1 found in the road paint, in a renderer nobody had enrolled.
  parkingLot:  -3.6,   // the concrete apron
  parkingPaint: -3.8,  // its stall dividers — on the apron, still under the street
  road:        -4,     // asphalt ribbons (per-type priority Y-bumps still break carriageway ties)
  gore:        -5,     // junction gore fills sit ON asphalt, under everything painted
  drain:       -7,     // drain covers / utility plates — opaque, in the carriageway, ON asphalt but
                       //  UNDER all paint. Was hand-rolled at -2 (v3 P0-14), i.e. LESS negative than
                       //  road's -4, so covers lost the depth test to the asphalt they sit on.
  sidewalk:    -6,     // panot / plain sidewalk / chamfer fills
  bikeLane:    -8,     // green carril bici surface (on asphalt, under paint)
  tactile:     -10,    // tactile paving pads (on sidewalk)
  parkingZone: -12,    // blue-zone / no-parking stripes (on asphalt, under lane paint)
  marking:     -14,    // lane lines / centre lines / merged markings
  crossing:    -16,    // zebra stripes (over markings where they meet)
  stencil:     -18,    // zona30 / bike pictograms / one-way arrows — topmost paint
};


// ── PHYSICAL LIFT (metres above the ROAD SURFACE) ────────────────────────────────────────────────
//
// v3 P2-08. The table above orders ground surfaces in the DEPTH BUFFER. This one places them in
// SPACE, and the two solve different halves of the same problem: depth bias decides who wins a tie,
// but it cannot rescue a surface that is genuinely buried, and it cannot stop one that is genuinely
// floating from looking like it floats.
//
// WHY THIS EXISTS. Road paint sat at inconsistent heights measured from inconsistent bases:
//
//   road surface        = normalisedRoadY + ROAD_VISUAL_ABOVE_TERRAIN (0.05)
//   roadRenderer paint  = roadHeights[i] + 0.025..0.045          <- correct, measured from the SURFACE
//   roadInfra arrows    = normalisedRoadY + 0.06                 <- WRONG: measured from the road BASE
//
// The last one never applied ROAD_VISUAL_ABOVE_TERRAIN, so "0.06 above the road" was really 0.01
// above it. One centimetre does not survive a triangulated ribbon with any crown or junction blend,
// so the arrows were buried wherever the surface bulged — and polygonOffset hid that at the grazing
// angles distant road is viewed at, which is why it read as "they disappear when I get CLOSE".
//
// Every ground decal must now be placed as:  roadDeckY(x,z) + GROUND_LIFT[class]
// measured from the DRAWN surface, never from the road base and never from raw terrain.
export const GROUND_LIFT = {
  // ⚠ MEASURED FROM roadDeckY(), which is the road HEIGHTS value (base + 0.05) — NOT the top of
  // the drawn asphalt. Per the 2026-07-16 paint-stack audit the baked road surface actually sits at
  // base + 0.07 + a bump of 0.001-0.009, so a lift here must exceed ~0.020-0.029 before the paint
  // is above the asphalt at all. A "0.03 lift" is really 1-10 mm of clearance, which is what left
  // lane arrows buried wherever the surface bumped.
  //
  // ── Z-1 (2026-09-04): THE TWO TABLES USED TO ENCODE OPPOSITE ORDERS ──────────────────────────
  //
  // The previous note here flagged ONE disagreement — parking stripes geometrically above lane
  // lines while their depth bias put them under — and reproduced it rather than correcting it,
  // calling it "a candidate for the next paint pass". Measured across all 21 pairs, it was not one
  // straggler: the four PAINT classes were a **fully inverted block**, 5 inverted pairs, while the
  // three non-paint classes (gore, drain, bikeLane) agreed. Bottom → top:
  //
  //     by depth bias:  gore < drain < bikeLane < parkingZone < marking < crossing < stencil
  //     by height:      gore < drain < bikeLane < crossing < stencil < marking < parkingZone
  //
  // Both halves of the module were therefore correct in isolation and contradicted each other in
  // exactly the region that matters, which is why nothing ever looked wrong enough to chase: the
  // two orders swap over as the camera moves. `polygonOffset`'s slope term (`factor × m`) grows
  // with the depth gradient, and road is viewed at a grazing angle from a chase camera — so the
  // BIAS order wins down the street while the 5 mm of real separation wins under the bumper. Which
  // paint is on top changes as you drive toward it.
  //
  // RESOLVED IN THE DIRECTION OF THE BIAS, for two reasons. The bias order encodes the art intent
  // ("stencil = topmost paint") and it is physically right for the pair that actually overlaps on a
  // real street: a zebra is painted ACROSS the lane lines, so `crossing` belongs over `marking`.
  // And it is the order visible at the grazing angles road is mostly seen at, so matching the
  // geometry to it is the change that moves the least on screen.
  //
  // ⚠ THE LADDER IS A 2 mm STEP AT THE FLOOR, AND THAT MATTERS — the first cut used 5 mm and held
  // the base a step high "for margin", which nearly DOUBLED the zebra crossings' height above the
  // asphalt (1.6 cm → 3.1 cm) and more than doubled the stencils (1.6 → 3.6). User, on a Sants
  // crossing: *"they are pretty high in z axis and looks floating"* — correct. Paint does not need
  // clearance to be ORDERED; it needs clearance not to be BURIED, and only the order was broken.
  // Fixing an ordering bug by raising everything is fixing the wrong quantity.
  //
  // The order is unchanged and still asserted. The steps are now the smallest that keep it legible
  // to the depth buffer, and the base is the lowest that clears MIN_PAINT_CLEARANCE over the drawn
  // asphalt (deck + BAKED_SURFACE_ABOVE_ROAD_Y = deck + 0.029). Crossings sit 2.0 cm proud, against
  // the 1.6 cm that shipped for months without complaint.
  //
  // ⚠ ADDING A PAINT CLASS? Its lift and its bias must AGREE. `groundStack.test.js` asserts it for
  // every pair sharing a base — that assertion is the whole point of this note.
  gore:         0.005,
  drain:        0.020,
  bikeLane:     0.040,   // a SURFACE, not paint — sits under the lane paint
  parkingZone:  0.045,   // blue-zone / no-parking stripes (roadRenderer STRIPE_Y_ABOVE) -> 1.6 cm proud
  marking:      0.047,   // lane lines                                                   -> 1.8 cm
  crossing:     0.049,   // zebra — over the lane lines it is painted across             -> 2.0 cm
  stencil:      0.051,   // arrows / pictograms / zona30 — topmost paint                 -> 2.2 cm
  tactile:      0.005,   // ⚠ sits on the SIDEWALK surface — use sidewalkSurfaceY(), not roadDeckY()
};

/**
 * The classes whose GROUND_LIFT is measured from `roadDeckY()`, and which therefore share a base
 * and can be compared. `tactile` is deliberately absent — it is measured from the SIDEWALK surface,
 * so its 0.005 is not comparable with a paint lift and ordering it against one is meaningless.
 */
export const ROAD_BASED_LIFTS = ['gore', 'drain', 'bikeLane', 'parkingZone', 'marking', 'crossing', 'stencil'];

// ── TERRAIN-RELATIVE LIFTS ───────────────────────────────────────────────────────────────────────
//
// Z-1: the same "one height, two references" failure, one layer down. `GREEN_OFFSET_Y = 0.01` was
// declared **twice** — identically, in `greensRenderer.js` and `vegetationRenderer.js` — and
// `areaFeaturesRenderer.js` carried `AREA_OFFSET_Y = 0.02` with the comment *"above greens' 0.01"*,
// a numeric dependency on a constant it does not import and cannot see change. Three copies of one
// ladder, kept in agreement by hand.
//
// Values are unchanged, so nothing on screen moves; what changes is that there is now one of them.
// Ordering matches the GROUND_LAYERS biases (green -2 below beach -3 / pedArea -3.4), so the same
// agreement assertion covers this table too.
export const TERRAIN_LIFT = {
  green: 0.010,        // parks / gardens / grass polygons, straight onto terrain
  area:  0.020,        // beach / plaza / pedestrian-area fills — above greens so shared coast edges
                       //  do not z-race along the strip where a park meets the sand
  parkingLot: 0.020,   // Z-2a: level with the plaza fills — it is the same kind of thing, a paved
                       //  area on the ground. Ties in height are broken by the bias table.
  parkingPaint: 0.030, // 1 cm of stall divider on top. ⚠ BOTH stay BELOW roadDeckY() (0.05) so a
                       //  street crossing a car park wins by height as well as by bias. The old
                       //  0.06 markings did not, and that disagreement is a viewing-angle bug.
};

/**
 * Terrain-relative classes that share a base and can therefore be compared, the same way
 * ROAD_BASED_LIFTS names the road-deck-relative set. `groundStack.test.js` asserts bias order and
 * height order agree across this set too — the check that only covered road paint before Z-2a.
 */
export const TERRAIN_BASED_LIFTS = ['green', 'area', 'parkingLot', 'parkingPaint'];

/** The GROUND_LAYERS class each TERRAIN_LIFT entry is ordered by (`area` covers beach + pedArea). */
export const TERRAIN_LIFT_CLASS = { green: 'green', area: 'pedArea', parkingLot: 'parkingLot', parkingPaint: 'parkingPaint' };

/**
 * Height of the top of the DRAWN asphalt, above roadDeckY(). From the paint-stack audit: the
 * baked surface is base+0.07 plus a per-vertex bump of up to 0.009, while roadDeckY() is
 * base+0.05. Paint must clear THIS, not roadDeckY(), which is the trap the whole task is about.
 */
// ⚠ DECK-RELATIVE, and it was BASE-relative until 2026-08-25. The value was 0.079 — which is the
// surface's height above the road BASE (0.07 + a bump up to 0.009) — while the name and the comment
// above both promised "above roadDeckY()". The deck is itself base+0.05, so the constant overstated
// the asphalt by exactly ROAD_VISUAL_ABOVE_TERRAIN. Nothing shipped was misplaced (it had no
// production call sites), but the one test using it cancelled the error back out inline, which is
// what kept the mismatch invisible. That is the same two-references-for-one-height failure this
// whole module exists to end — in the constant meant to prevent it.
export const BAKED_SURFACE_ABOVE_ROAD_Y = 0.029;

/** Minimum clearance of paint above the drawn asphalt. Below ~1.5 cm it disappears under bumps. */
export const MIN_PAINT_CLEARANCE = 0.015;

/**
 * Height of the sidewalk walking surface, from the same normalised road elevation.
 *
 * v3 P2-08: sidewalks are kerb-height above the road deck, and anything placed on a
 * sidewalk (tactile paving, and later street furniture) must measure from HERE rather than adding
 * a kerb height of its own. roadRenderer had a second, unused convention — SIDEWALK_Y_OFFSET =
 * 0.08 above TERRAIN, which is 9 cm below this one — that was dead code and has been removed
 * rather than left as a trap for whoever wired it up next.
 */
export function sidewalkSurfaceY(normalisedY) {
  return roadDeckY(normalisedY) + CURB_HEIGHT;
}

/**
 * Kerb height, re-exported from the city dimensions so there is exactly ONE definition.
 *
 * Defining it here as well would have been the same mistake this task exists to fix: a second copy
 * of a height that must agree with the first, kept in sync by hand until it isn't.
 */
export { CURB_HEIGHT };

/** Lift for a terrain-relative ground class, in metres above the terrain mesh. */
export function terrainLift(layerClass) {
  const lift = TERRAIN_LIFT[layerClass];
  if (lift === undefined) throw new Error(`groundLayers: no terrain lift for class '${layerClass}'`);
  return lift;
}

/** Lift for a ground class, in metres above the drawn road surface. */
export function groundLift(layerClass) {
  const lift = GROUND_LIFT[layerClass];
  if (lift === undefined) throw new Error(`groundLayers: no lift for class '${layerClass}'`);
  return lift;
}

/**
 * The road DECK height for a normalised road elevation — i.e. what getRoadPointHeights() returns.
 *
 * ⚠ THIS IS NOT THE TOP OF THE ASPHALT, and the name that said it was (roadSurfaceY) misled the
 * author of this very function inside one session. The drawn surface sits BAKED_SURFACE_ABOVE_ROAD_Y
 * higher again. Paint must clear that, not this. GROUND_LIFT values are measured from here because
 * that is what every existing call site stacks on.
 *
 * `normalisedY` must already have been through toNormalizedRoadY / normRoadElev. Decals that skip
 * this are measuring from the road BASE and land ~5 cm low, which is enough to bury them.
 */
export function roadDeckY(normalisedY) {
  return normalisedY + ROAD_VISUAL_ABOVE_TERRAIN;
}

/**
 * Lift of the road ribbon above the terrain mesh.
 *
 * ⚠ SINGLE DEFINITION. This was a module-local const in roadRenderer.js, which is why
 * roadInfraRenderer could not apply it and silently didn't. Anything placing geometry on the road
 * imports it FROM HERE.
 */
export const ROAD_VISUAL_ABOVE_TERRAIN = 0.05;

/** Apply a class's depth bias to a material (factor and units kept equal — consistent slope+const bias). */
export function applyGroundLayer(material, layerClass) {
  const bias = GROUND_LAYERS[layerClass];
  if (bias === undefined) throw new Error(`groundLayers: unknown class '${layerClass}'`);
  (material.userData ||= {})._groundLayer = layerClass;   // v3 P0-14: lets assertGroundLayers() tell
                                                          // a compliant material from a hand-rolled one
  // ⚠ REGISTER, OR THE STREET LIGHTS CANNOT SEE IT. `patchLightGrid` is applied through
  // `onMaterialRegistered`, so a material that never enters the registry is never patched and is
  // lit by the ambient rig ALONE. Every ground marking went through here and none of them
  // registered, which is why at night the zebra crossings and lane lines read BLUE while the
  // asphalt they are painted on — registered via patchRoadAO — read warm under the same lamp.
  // White paint under a blue-only rig can only return blue.
  // Unlit classes (MeshBasic pictograms, zona30) still land on patchLightGrid's silent no-op guard
  // and are reported under ?debug=init; registering them costs nothing and makes them visible to
  // the diagnostics instead of invisible to everything.
  registerMaterial(material, `ground:${layerClass}`);
  if (bias === 0) {
    material.polygonOffset = false;
  } else {
    material.polygonOffset = true;
    material.polygonOffsetFactor = bias;
    material.polygonOffsetUnits = bias;
  }
  return material;
}

/**
 * v3 P0-14 — dev guard. Flags any mesh whose material sets polygonOffset without going through
 * applyGroundLayer(). Warns rather than throws: a false positive should not be able to take the
 * game down mid-drive, and console.warn is visible in this project's DevTools setup where
 * console.log is filtered out.
 *
 * EXEMPT, per the RULES above: transparent decals with depthWrite:false (streetlight pools, hero
 * spills, pole shadows) are ordered by renderOrder, not by depth bias.
 */
let _glWarned = 0;
export function assertGroundLayers(mesh) {
  if (!import.meta.env?.DEV || _glWarned > 12) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (!m?.polygonOffset) continue;
    if (m.userData?._groundLayer) continue;              // compliant
    if (m.transparent && m.depthWrite === false) continue; // decal — ordered by renderOrder
    _glWarned++;
    console.warn(
      `[groundLayers] hand-rolled polygonOffset (factor ${m.polygonOffsetFactor}) on ` +
      `"${mesh.userData?.type || mesh.name || m.type}" — add a class to groundLayers.js and use ` +
      `applyGroundLayer() instead. Ad-hoc biases collide and make stacking GPU luck.`
    );
  }
}

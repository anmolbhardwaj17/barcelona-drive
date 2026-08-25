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
const CURB_HEIGHT = BCN_DIMS.CURB_HEIGHT;

export const GROUND_LAYERS = {
  terrain:      0,     // base — no bias
  green:       -2,     // parks / gardens / grass polygons over terrain
  beach:       -3,     // sand polygons — beat greens at the coast edge, lose to roads/promenades
  pedArea:     -3.4,   // plazas / pedestrian squares — over greens+beach, UNDER roads/sidewalks
                       //  (conservative: promote above roads only after checking plaza-road overlaps)
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
  // These values reproduce the audited stack exactly, so nothing shipped moves:
  //   lane lines base+0.100 · parking stripes base+0.105 · crosswalks base+0.095
  //   arrows/pictos/zona30 base+0.095 · bike lanes base+0.090
  //
  // NOTE the parking stripes sit ABOVE lane lines geometrically while their depth bias (-12) puts
  // them UNDER lane paint (-14). That mismatch is shipped and audited, so it is reproduced rather
  // than silently "corrected" here — but it is exactly the kind of disagreement that makes which
  // surface wins depend on viewing angle, and it is a candidate for the next paint pass.
  gore:         0.005,
  drain:        0.020,
  bikeLane:     0.040,   // a SURFACE, not paint — sits under the lane paint
  parkingZone:  0.055,   // blue-zone / no-parking stripes (roadRenderer STRIPE_Y_ABOVE) -> base+0.105
  crossing:     0.045,   // zebra
  stencil:      0.045,   // arrows / pictograms / zona30 — matches roadRenderer exactly
  marking:      0.050,   // lane lines
  tactile:      0.005,   // ⚠ sits on the SIDEWALK surface — use sidewalkSurfaceY(), not roadDeckY()
};

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

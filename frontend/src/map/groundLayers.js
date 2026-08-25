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
// Every ground decal must now be placed as:  roadSurfaceY(x,z) + GROUND_LIFT[class]
// measured from the DRAWN surface, never from the road base and never from raw terrain.
export const GROUND_LIFT = {
  gore:         0.005,
  drain:        0.010,
  bikeLane:     0.015,
  parkingZone:  0.020,
  marking:      0.030,   // matches roadRenderer MARKING_Y_ABOVE_ROAD
  crossing:     0.035,   // zebra — was 0.025, raised to clear the same ribbon bulge
  stencil:      0.040,   // arrows / pictograms — topmost paint
  tactile:      0.005,   // ⚠ sits on the SIDEWALK surface — use sidewalkSurfaceY(), not roadSurfaceY()
};

/**
 * Height of the sidewalk walking surface, from the same normalised road elevation.
 *
 * v3 P2-08: sidewalks are kerb-height above the DRAWN road surface, and anything placed on a
 * sidewalk (tactile paving, and later street furniture) must measure from HERE rather than adding
 * a kerb height of its own. roadRenderer had a second, unused convention — SIDEWALK_Y_OFFSET =
 * 0.08 above TERRAIN, which is 9 cm below this one — that was dead code and has been removed
 * rather than left as a trap for whoever wired it up next.
 */
export function sidewalkSurfaceY(normalisedY) {
  return roadSurfaceY(normalisedY) + CURB_HEIGHT;
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
 * The height of the DRAWN road surface for a normalised road-deck elevation.
 *
 * `normalisedY` must already have been through toNormalizedRoadY / normRoadElev — this adds only
 * the visual lift the road mesh itself applies. Decals that skip this are measuring from the road
 * BASE and will be ~5 cm low, which is enough to bury them.
 */
export function roadSurfaceY(normalisedY) {
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

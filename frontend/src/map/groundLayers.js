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

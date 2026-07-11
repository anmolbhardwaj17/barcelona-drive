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
  road:        -4,     // asphalt ribbons (per-type priority Y-bumps still break carriageway ties)
  gore:        -5,     // junction gore fills sit ON asphalt, under everything painted
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
  if (bias === 0) {
    material.polygonOffset = false;
  } else {
    material.polygonOffset = true;
    material.polygonOffsetFactor = bias;
    material.polygonOffsetUnits = bias;
  }
  return material;
}

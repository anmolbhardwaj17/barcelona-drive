/**
 * Shared-material ownership (v3 P0-02).
 *
 * Tile unload disposes a mesh's material unless it is known to be shared. The pre-v3 test was
 * `mesh.userData.sharedMaterial` — a flag on the MESH. That is the wrong place for it: a mesh does
 * not reliably know whether its material is a module-level singleton, so every new call site is a
 * fresh chance to forget the tag, and forgetting it destroys a city-wide resource on the first tile
 * unload with no error. Two such misses already exist (roadRenderer bikepictogram + zona30Stencil);
 * both happen to sit behind disabled CONFIG flags today, which is luck, not design.
 *
 * A MATERIAL, by contrast, always knows what it is. `markShared()` is called once where the
 * singleton or cache entry is created, and every mesh that ever uses it is protected automatically.
 *
 * ⚠ Deliberately NOT the blanket "invert the default to opt-in" the v3 plan proposed for P0.
 * A survey of all 169 material-construction sites found 103 that build a material per call
 * (urbanFeatureRenderer ×16, roadInfraRenderer ×13, …), so inverting without a registry to
 * enforce tagging would leak them — and long-session heap growth is a phase gate. P1's
 * `materialRegistry.js` should call `markShared()` on everything it owns, at which point the
 * inversion becomes safe and this module folds into it.
 */

/** Mark a material as a shared/cached singleton: tile unload must never dispose it. Returns it. */
export function markShared(mat) {
  if (mat) {
    if (Array.isArray(mat)) { mat.forEach(markShared); return mat; }
    (mat.userData ||= {}).shared = true;
  }
  return mat;
}

/** True if this material (or any material in an array) is shared and must survive tile unload. */
export function isShared(mat) {
  if (!mat) return false;
  if (Array.isArray(mat)) return mat.some((m) => m?.userData?.shared === true);
  return mat.userData?.shared === true;
}

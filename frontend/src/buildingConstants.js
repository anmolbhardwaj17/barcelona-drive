/**
 * buildingConstants.js — the single source of truth for facade geometry + AO tuning (v3 P1-13).
 *
 * These were TRIPLE-MIRRORED across workers/buildingWorker.js, workers/meshMaterializer.js and
 * map/buildingRenderer.js, with the AO pair mirrored again in map/aoSampler.js. Four copies of a
 * number that MUST agree: the worker bakes UVs against it, the materializer sizes the canvas texture
 * against it, and the LOD renderer paints distant buildings against it. Any drift is invisible until
 * near and far buildings stop matching.
 *
 * ⚠ P3 WILL CHANGE THESE. Read this before touching FLOOR_HEIGHT:
 *
 *   FLOOR_HEIGHT = 10 is NOT a storey height. It is the vertical spacing the facade UV uses, and it
 *   does not divide the ~3.0 m texture row period. The v3 audit measured the consequence: a
 *   shopfront row painted in MID-AIR on 88.5% of buildings (36,122 of 40,828 at >= 10 m), and twice
 *   on 30.8% of them. The real storey height from the bake is ~3.5 m.
 *
 *   Do NOT "fix" it to 3.5 in isolation — the texture, the UV mapping and the band geometry have to
 *   move together. That is P3's modular-storey-band rebuild (v3-master-plan.md §5.3).
 */

/** Vertical spacing of one facade texture row, in metres. See the warning above. */
export const FLOOR_HEIGHT = 10;

/** Horizontal world metres per facade texture repeat. */
export const WALL_REPEAT_HORIZONTAL_M = 12;

/** Baked sky-visibility AO on building walls at street level. Mirrored from aoSampler's dial set. */
export const AO_FACADE_STRENGTH = 0.50;

/** AO curve shape. >1 keeps mid-tones bright and darkens only genuinely enclosed spots. */
export const AO_GAMMA = 1.2;

// ── v3 P3-02: modular storey bands ───────────────────────────────────────────────────────────────

/** Real storey height in metres — the vertical period of ONE window row. */
export const STOREY_H = 3.5;

/** Crown band height in metres. Small: it exists so the top reads as a cornice against the sky. */
export const CROWN_H = 1.2;

/**
 * Ground-floor (shopfront) height per category, in metres.
 *
 * ⚠ FOURTH MIRROR, KILLED HERE. These were `WINDOW_STYLES[...].marginB` inside
 * `workers/meshMaterializer.js`, where the canvas painter used them to place the shopfront band.
 * The band GEOMETRY now has to agree with that placement to the metre — the ground band's UV
 * top is `groundH / FLOOR_HEIGHT`, which is exactly the fraction the painter fills. Two copies of
 * that number would drift and the shopfront would straddle the band seam, which is worse-looking
 * than the mid-air shopfront it replaces. Same reasoning as P1-13.
 */
export const FACADE_GROUND_H_M = {
  residential:      3.8,
  commercial:       4.0,
  commercial_glass: 3.5,
  office:           3.5,
  hospital:         3.0,
  school:           3.0,
  industrial:       3.0,
  religious:        1.5,
};

/** Ground-floor height for a category, falling back to the residential norm. */
export function groundFloorH(category) {
  return FACADE_GROUND_H_M[category] ?? FACADE_GROUND_H_M.residential;
}

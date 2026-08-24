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

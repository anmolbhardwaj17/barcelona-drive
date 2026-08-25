/**
 * facadeArray.js — v3 P3-04. The facade array-texture model and its UV spec.
 *
 * ═══ WHY AN ARRAY AND NOT AN ATLAS ═══════════════════════════════════════════════════════════════
 * Band UVs tile vertically: a body band spans v 0 → N for an N-storey building. An atlas cannot do
 * that — you would need `fract()` to fold v back into the sub-rect, and `fract()` is discontinuous,
 * so the mip derivative explodes on the wrap line and every storey boundary seams. Array layers wrap
 * INDEPENDENTLY and natively, which is the whole reason for the format.
 *
 * ═══ THE TENSION IN THE PLAN, AND HOW IT IS RESOLVED ═════════════════════════════════════════════
 * The task asks for "8 × 1024² albedo" AND "ground-floor module rect and body module rect on the same
 * layer" AND rejects `fract()` seams. Those three cannot all hold: putting two rects on one layer is
 * exactly the atlas case it rejects, one level down.
 *
 * Resolved by SPLITTING THE ARRAYS, which the plan's own "per-vertex uint8 aLayer" already licenses:
 *
 *   BODY array   8 × 1024²   one layer per variant, wrapping v per storey — 8 variants preserved
 *   GROUND array 8 × 512²    one layer per variant, addressed ONCE (v 0→1), never wrapped
 *
 * The ground floor is ONE storey tall and never tiles vertically, so it does not need the body's
 * vertical resolution — 512² over 8.0 m × 4.0 m is 64 texels/m across and 128 down, matching the
 * body's VERTICAL density at a quarter of the memory per layer.
 *
 * ⚠ THIS COSTS VRAM, IT DOES NOT SAVE IT. Measured, uncompressed:
 *     plan as written   8×1024² albedo + 8×1024² normal + 8×512² mask   = 72.0 MiB
 *     split arrays      body 8×1024² a+n (64.0) + ground 8×512² a+n (16.0) = 80.0 MiB
 *   — and the split figure does not yet include a window mask, which would add ~8 MiB more.
 *   So the split is **+8 to +16 MiB against the plan**, bought to avoid `fract()` seams on every
 *   storey boundary. That is the trade; it is not free, and an earlier draft of this comment claimed
 *   it was cheaper, which was simply wrong. KTX2/BC7 is roughly 4:1, so the shipped cost is about a
 *   quarter of these numbers — but it must still be counted against the 200 MiB texture budget in
 *   the performance ledger, and NOT double-counted with P3-05's art budget.
 *
 * If that overrun matters more than the seams, the lever is the GROUND array: shopfronts vary far
 * less than bodies, so 4 layers instead of 8 halves it back to parity.
 *
 * A vertex carries the layer for the band it belongs to: ground-band vertices index the GROUND array,
 * body and crown vertices index the BODY array. No `fract()`, no seams, 8 variants intact.
 *
 * ═══ THE UV SPEC — P3-05 AUTHORS TO THIS ═════════════════════════════════════════════════════════
 * Per layer, u runs 0→1 across `LAYER_W_M` metres and v runs 0→1 across `LAYER_H_M` metres.
 *
 *   BODY layer    8.0 m wide × 8.0 m tall = 2 storeys of 4.0 m. 1024² → 128 texels/m.
 *                 MUST tile seamlessly in BOTH axes: u wraps around corners, v wraps every 2 storeys.
 *                 The top edge must meet the bottom edge — a window row split across that seam is the
 *                 single most visible authoring error.
 *   GROUND layer  8.0 m wide × 4.0 m tall, one shopfront module. 512² → 64 texels/m across, 128 down.
 *                 MUST tile in u (shopfronts repeat along a street) but NEVER in v — the bottom edge
 *                 is the pavement and the top edge meets the body band's first row.
 */

/** Metres one layer spans horizontally. Both arrays share it so u repeats stay consistent. */
export const LAYER_W_M = 8.0;
/** Metres a BODY layer spans vertically — 2 storeys, so the tile is not obviously periodic. */
export const BODY_LAYER_H_M = 8.0;
/** Metres a GROUND layer spans vertically — one shopfront module. */
export const GROUND_LAYER_H_M = 4.0;

/** Body variants. Index = layer index in the body array. Order is the authoring order for P3-05. */
export const BODY_LAYERS = [
  'residential_a', 'residential_b', 'residential_c', 'residential_d', 'residential_e',
  'commercial', 'office', 'industrial_brick',
];

/** Ground variants, same indices where a family exists; falls back to the residential shopfront. */
export const GROUND_LAYERS = [
  'shopfront_a', 'shopfront_b', 'shopfront_c', 'shopfront_plain', 'shopfront_shutter',
  'commercial_lobby', 'office_lobby', 'industrial_door',
];

/** Which body layer a building category maps to. */
const CATEGORY_BODY = {
  residential: [0, 1, 2, 3, 4],     // spread across the five residential variants
  commercial: [5],
  commercial_glass: [5],
  office: [6],
  hospital: [6],
  school: [6],
  industrial: [7],
  religious: [7],
};

/**
 * Deterministic per-building variant pick.
 *
 * ⚠ MUST be stable across reloads and across tile boundaries. A building that straddles two tiles is
 * emitted by both, and a random pick would give its halves different facades — a seam down the middle
 * of a building that only shows at specific camera angles. Hashing the OSM id gives the same answer
 * everywhere, forever.
 */
export function facadeLayerFor(category, buildingId) {
  const options = CATEGORY_BODY[category] || CATEGORY_BODY.residential;
  if (options.length === 1) return options[0];
  // xorshift-ish integer hash — id values are large and sequential, so `% n` alone clusters badly.
  let h = (buildingId | 0) || 1;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return options[Math.abs(h) % options.length];
}

/** Ground layer for a category — same index space, so a variant family stays coherent. */
export function groundLayerFor(category, buildingId) {
  return facadeLayerFor(category, buildingId);
}

/**
 * UV repeats for one band, in layer space.
 *
 * ⚠ The BODY repeat is in units of BODY_LAYER_H_M (2 storeys), NOT one storey. Authoring a
 * single-storey tile and repeating it per storey is the obvious mistake and reads as an unnaturally
 * regular grid — the 2-storey period exists to break that up.
 */
export function bandUV(bandKind, wallLengthM, bandHeightM) {
  const u = wallLengthM / LAYER_W_M;
  if (bandKind === 'ground') return { uRepeat: u, vRepeat: 1 };   // never tiles vertically
  const h = bandKind === 'crown' ? BODY_LAYER_H_M : BODY_LAYER_H_M;
  return { uRepeat: u, vRepeat: bandHeightM / h };
}

/** Texel density of a layer, for the art-bible check (target 85–150 texels/m). */
export function texelDensity(pixels, metres) { return pixels / metres; }

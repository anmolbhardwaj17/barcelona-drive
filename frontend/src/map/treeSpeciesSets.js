/**
 * treeSpeciesSets.js — which tree species belongs where. v3 P3-10(a), tier 3.
 *
 * WHY THIS IS A SHARED MODULE. Two places pick a tree's species and they must agree: the vegetation
 * worker (street, park, coast, courtyard trees) and environmentClusterRenderer (the background and
 * hillside clusters). The cluster renderer originally picked at random, which is how palms ended up
 * on hillsides — it had been wired to the card geometry but never to the classifier. Sharing the
 * table rather than copying it is what stops that gap reopening.
 *
 * No THREE import, no DOM: this file is pulled into a Web Worker bundle.
 */

// Indices MUST match the atlas cell order in treeAtlas.js.
export const SP_PLANE = 0, SP_TIPUANA = 1, SP_CELTIS = 2,
             SP_PALM = 3, SP_JACARANDA = 4, SP_ORANGE = 5;

/** Weighted species sets per context. Weights are relative, not percentages. */
export const SPECIES_SETS = {
  // Gran Via, Diagonal, Passeig de Gràcia: the pollarded plane is THE Barcelona avenue tree.
  avenue:  [[SP_PLANE, 6], [SP_TIPUANA, 3], [SP_JACARANDA, 1]],
  // Side streets: smaller crowns, more mixed.
  street:  [[SP_CELTIS, 5], [SP_PLANE, 4], [SP_ORANGE, 1]],
  // Passeig Marítim, Barceloneta, Port Olímpic.
  coast:   [[SP_PALM, 8], [SP_TIPUANA, 2]],
  // Parks and gardens: the only context where the jacaranda is anything but sparse.
  park:    [[SP_TIPUANA, 4], [SP_CELTIS, 3], [SP_JACARANDA, 2], [SP_PALM, 1]],
  // Plaças, courtyards, building perimeters: the bitter orange's home.
  plaza:   [[SP_ORANGE, 5], [SP_CELTIS, 3], [SP_PALM, 2]],
  // Hillsides and the background scatter — Collserola, Montjuïc. Broadleaf and scrubby; NO palms
  // (they are a seafront tree here) and NO ornamentals (nobody plants bitter orange up a hill).
  hill:    [[SP_CELTIS, 5], [SP_TIPUANA, 3], [SP_PLANE, 2]],
};

/** Road classes that read as an avenue rather than a side street. */
export const AVENUE_ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/**
 * Roadside planting stride, in metres, per context.
 *
 * A stride shorter than the canopy is wide reads as a hedge, not a street planting. Barcelona's
 * plane canopies are ~12 m across, so these are set around 1× to 1.2× canopy: avenues keep the
 * boulevard feel with visible gaps between crowns, side streets sit a little tighter.
 */
export const ROADSIDE_STRIDE = {
  avenue: [11, 15],
  street: [9, 13],
  coast:  [10, 14],
};
export const ROADSIDE_STRIDE_DEFAULT = ROADSIDE_STRIDE.street;

/** Deterministic PRNG — must match vegetationWorker's `seeded` exactly. */
export function seededRand(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function pickWeighted(set, r) {
  let total = 0;
  for (let i = 0; i < set.length; i++) total += set[i][1];
  let acc = r * total;
  for (let i = 0; i < set.length; i++) {
    acc -= set[i][1];
    if (acc <= 0) return set[i][0];
  }
  return set[set.length - 1][0];
}

/**
 * Map one tree's context to a species index.
 *
 * Falls back to the legacy modulo whenever the renderer is NOT on the 6-species card path — the
 * blob path has 4 variants that mean something else entirely, and handing it a species index would
 * silently draw the wrong geometry rather than fail.
 */
export function classifySpecies(ctx, i, seed, variantCount, fallbackIndex) {
  if (variantCount !== 6) return fallbackIndex % variantCount;
  const set = SPECIES_SETS[ctx] || SPECIES_SETS.street;
  return pickWeighted(set, seededRand(i, seed + 4242));
}

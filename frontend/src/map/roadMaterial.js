/**
 * roadMaterial.js — v3 P3-07. Asphalt shader v2.
 *
 * Roads cover more of the screen than anything else while driving, and the surface was a flat vertex
 * colour with a per-vertex noise wobble. This adds the three cues that read as "real road" — and all
 * three are ANALYTIC: no textures, no VRAM, no re-bake.
 *
 * ═══ WORLD-METRIC UV, FROM DATA THAT IS ALREADY THERE ════════════════════════════════════════════
 * Road ribbons already carry a per-vertex `halfWidth` attribute (`buildFlatRibbonGeometry`), used
 * today only for the edge fade. With it, uv converts to METRES in the shader:
 *
 *     across = (uv.y - 0.5) * 2.0 * halfWidth   // metres from the centreline, signed
 *     along  = uv.x * 4.0                       // metres along the ribbon
 *
 * so everything below is expressed in real distances rather than in a UV space whose scale changes
 * with every road's width. A 3.5 m lane is 3.5 m on a service street and on a trunk road.
 *
 * ═══ WHY ANALYTIC AND NOT A TEXTURE ══════════════════════════════════════════════════════════════
 * (b) tiling albedo + (c) a detail normal at 8× are still the right answer for GRAIN, and they need
 * authored art — they are deliberately NOT faked here with hash noise, which shimmers under motion
 * and aliases at grazing angles, exactly where road fills the screen. What IS implemented is the part
 * that needs no art:
 *
 *   (d) MACRO WEAR, per-fragment, ~40 m. Replaces the per-vertex `roadNoise` wobble. Per-vertex noise
 *       is interpolated across a whole ribbon segment, so it reads as smooth gradients that swim with
 *       the camera; per-fragment at a real 40 m period reads as patching and repair.
 *   (e) WHEEL RUTS. Two subtly polished bands per lane, placed from `halfWidth`. This is the single
 *       most recognisable real-road cue — the eye reads worn wheel tracks before it reads texture —
 *       and it costs ~10 ALU and zero memory.
 *
 * ⚠ RUTS MUST BE SUBTLE. They are a roughness/tone modulation of a few percent. Pushed further they
 * read as painted stripes, which is worse than no ruts at all, and the effect is strongest exactly
 * where it should be weakest: on wide junction fans where `halfWidth` is large and the lane model
 * does not hold.
 */

/** Metres per lane, for placing ruts. Norma 8.2-IC / BCN_DIMS. */
export const LANE_W_M = 3.5;

/** GLSL injected into the road fragment shader. Kept here so the road material file stays readable. */
export const ROAD_V2_PARS = `
uniform float uRoadWear;
uniform float uRoadRut;
varying float vHalfW;
varying vec2 vRoadUv;

// Cheap value noise — deterministic, no texture. Used ONLY at a ~40 m period, where its low quality
// is invisible; do NOT reuse it for fine grain, which is what a real detail normal is for.
float roadHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float roadNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(roadHash(i), roadHash(i + vec2(1, 0)), f.x),
             mix(roadHash(i + vec2(0, 1)), roadHash(i + vec2(1, 1)), f.x), f.y);
}
`;

/**
 * The fragment body. Applied AFTER BACKTICK_PLACEHOLDER<color_fragment>BACKTICK_PLACEHOLDER so it modulates the vertex-colour asphalt
 * rather than replacing it — road colour lives in the vertex colour, same as buildings (D-31).
 */
/**
 * ⚠ TONE ONLY — this deliberately does NOT touch roughness. Two reasons, both measured 2026-08-26:
 *
 *  1. `roughnessFactor` is declared in three's `<roughnessmap_fragment>`, which comes AFTER
 *     `<color_fragment>` where this is injected. Writing it there is an undeclared identifier and the
 *     shader FAILS TO COMPILE — the road vanished entirely, leaving the separately-materialled lane
 *     paint and crosswalks drawn over bare terrain.
 *  2. `patchRoadAO` is shared with `MeshLambertMaterial` surfaces, which have NO roughness at all, so
 *     even at the correct injection point the term could not be written unconditionally.
 *
 * Ruts are therefore a tone modulation — which is also the honest description: worn asphalt reads
 * polished because it IS lighter, not because a specular response changed.
 *
 * ⚠ Keep the GLSL literal free of BACKTICKS. A backtick used to quote an identifier in a shader
 * comment closes the template string and breaks the build — that has happened twice.
 */
export const ROAD_V2_APPLY = `
{
  // uv -> metres, using the halfWidth the ribbon already carries.
  float across = (vRoadUv.y - 0.5) * 2.0 * vHalfW;   // signed metres from centreline
  float along  = vRoadUv.x * 4.0;                    // metres along the ribbon

  // (d) MACRO WEAR — per-fragment at ~40 m, replacing the per-vertex wobble.
  float wear = roadNoise2(vec2(along, across) * 0.025);
  wear = (wear - 0.5) * uRoadWear;

  // (e) WHEEL RUTS — two polished bands per lane. 'laneLocal' is the distance from the nearest lane
  // centre; ruts sit ~0.9 m either side of it, i.e. a car's track width.
  float lane = floor(across / ${LANE_W_M.toFixed(1)} + 0.5);
  float laneLocal = across - lane * ${LANE_W_M.toFixed(1)};
  float rut = exp(-pow((abs(laneLocal) - 0.9) * 3.2, 2.0));

  // Ruts are POLISHED, not painted: they lighten a touch and smooth out, and they fade out on wide
  // surfaces where the lane model stops being true (junction fans, plazas).
  float laneValid = 1.0 - smoothstep(8.0, 14.0, vHalfW);
  float rutAmt = rut * uRoadRut * laneValid;

  // Tone only — see the note above the export for why there is no roughness term.
  diffuseColor.rgb *= (1.0 + wear + rutAmt * 0.5);
}
`;

/** Uniform defaults. Exported so a tuning UI or a test can reach them. */
export const ROAD_V2_UNIFORMS = {
  /** Macro-wear amplitude. ±3% of albedo — patching, not blotches. */
  uRoadWear: 0.06,
  /** Rut strength. Small on purpose: past ~0.15 they read as painted stripes. */
  uRoadRut: 0.10,
};

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
uniform sampler2D uAsphalt;
uniform float uAsphaltRepeatM;
uniform vec3 uAsphaltGain;
uniform float uRoadRut;
varying float vHalfW;
varying vec2 vRoadUv;
`;

/**
 * v3 P3-07c — ROAD DETAIL NORMAL. The close-range repeat killer.
 *
 * WHY IT IS A SEPARATE INJECTION. ROAD_V2_APPLY goes in after the <color_fragment> include,
 * and three's fragment order puts the <normal_fragment_begin> include AFTER that — so at the
 * tone injection point the identifier 'normal' does not exist yet. Writing it there is the same
 * undeclared-identifier failure that already made the road vanish once (see the roughness note).
 *
 * NO TANGENT ATTRIBUTE IS NEEDED. The tracker assumed normal mapping required tangents the ribbon
 * does not carry. It does not: a tangent frame can be built per fragment from screen-space
 * derivatives of view position against the road's own metric UV, which is what three itself falls
 * back to when USE_TANGENT is absent. The frame is derived from the SAME along/across UV the grain
 * samples, so the micro-normal stays locked to the carriageway rather than to the screen.
 *
 * THE 8x TERM. Two samples: one at the base repeat, one at 8x, whiteout-blended. The base sample
 * gives the aggregate its shape; the 8x sample is what breaks up the tile when the road fills the
 * screen, because at 2 m per repeat a stationary car sees the same stones twice in its own length.
 * The 8x term FADES OUT past ~25 m — a detail frequency that survives to the horizon is just
 * aliasing, and the mip chain cannot help a term whose whole purpose is to be under-sampled.
 */
export const ROAD_V2_NORMAL_PARS = `
uniform sampler2D uAsphaltNormal;
uniform float uRoadDetailAmt;
`;

export const ROAD_V2_NORMAL_APPLY = `
{
  float rdAcross = (vRoadUv.y - 0.5) * 2.0 * vHalfW;
  float rdAlong  = vRoadUv.x * 4.0;
  vec2  rdUv     = vec2(rdAlong, rdAcross) / uAsphaltRepeatM;

  // Detail fades with distance: past ~25 m it is below a pixel and only aliases.
  float rdDist  = length(vViewPosition);
  float rdNear  = 1.0 - smoothstep(8.0, 25.0, rdDist);

  vec3 rdN1 = texture2D(uAsphaltNormal, rdUv).xyz * 2.0 - 1.0;
  vec3 rdN2 = texture2D(uAsphaltNormal, rdUv * 8.0).xyz * 2.0 - 1.0;
  // Whiteout blend — add the XY slopes, multiply the Z. Cheaper than reorienting and correct enough
  // for two samples of the same surface at different frequencies.
  vec3 rdN = normalize(vec3(rdN1.xy + rdN2.xy * rdNear, rdN1.z * rdN2.z));
  rdN.xy *= uRoadDetailAmt;
  rdN = normalize(rdN);

  // Tangent frame from derivatives — no vertex attribute required. Built against the road's metric
  // UV so the detail is locked to the carriageway, not to the camera.
  vec3 rdP  = -vViewPosition;
  vec3 rdQ0 = dFdx(rdP), rdQ1 = dFdy(rdP);
  vec2 rdS0 = dFdx(rdUv), rdS1 = dFdy(rdUv);
  vec3 rdNg = normalize(normal);
  vec3 rdT  = rdQ0 * rdS1.y - rdQ1 * rdS0.y;
  if (dot(rdT, rdT) > 1e-12) {
    rdT = normalize(rdT);
    vec3 rdB = -normalize(cross(rdNg, rdT));
    normal = normalize(mat3(rdT, rdB, rdNg) * rdN);
  }
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

  // ASPHALT GRAIN — one texture fetch, replacing ~40 ALU ops of per-fragment noise.
  //
  // This is the whole reason the world-metric UV exists: the texture tiles at a REAL size, so a 4 m
  // repeat is 4 m on a service street and on a trunk road. And unlike procedural noise it has a MIP
  // CHAIN, so it resolves instead of shimmering at the grazing angles road is mostly viewed at —
  // which is the failure procedural noise cannot fix at any cost.
  //
  // uAsphaltGain = 1 / the plate's PER-CHANNEL linear mean. THE TEXTURE IS A MULTIPLIER, NOT A BASE
  // ALBEDO — see the diffuseColor multiply at the end of this block. The procedural generator
  // it replaced produced a modulation field centred near 1.0, so multiplying was free. An AUTHORED
  // albedo sits at its surface-class L* instead (0.108 linear for asphalt), and multiplying by that
  // darkens the road ~9x on a base that is already dark — and multiplies the plate's slight warm
  // cast in as well, which is why the carriageway came out brown rather than grey.
  //
  // Dividing makes the plate modulate around 1.0: the base palette colour, the vertex colours and
  // the baked AO all survive, and the photograph contributes its RELATIVE grain on top, which is the
  // only part of it that was ever wanted here.
  //
  // PER CHANNEL, not by luminance. A scalar cannot neutralise an unbalanced plate: asphalt_worn
  // measures R 0.120 / G 0.106 / B 0.087, so one luma divisor leaves (1.11, 0.985, 0.81) — red 37%
  // above blue — and multiplying that into the road turned every carriageway and pavement beige.
  vec3 grain = texture2D(uAsphalt, vec2(along, across) / uAsphaltRepeatM).rgb * uAsphaltGain;


  // (e) WHEEL RUTS — two polished bands per lane. 'laneLocal' is the distance from the nearest lane
  // centre; ruts sit ~0.9 m either side of it, i.e. a car's track width.
  float lane = floor(across / ${LANE_W_M.toFixed(1)} + 0.5);
  float laneLocal = across - lane * ${LANE_W_M.toFixed(1)};
  float rutD = (abs(laneLocal) - 0.9) * 3.2;
  float rut = exp(-rutD * rutD);                   // x*x, not pow(x,2.0) — pow is a transcendental

  // Ruts are POLISHED, not painted: they lighten a touch and smooth out, and they fade out on wide
  // surfaces where the lane model stops being true (junction fans, plazas).
  float laneValid = 1.0 - smoothstep(8.0, 14.0, vHalfW);
  float rutAmt = rut * uRoadRut * laneValid;

  // Tone only — see the note above the export for why there is no roughness term.
  diffuseColor.rgb *= grain * (1.0 + rutAmt * 0.5);
}
`;

/** Uniform defaults. Exported so a tuning UI or a test can reach them. */
export const ROAD_V2_UNIFORMS = {
  /** Metres per asphalt texture repeat. Real-world size, via the world-metric UV. */
  uAsphaltRepeatM: 4.0,
  uAsphaltGain: [1, 1, 1],  // overridden from the plate's per-channel means; (1,1,1) = procedural fallback
  /** Rut strength. Small on purpose: past ~0.15 they read as painted stripes. */
  uRoadRut: 0.10,
  /** Detail-normal strength. Asphalt micro-relief is millimetres — this is a texture, not terrain. */
  uRoadDetailAmt: 0.55,
};

/**
 * Bake the asphalt grain ONCE at boot, instead of evaluating noise per fragment forever.
 *
 * ⚠ THIS IS THE POINT OF THE WHOLE CHANGE. The procedural version cost ~40 ALU ops on every road
 * fragment — on the surface with the largest screen coverage in the game, on a MeshStandardMaterial
 * that is already the expensive path — and measurably slowed the frame (`?roadv2=0` was faster).
 * Baking converts that into ONE texture fetch, which runs on the TMU in parallel with ALU.
 *
 * The second win matters as much: a texture has a MIP CHAIN. Procedural noise has none, so it
 * aliases and crawls at grazing angles — exactly how road is seen when driving. No amount of ALU
 * fixes that; only prefiltering does.
 *
 * ⚠ NEAR-NEUTRAL, centred on 1.0 — see D-31. Road colour lives in the VERTEX COLOUR (the dark
 * blue-grey asphalt tone plus its broad patches). This texture MODULATES that; a tinted or dark
 * texture would multiply against a tone that is already there and drive the whole city's roads dark.
 *
 * Procedural today, an authored KTX2 later (P3-07b) — the sampling path is identical, so that is a
 * file swap and not a rewrite.
 */
export function createAsphaltTexture(THREE, px = 512) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(px, px)
    : Object.assign(document.createElement('canvas'), { width: px, height: px });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(px, px);
  const d = img.data;

  // Deterministic LCG — NOT Math.random. The texture must be identical on every load, or the road
  // grain changes between sessions and between the main thread and any regeneration.
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  // Aggregate: fine speckle at two scales, centred on 1.0 so the mean leaves the vertex tone alone.
  const coarse = new Float32Array(px * px);
  const CO = 64;                                     // coarse cell size in texels
  const cw = Math.ceil(px / CO) + 1;
  const cells = new Float32Array(cw * cw);
  for (let i = 0; i < cells.length; i++) cells[i] = rnd();
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      // Bilinear over the coarse cells — WRAPPING, so the texture tiles with no visible seam.
      const fx = x / CO, fy = y / CO;
      const x0 = Math.floor(fx) % (cw - 1), y0 = Math.floor(fy) % (cw - 1);
      const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const c00 = cells[y0 * cw + x0], c10 = cells[y0 * cw + x0 + 1];
      const c01 = cells[(y0 + 1) * cw + x0], c11 = cells[(y0 + 1) * cw + x0 + 1];
      coarse[y * px + x] = (c00 * (1 - sx) + c10 * sx) * (1 - sy) + (c01 * (1 - sx) + c11 * sx) * sy;
    }
  }
  for (let i = 0; i < px * px; i++) {
    const speck = rnd();                             // per-texel chip
    // ±5% around 1.0. Bigger reads as gravel rather than asphalt, and any bias shifts every road.
    const v = 1.0 + (speck - 0.5) * 0.07 + (coarse[i] - 0.5) * 0.05;
    const c = Math.max(0, Math.min(255, Math.round(v * 255)));
    d[i * 4] = c; d[i * 4 + 1] = c; d[i * 4 + 2] = c; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Mips ARE generated here — unlike the array textures, a plain 2D texture's chain is built by
  // three, and the whole reason for baking is to get prefiltering.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;               // a multiplier, not colour — no sRGB decode
  tex.needsUpdate = true;
  return tex;
}

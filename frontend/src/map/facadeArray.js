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

// ═══ LAYER INDEX ENCODING ════════════════════════════════════════════════════════════════════════
//
// `aLayer` is ONE float per vertex and has to address TWO arrays. Rather than spend a second
// attribute (one more float per vertex across every wall in the city), the band is encoded as an
// offset: body/crown vertices carry `idx`, ground vertices carry `idx + GROUND_LAYER_BASE`.
//
// 16, not 8, so the body array can grow to 16 variants before the encoding has to change. If it ever
// needs to grow past that, this constant and the shader branch move together — they are the only two
// places that know about it.
export const GROUND_LAYER_BASE = 16;

/** Encode a ground-band layer index for `aLayer`. */
export function encodeGroundLayer(idx) { return idx + GROUND_LAYER_BASE; }

/** Decode: `{ array: 'ground'|'body', index }`. Mirrors the shader branch exactly. */
export function decodeLayer(encoded) {
  return encoded >= GROUND_LAYER_BASE
    ? { array: 'ground', index: encoded - GROUND_LAYER_BASE }
    : { array: 'body', index: encoded };
}

// ═══ PLACEHOLDER LAYERS ══════════════════════════════════════════════════════════════════════════
//
// ⚠ THESE ARE SCAFFOLDING. P3-05 authors the real 8 layers as KTX2 and `createFacadeArrays` should
// then load those instead. They exist so the SHADER PATH can be built and proven BEFORE six days of
// art is committed to a UV spec nobody has rendered — if array sampling has a problem, it is far
// cheaper to find it now than after the textures are painted.
//
// They are deliberately plain: flat plaster with window rows, no weathering, no normal detail. They
// are NOT meant to look better than today's canvas facade — only to be structurally correct, so that
// `windowOnlyTile` can be switched on and mid-air shopfronts can go to zero.
//
// Placeholder resolution is half the spec (512² body / 256² ground) because the pixels carry no
// detail worth the VRAM; the real art ships at 1024²/512².
const PLACEHOLDER_BODY_PX = 512;
const PLACEHOLDER_GROUND_PX = 256;

/** Per-variant look for the placeholders. Real art replaces this wholesale. */
const PLACEHOLDER_TINTS = [
  { wall: '#d8cfc0', win: '#3d4652' },   // residential a — warm plaster
  { wall: '#cfc6b6', win: '#39424e' },   // residential b
  { wall: '#e0d6c6', win: '#424b57' },   // residential c
  { wall: '#c8bfae', win: '#353d48' },   // residential d
  { wall: '#d2c9b9', win: '#3f4854' },   // residential e
  { wall: '#b9c3cc', win: '#2f3945' },   // commercial
  { wall: '#c4c9cf', win: '#333c47' },   // office
  { wall: '#a88f7f', win: '#2c3036' },   // industrial brick
];

/** Paint one BODY layer: plaster with window rows, tiling in BOTH axes. */
function paintBodyLayer(ctx, px, tint) {
  const m = px / BODY_LAYER_H_M;                 // pixels per metre (square layer)
  ctx.fillStyle = tint.wall;
  ctx.fillRect(0, 0, px, px);
  // Two storeys per layer, at 4.0 m each. Windows are inset so the tile's top edge meets its bottom
  // edge on plaster — a window row split across that seam is the loudest authoring error there is.
  const winW = 1.1 * m, winH = 2.0 * m, gapH = 1.4 * m;
  const cols = Math.max(1, Math.round(LAYER_W_M / (1.1 + 1.4)));
  const colStep = px / cols;
  for (let storey = 0; storey < 2; storey++) {
    const rowTop = storey * 4.0 * m + 1.0 * m;   // 1.0 m of plaster below each row
    ctx.fillStyle = tint.win;
    for (let c = 0; c < cols; c++) {
      const x = c * colStep + (colStep - winW) / 2;
      ctx.fillRect(Math.round(x), Math.round(rowTop), Math.round(winW), Math.round(winH));
    }
  }
}

/** Paint one GROUND layer: a shopfront module. Tiles in u only — the bottom edge is the pavement. */
function paintGroundLayer(ctx, w, h, tint) {
  ctx.fillStyle = '#A89A82';                     // warm-stone shopfront base, as the old painter used
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6E6456';                     // fascia sign band across the top of the module
  ctx.fillRect(0, 0, w, Math.round(h * 0.18));
  ctx.fillStyle = tint.win;                      // glazing
  const pad = Math.round(w * 0.06);
  ctx.fillRect(pad, Math.round(h * 0.28), w - pad * 2, Math.round(h * 0.58));
}

/**
 * Build the two placeholder arrays. Main thread only — needs a canvas.
 * @returns {{ body: THREE.DataArrayTexture, ground: THREE.DataArrayTexture }}
 */
export function createFacadeArrays(THREE) {
  const mkArray = (px, pxH, paint) => {
    const n = BODY_LAYERS.length;
    const data = new Uint8Array(px * pxH * 4 * n);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(px, pxH)
      : Object.assign(document.createElement('canvas'), { width: px, height: pxH });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < n; i++) {
      ctx.clearRect(0, 0, px, pxH);
      paint(ctx, px, pxH, PLACEHOLDER_TINTS[i] || PLACEHOLDER_TINTS[0]);
      data.set(ctx.getImageData(0, 0, px, pxH).data, i * px * pxH * 4);
    }
    const tex = new THREE.DataArrayTexture(data, px, pxH, n);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    // ⚠ RepeatWrapping is the entire point of the array: each LAYER wraps independently, which is
    // what an atlas cannot do and why `fract()` is not needed.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  return {
    body: mkArray(PLACEHOLDER_BODY_PX, PLACEHOLDER_BODY_PX, (c, w, _h, t) => paintBodyLayer(c, w, t)),
    ground: mkArray(PLACEHOLDER_GROUND_PX, Math.round(PLACEHOLDER_GROUND_PX * (GROUND_LAYER_H_M / LAYER_W_M)),
                    (c, w, h, t) => paintGroundLayer(c, w, h, t)),
  };
}

/**
 * Swap a built-in material's `map` sample for an array-texture sample keyed on `aLayer`.
 *
 * ⚠ THIS WORKS WITHOUT A GLSL3 OPT-IN, but only because three r183 ALWAYS emits `#version 300 es`
 * (`WebGLProgram`, versionString) with `#define texture2D texture` compatibility. `sampler2DArray` is
 * therefore in scope inside `onBeforeCompile` on a stock MeshLambertMaterial. On an older three that
 * emitted GLSL1 this would fail to compile — if the dependency is ever downgraded, this is the first
 * thing that breaks, and the symptom is a shader error, not a wrong picture.
 */
export function patchFacadeArrayMaterial(material, arrays) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFacadeBody = { value: arrays.body };
    shader.uniforms.uFacadeGround = { value: arrays.ground };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLayer;\nvarying float vLayer;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayer = aLayer;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n' +
        'precision highp sampler2DArray;\n' +
        'uniform sampler2DArray uFacadeBody;\n' +
        'uniform sampler2DArray uFacadeGround;\n' +
        'varying float vLayer;')
      .replace('#include <map_fragment>',
        // Branch on the encoded band. Both sides sample, so there is no divergent-texture-fetch
        // penalty worth avoiding, and the mip derivative stays valid on each layer.
        'float lyr = vLayer;\n' +
        'vec4 facadeTexel = lyr >= ' + GROUND_LAYER_BASE + '.0\n' +
        '  ? texture(uFacadeGround, vec3(vMapUv, lyr - ' + GROUND_LAYER_BASE + '.0))\n' +
        '  : texture(uFacadeBody, vec3(vMapUv, lyr));\n' +
        'diffuseColor *= facadeTexel;');
  };
  material.customProgramCacheKey = () => 'facadeArray-v1';
  material.needsUpdate = true;
  return material;
}

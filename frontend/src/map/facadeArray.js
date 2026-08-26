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

import { FLOOR_HEIGHT, WALL_REPEAT_HORIZONTAL_M, STOREY_H } from '../buildingConstants.js';

/** Metres one layer spans horizontally. Both arrays share it so u repeats stay consistent. */
export const LAYER_W_M = 2 * STOREY_H;   // 7.0 m
/**
 * Metres a BODY layer spans vertically.
 *
 * 2 x STOREY_H, and SQUARE with LAYER_W_M so a square plate maps to a square patch of wall.
 *
 * The history matters because three earlier values were all chasing the wrong thing. 8.0 came from
 * the plan's "2 storeys of 4.0 m" against a bake storey of 3.5. 7.0 derived it correctly and still
 * looked wrong. 12 x 12 was judged on screen and looked best of the three — because it was
 * COMPENSATING for a unit error, not fixing it: v arrives per STOREY_H on this path and was being
 * divided by FLOOR_HEIGHT, stretching every layer 2.9x horizontally. Rescaling an axis cannot fix a
 * wrong unit, which is why each value felt like an improvement and none of them worked.
 */
export const BODY_LAYER_H_M = 2 * STOREY_H;   // 7.0 m — square, so a square plate is undistorted
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
/**
 * ⚠ THE FACADE UV IS NOT THE WALL UV. The wall attribute is in the LEGACY convention — u repeats
 * every WALL_REPEAT_HORIZONTAL_M (12 m) and v every FLOOR_HEIGHT (10 m), both chosen for the old
 * painted-canvas facades. The authored layers are 8 m x 8 m. Sampling the array with the raw
 * attribute therefore stretched every layer 12/8 across and 10/8 up — DIFFERENT factors, so windows
 * came out landscape where the plate drew them portrait.
 *
 * The vertex patch converts: uv * (WALL_REPEAT_HORIZONTAL_M / LAYER_W_M, FLOOR_HEIGHT /
 * BODY_LAYER_H_M) turns "units of 12 m and 10 m" into "units of 8 m and 8 m". Done in the shader
 * rather than by changing FLOOR_HEIGHT, because the vertex-colour path still depends on those
 * constants and `?facadearray=0` has to keep working.
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

/**
 * Per-variant placeholder look.
 *
 * ⚠ THESE MUST STAY NEAR-NEUTRAL. Building colour does NOT come from the texture — it is baked into
 * the VERTEX COLOUR attribute as a palette pick, and every facade material is deliberately WHITE so
 * the tint shows through (`buildingWorker.js`, "DRAW-CALL COLLAPSE"). The fragment chain is
 *
 *     diffuseColor = white(material) × vColor(palette) × facadeTexel
 *
 * so a TINTED layer multiplies against a tint that is already there. Measured 2026-08-25: the first
 * placeholders carried plaster colours (#d8cfc0 … #a88f7f) and the product went to near-black on
 * buildings whose palette entry was already dark — "some buildings entirely black, some still
 * coloured", varying per building because BOTH factors vary. Near-white keeps the layer a
 * *modulation* (window rows, panel breaks) and leaves colour where it already lives.
 *
 * ⚠ OPEN SPEC QUESTION FOR P3-05: the task says its albedo has "weathering baked in", i.e. the ART
 * owns colour. That collides with the vertex-colour palette in exactly this way. P3-05 must pick ONE
 * owner — author neutral layers and keep the palette, or author coloured layers and neutralise
 * `getFacadeTint`. It cannot have both.
 */
const PLACEHOLDER_TINTS = [
  { wall: '#f2f0ec', win: '#2b3038' },   // residential a — near-white, subtle warm
  { wall: '#efedea', win: '#282d34' },   // residential b
  { wall: '#f4f2ee', win: '#2e333b' },   // residential c
  { wall: '#eceae6', win: '#252a31' },   // residential d
  { wall: '#f0eeea', win: '#2b3037' },   // residential e
  { wall: '#eef0f2', win: '#232830' },   // commercial — a hair cooler
  { wall: '#f0f1f3', win: '#262b33' },   // office
  { wall: '#edeae6', win: '#22262c' },   // industrial
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
    // ⚠ NO MIPMAPS ON THE PLACEHOLDER ARRAY. `texStorage3D` allocates the full mip chain up front,
    // and if the levels are never generated the texture is INCOMPLETE — and an incomplete texture
    // samples BLACK, not blurry. That is the leading suspect for "some buildings entirely black"
    // (2026-08-25). LinearFilter needs no mip chain, so the texture is always complete.
    //
    // The cost is aliasing on distant facades, which is real but visible only at range and is the
    // right trade for scaffolding. **P3-05's KTX2 ships its mip chain in the file**, so the real art
    // path can and should set LinearMipmapLinearFilter — re-check this line then.
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  const arrays = {
    body: mkArray(PLACEHOLDER_BODY_PX, PLACEHOLDER_BODY_PX, (c, w, _h, t) => paintBodyLayer(c, w, t)),
    ground: mkArray(PLACEHOLDER_GROUND_PX, Math.round(PLACEHOLDER_GROUND_PX * (GROUND_LAYER_H_M / LAYER_W_M)),
                    (c, w, h, t) => paintGroundLayer(c, w, h, t)),
  };

  // ── v3 P3-05: swap the BODY placeholder for the authored art, in place ─────────────────────────
  //
  // The array arrives as ONE layered KTX2, not eight files. That is not tidiness: eight files loaded
  // into a DataArrayTexture would decompress to RGBA8 on upload and cost 85 MiB where the layered,
  // still-compressed array costs 21. The file has to arrive already layered AND already compressed.
  //
  // Swapped ASYNCHRONOUSLY into the existing object rather than awaited, so nothing downstream has to
  // become async: materials already hold `arrays.body`, and assigning a new texture to that property
  // is picked up on the next frame. The placeholder is what renders until it lands — which is also
  // the fallback if the file is missing.
  //
  // ⚠ The mip-chain warning above does NOT apply here. It says an incomplete mip chain samples BLACK,
  // which is why the placeholder disables mipmaps — but a KTX2 SHIPS ITS MIPS IN THE FILE, so the
  // chain is complete on arrival and LinearMipmapLinearFilter is not only safe but required (without
  // it every distant facade aliases). That line explicitly asked to be re-checked here.
  loadFacadeBodyArray(THREE).then((tex) => {
    if (!tex) return;
    arrays.body = tex;
    arrays.bodyIsAuthored = true;
    const im = tex.image || {};
    console.warn('[facadeArray] authored body array loaded: %sx%sx%s layers',
      im.width, im.height, im.depth);
  }).catch((e) => {
    // REPORTED, not swallowed. The first version caught this silently, so a failed load looked
    // exactly like a working placeholder — which is precisely the state it shipped in.
    console.warn('[facadeArray] authored body array FAILED to load (%s) — placeholder stands', e?.message || e);
  });

  return arrays;
}

/** Load the authored 8-layer body array. Resolves null if the art is absent, keeping the placeholder. */
async function loadFacadeBodyArray(THREE) {
  const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
  // WAIT for the renderer rather than giving up on it. createFacadeArrays runs lazily on the first
  // tile build, which can land BEFORE boot hands the renderer over — and the first version simply
  // returned null there, permanently. The symptom was the placeholder rendering forever with no
  // explanation: flat tint, black window rectangles, and a swallowed error.
  const renderer = await waitForRenderer();
  if (!renderer) {
    console.warn('[facadeArray] no renderer after 20s — authored facades NOT loaded, placeholder stands');
    return null;
  }
  const loader = new KTX2Loader()
    .setTranscoderPath('/basis/')
    .detectSupport(renderer);
  const tex = await loader.loadAsync('/art/v1/facades/facade_body_albedo.ktx2');
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;                 // still the point: each layer wraps independently
  tex.minFilter = THREE.LinearMipmapLinearFilter;   // the KTX2 carries its own complete mip chain
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  loader.dispose();
  return tex;
}

// The KTX2 transcoder needs the renderer's capabilities to choose a target format, and this module is
// constructed before one is passed anywhere. main.js hands it over at boot.
let _sharedRenderer = null;
const _rendererWaiters = [];
export function setFacadeArrayRenderer(r) {
  _sharedRenderer = r;
  while (_rendererWaiters.length) _rendererWaiters.pop()(r);
}
function waitForRenderer(timeoutMs = 20000) {
  if (_sharedRenderer) return Promise.resolve(_sharedRenderer);
  return new Promise((resolve) => {
    _rendererWaiters.push(resolve);
    setTimeout(() => resolve(_sharedRenderer), timeoutMs);
  });
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
// A plain {x, y}, not a THREE.Vector2: this module never imports three — it receives it as a
// parameter (createFacadeArrays(THREE)) — and three uploads a vec2 uniform from any object with
// x and y. Constructing a Vector2 here would throw at module load.
// ⚠ v ARRIVES IN UNITS OF STOREY_H, NOT FLOOR_HEIGHT — this was a 2.9x stretch.
//
// The wall UV has two conventions and the array path uses the SECOND one:
//   u  always  wallLen / WALL_REPEAT_HORIZONTAL_M           (12 m per repeat)
//   v  legacy  gFrac + bodyRepeats * bodyVPerTile           (FLOOR_HEIGHT, 10 m)
//   v  ARRAY   bodyH / STOREY_H                             (3.5 m per repeat)   <- windowOnlyTile
//
// `windowOnlyTile` is set from the array flag (buildingWorker), so whenever this shader runs, v is
// already per-STOREY. Dividing by FLOOR_HEIGHT made the layer span 4.2 m vertically against 12 m
// horizontally — windows came out ~2.9x too wide, which is precisely the stretch that survived two
// earlier "fixes". Chasing it by changing BODY_LAYER_H_M could never work: that only rescales an
// axis whose UNIT was wrong.
const _facadeScale = {
  x: WALL_REPEAT_HORIZONTAL_M / LAYER_W_M,
  y: STOREY_H / BODY_LAYER_H_M,
};

/**
 * How much of the per-building vertex tint survives on the authored-facade path, and what it is
 * normalised against.
 *
 * `amt` 0 = the authored albedo alone, every building of a variant identical. 1 = full per-building
 * brightness variation. The default keeps a real street's variety without letting the old flat
 * colours fight eight carefully normalized palettes.
 *
 * `mean` is the luminance the building tints cluster around; dividing by it makes the tint modulate
 * around 1.0 rather than darkening everything, which is the same correction uAsphaltGain needed.
 */
const _facadeTint = { amt: 0.45, mean: 0.62 };

// ── Generated night-window grid ───────────────────────────────────────────────────────────────
// Cells per LAYER. The plates draw 2 windows across and 2 storeys tall per layer, so matching that
// puts a lit box where a painted window is — the grid inherits the facade's alignment for free.
const WINDOW_COLS = 2.0;
const WINDOW_ROWS = 2.0;
/** Box size as a fraction of its cell, and how high it sits — a real opening is not cell-centred. */
const WINDOW_W = 0.34;
const WINDOW_H = 0.42;
const WINDOW_CENTRE_Y = 0.54;
/** Fraction lit. Not 1.0: a fully lit block reads as an office at 3am, not a street of homes. */
const LIT_WINDOW_FRACTION = 0.42;
/** Dimmest lit window as a fraction of the brightest — variety, so the grid is not a checkerboard. */
const WINDOW_MIN_BRIGHT = 0.30;
/**
 * Window glow colour and strength.
 *
 * N3 Window Warm #FFDFA8 from the art bible's CLOSED set of six night emissives, scaled down hard.
 * The value is the RADIANCE, not a tint: bloom multiplies it, so a value that looks merely bright
 * in isolation blows to white once the post chain has it. That is what the blown-out white
 * rectangles were.
 */
// 1.35, not 0.55. It is RADIANCE and bloom keys off values ABOVE 1 — at 0.55 nothing ever reached
// the threshold, so the windows were lit but inert and the city read grey. The tone above carries
// the colour; this carries the energy, and the two were being confused.
const _windowGlow = { x: 1.35, y: 1.35, z: 1.35 };
const _windowGlowUniforms = [];

// Day/night for the window grid. A float, not a bool, so it crosses over with the env transition
// instead of popping — envToggle passes its lerp straight through.
let _facadeNightT = 0;
const _facadeNightUniforms = [];
export function setFacadeArrayNightMode(t) {
  _facadeNightT = Math.max(0, Math.min(1, t));
  for (const u of _facadeNightUniforms) u.value = _facadeNightT;
}
const _facadeTintUniforms = [];

if (typeof window !== 'undefined') {
  /**
   * `_ddFacadeTint(amount)` — how much per-building colour variation survives, as BRIGHTNESS.
   *   0    authored albedo only; every building of a variant looks identical
   *   0.45 default
   *   1    full variation
   * The tint's HUE is always discarded: it is the flat colour the vertex path assigned, and
   * multiplying it into a normalized photographic facade is what made all eight variants read brown.
   */
  /**
   * `_ddWindowGlow(strength, r, g, b)` — night window radiance.
   *
   * It is RADIANCE, not a tint: bloom multiplies it, so a value that looks merely bright in
   * isolation blows to pure white after the post chain. Default is N3 Window Warm (#FFDFA8) from the
   * art bible's closed set of six night emissives, at 0.55.
   */
  window._ddWindowGlow = (strength = 0.55, r = 1.0, g = 0.874, b = 0.658) => {
    _windowGlow.x = r * strength; _windowGlow.y = g * strength; _windowGlow.z = b * strength;
    for (const u of _windowGlowUniforms) u.value = _windowGlow;
    return `window glow ${strength} x (${r}, ${g}, ${b})  — bloom multiplies this, so go low`;
  };

  window._ddFacadeTint = (amt, mean) => {
    _facadeTint.amt = amt ?? _facadeTint.amt;
    _facadeTint.mean = mean ?? _facadeTint.mean;
    for (const u of _facadeTintUniforms) {
      u.uFacadeTintAmt.value = _facadeTint.amt;
      u.uFacadeTintMean.value = _facadeTint.mean;
    }
    return `facade tint ${_facadeTint.amt} (brightness only, hue discarded) around mean ${_facadeTint.mean}`;
  };


}

let _facadeDiagLogged = false;
const _facadeTypesSeen = new Set();
export function patchFacadeArrayMaterial(material, arrays) {
  material.onBeforeCompile = (shader) => {
    // One-shot diagnostic. Two wrong guesses have already been made on this task (vMapUv, then the
    // mip chain), so the next drive should REPORT rather than need another guess: which material
    // types are actually being patched, and what the arrays look like.
    if (!_facadeTypesSeen.has(material.type)) {
      _facadeTypesSeen.add(material.type);
      console.warn('[facadeArray] patching material type: %s (aLayer path)', material.type);
    }
    if (!_facadeDiagLogged) {
      _facadeDiagLogged = true;
      const d = (t) => t && t.image ? `${t.image.width}x${t.image.height}x${t.image.depth} mips=${t.generateMipmaps} min=${t.minFilter}` : 'MISSING';
      console.warn('[facadeArray] patched %s · body %s · ground %s',
        material.type, d(arrays.body), d(arrays.ground));
    }
    // Legacy wall UV -> layer space. See the bandUV note: u arrives in units of
    // WALL_REPEAT_HORIZONTAL_M (12 m) and v in units of FLOOR_HEIGHT (10 m); the layers are
    // LAYER_W_M x BODY_LAYER_H_M.
    shader.uniforms.uFacadeScale = { value: _facadeScale };
    shader.uniforms.uFacadeWindowGlow = { value: _windowGlow };
    shader.uniforms.uFacadeNight = { value: _facadeNightT };
    _facadeNightUniforms.push(shader.uniforms.uFacadeNight);
    _windowGlowUniforms.push(shader.uniforms.uFacadeWindowGlow);
    shader.uniforms.uFacadeTintAmt = { value: _facadeTint.amt };
    // Mean luminance the per-building tints sit around. Dividing by it makes the tint modulate
    // AROUND 1.0 instead of darkening everything — the same correction uAsphaltGain needed.
    shader.uniforms.uFacadeTintMean = { value: _facadeTint.mean };
    _facadeTintUniforms.push(shader.uniforms);
    shader.uniforms.uFacadeBody = { value: arrays.body };
    shader.uniforms.uFacadeGround = { value: arrays.ground };
    // ⚠ CARRY OUR OWN UV VARYING — do NOT use three's `vMapUv`.
    //
    // three declares `varying vec2 vMapUv` inside `#ifdef USE_MAP` (`uv_pars_fragment`). Any facade
    // material without a bound `map` — the glass path builds a MeshPhongMaterial — therefore has no
    // such varying, and referencing it is a COMPILE ERROR, not a fallback. Measured 2026-08-25:
    //   ERROR: 0:887: 'vMapUv' : undeclared identifier   [Material Type: MeshPhongMaterial]
    // which killed every wall in the city, left only the unpatched roof/detail materials showing,
    // and lagged the frame while three retried the broken program per material key.
    //
    // `uv` is a stock attribute present on all of these geometries, so deriving the varying here
    // makes the patch independent of which maps a given material happens to bind.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aLayer;\nvarying float vLayer;\nvarying vec2 vFacadeUv;\nuniform vec2 uFacadeScale;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvLayer = aLayer;\nvFacadeUv = uv * uFacadeScale;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n' +
        'precision highp sampler2DArray;\n' +
        'uniform sampler2DArray uFacadeBody;\n' +
        'uniform sampler2DArray uFacadeGround;\n' +
        'uniform float uFacadeTintAmt;\nuniform float uFacadeTintMean;\n' +
        'uniform vec3 uFacadeWindowGlow;\nuniform float uFacadeNight;\n' +
        'varying float vLayer;\nvarying vec2 vFacadeUv;')
      .replace('#include <map_fragment>',
        // Branch on the encoded band. Both sides sample, so there is no divergent-texture-fetch
        // penalty worth avoiding, and the mip derivative stays valid on each layer.
        'float lyr = vLayer;\n' +
        'vec4 facadeTexel = lyr >= ' + GROUND_LAYER_BASE + '.0\n' +
        '  ? texture(uFacadeGround, vec3(vFacadeUv, lyr - ' + GROUND_LAYER_BASE + '.0))\n' +
        '  : texture(uFacadeBody, vec3(vFacadeUv, lyr));')
      // ── THE PER-BUILDING TINT MUST NOT MULTIPLY AN AUTHORED ALBEDO ──────────────────────────
      //
      // This used to be `diffuseColor *= facadeTexel` at <map_fragment>, and three applies the
      // vertex colour immediately afterwards at <color_fragment>. So every authored facade was
      // multiplied by the flat per-building colour the vertex-colour path assigns — which is why
      // eight normalized variants (cream, ochre, rose, grey, brick...) all rendered the same brown.
      // Exactly the mistake the asphalt plate made: an albedo used where a modulation was expected.
      //
      // The tint is still WANTED, though — a real street varies building to building. So it is kept
      // as BRIGHTNESS ONLY: its luminance modulates the authored albedo, its hue is discarded. Same
      // resolution as the bush cards.
      // ── NIGHT WINDOWS ARE A GENERATED GRID, NOT THE MASK ───────────────────────────────────
      //
      // The mask was tried here and it was the wrong tool. It is derived from colour — distance
      // from the plaster's modal hue — and measured good on six of eight plates. Six of eight is
      // fine for deciding which pixels to GRADE; it is useless for deciding which pixels EMIT,
      // because every dirty patch becomes a glowing blob. On screen: whole balconies, mouldings and
      // wall sections lit blinding white.
      //
      // A generated grid has none of that. It is drawn in the SAME UV space as the facade, so it
      // aligns with the painted windows by construction — which was the original reason for
      // abandoning the old emissiveMap, and it holds here without depending on mask quality.
      // Per-cell hashes give lit/unlit, colour temperature and brightness, so a street reads as
      // occupied rather than switched on.
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        '{\n' +
        '  float wIsBody = step(lyr, ' + (GROUND_LAYER_BASE - 0.5).toFixed(1) + ');\n' +
        '  vec2 wuv = vFacadeUv * vec2(' + WINDOW_COLS.toFixed(1) + ', ' + WINDOW_ROWS.toFixed(1) + ');\n' +
        '  vec2 wcell = floor(wuv);\n' +
        '  vec2 wf = fract(wuv);\n' +
        '  vec3 wh = vec3(wcell, vLayer);\n' +
        '  float r1 = fract(sin(dot(wh, vec3(12.9898, 78.233, 37.719))) * 43758.5453);\n' +
        '  float r2 = fract(sin(dot(wh, vec3(39.346, 11.135, 83.155))) * 24634.6345);\n' +
        '  float r3 = fract(sin(dot(wh, vec3(73.156, 52.235, 09.151))) * 13758.1234);\n' +
        // A window-sized rectangle inside the cell, sitting slightly high like a real opening.
        '  vec2 wd = abs(wf - vec2(0.5, ' + WINDOW_CENTRE_Y.toFixed(2) + '));\n' +
        '  float box = step(wd.x, ' + (WINDOW_W / 2).toFixed(3) + ') * step(wd.y, ' + (WINDOW_H / 2).toFixed(3) + ');\n' +
        '  float lit = step(' + (1.0 - LIT_WINDOW_FRACTION).toFixed(2) + ', r1);\n' +
        // Warm amber to warm white — inside the art bible's N3 Window Warm family, never cool.
        // Warmer at BOTH ends than the first pass. A city lit by neutral windows reads grey, and
        // real interior light is tungsten/warm-LED — the art bible's N3 Window Warm family, never
        // toward white. The cool end here is still warmer than the old warm end.
        '  vec3 tone = mix(vec3(1.0, 0.66, 0.30), vec3(1.0, 0.84, 0.56), r2);\n' +
        '  float bright = ' + WINDOW_MIN_BRIGHT.toFixed(2) + ' + ' + (1.0 - WINDOW_MIN_BRIGHT).toFixed(2) + ' * r3;\n' +
        // ⚠ GATED ON NIGHT EXPLICITLY. Writing totalEmissiveRadiance here BYPASSES
        // `emissiveIntensity`, which is what the day path sets to 0 — so without this the lit boxes
        // glow at noon, and they did: pale rectangles all over the daytime facade.
        '  totalEmissiveRadiance = uFacadeWindowGlow * tone * (box * lit * bright * wIsBody * uFacadeNight);\n' +
        '}')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n' +
        'float facTint = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n' +
        'facTint = mix(1.0, facTint / max(uFacadeTintMean, 1e-4), uFacadeTintAmt);\n' +
        // ⚠ ALPHA IS NOT PROPAGATED. It used to carry the derived window mask and was multiplied
        // into diffuseColor.a, which punches at the windows in daylight on any material with
        // transparency or an alphaTest. The mask has no consumer now that night windows are a
        // generated grid, so the albedo ships opaque and alpha is left alone.
        'diffuseColor = vec4(facadeTexel.rgb * facTint, diffuseColor.a);');
  };
  material.customProgramCacheKey = () => 'facadeArray-v1';
  material.needsUpdate = true;
  return material;
}

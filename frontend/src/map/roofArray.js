/**
 * roofArray.js — v3 P3-06. Roof surfaces for the whole city from one material.
 *
 * ═══ WHY THIS IS CHEAP ═══════════════════════════════════════════════════════════════════════════
 * `getRoofMaterialKey()` returns the literal `'roof_FFFFFF'` — every roof in Barcelona already shares
 * ONE material. Roofs were untextured only because `ensureUvs` zero-filled their UVs, so every vertex
 * sampled (0,0). P3-06 gives them world-planar UVs and binds a small array here, and the entire city
 * is dressed. From altitude roofs are a large share of the frame.
 *
 * ═══ WHY AN ARRAY AND NOT AN ATLAS ═══════════════════════════════════════════════════════════════
 * The task specifies a 3-cell ATLAS. An atlas cannot work with world-planar UVs: those run to 25, 50,
 * 300 as you cross the city, so addressing a sub-rect needs `fract()`, whose discontinuity breaks the
 * mip derivative and seams every cell boundary — the same trap P3-04 documents. A 3-LAYER array wraps
 * per layer natively and costs the same memory. The per-vertex `aLayer` plumbing already exists from
 * P3-04, so this reuses it rather than adding a second mechanism.
 *
 * ⚠ PLACEHOLDER LAYERS, and they must stay NEAR-NEUTRAL — see D-31. Roof colour is baked into the
 * VERTEX COLOUR (the peach/terracotta palette) against a WHITE material, exactly like facades. A
 * tinted layer multiplies a tint that is already there and drives dark roofs to black.
 */

/** Roof surface kinds. Index = layer index. */
export const ROOF_LAYERS = ['pantile', 'terrat_gravel', 'concrete'];

/** Real-world metres per repeat. Must match `ROOF_REPEAT_M` in buildingWorker. */
export const ROOF_REPEAT_M = 4.0;

const PLACEHOLDER_PX = 256;

/**
 * Which roof a building gets.
 *
 * Barcelona reads as pantile on older residential blocks and flat gravel `terrat` on most of the
 * Eixample; concrete belongs to industrial and large commercial. Deterministic from the OSM id for
 * the same reason the facade pick is (a building split across two tiles is emitted by both — a
 * random pick would give its halves different roofs, along a line straight down the middle).
 */
export function roofLayerFor(category, buildingId, heightM) {
  if (category === 'industrial' || category === 'commercial_glass') return 2;
  if (heightM != null && heightM > 28) return 2;              // towers are poured concrete decks
  let h = (buildingId | 0) || 1;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  // ⚠ Take HIGH bits and a percentage, not `% 3` on the raw value. xorshift's low bits are not
  // uniform mod 3: `Math.abs(h) % 3 === 0` measured 169/300 (56%) pantile, not the ~33% it reads
  // like — so the city came out mostly pitched tile when Barcelona is mostly flat `terrat`. Caught
  // by the distribution test, which is why that test asserts a SHAPE and not just a range.
  const pct = ((h >>> 8) & 0xffff) % 100;
  if (category === 'commercial' || category === 'office') return pct < 45 ? 1 : 2;
  return pct < 22 ? 0 : 1;                                     // residential: ~22% pantile, rest terrat
}

function paintPantile(ctx, px) {
  // Courses of half-round tile running along +X. Near-white; the terracotta comes from vertex colour.
  ctx.fillStyle = '#efece7'; ctx.fillRect(0, 0, px, px);
  const courses = 8, ch = px / courses;
  for (let c = 0; c < courses; c++) {
    const y = c * ch;
    const g = ctx.createLinearGradient(0, y, 0, y + ch);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#e6e2dc'); g.addColorStop(1, '#d5d0c9');
    ctx.fillStyle = g; ctx.fillRect(0, y, px, ch * 0.94);
  }
}
function paintGravel(ctx, px) {
  ctx.fillStyle = '#eceae6'; ctx.fillRect(0, 0, px, px);
  // Deterministic speckle — a seeded LCG, not Math.random, so the texture is identical every load and
  // does not shimmer between sessions or differ between the main thread and a reload.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < px * 14; i++) {
    const v = 200 + Math.floor(rnd() * 55);
    ctx.fillStyle = `rgb(${v},${v - 3},${v - 8})`;
    ctx.fillRect(Math.floor(rnd() * px), Math.floor(rnd() * px), 2, 2);
  }
}
function paintConcrete(ctx, px) {
  ctx.fillStyle = '#f0efed'; ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = '#dedbd6'; ctx.lineWidth = 2;             // expansion joints on a 2 m grid
  const half = px / 2;
  ctx.beginPath();
  ctx.moveTo(half, 0); ctx.lineTo(half, px); ctx.moveTo(0, half); ctx.lineTo(px, half);
  ctx.stroke();
}
const PAINTERS = [paintPantile, paintGravel, paintConcrete];

/** Build the roof array. Main thread only — needs a canvas. */
export function createRoofArray(THREE) {
  const px = PLACEHOLDER_PX, n = ROOF_LAYERS.length;
  const data = new Uint8Array(px * px * 4 * n);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(px, px)
    : Object.assign(document.createElement('canvas'), { width: px, height: px });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < n; i++) {
    ctx.clearRect(0, 0, px, px);
    PAINTERS[i](ctx, px);
    data.set(ctx.getImageData(0, 0, px, px).data, i * px * px * 4);
  }
  const tex = new THREE.DataArrayTexture(data, px, px, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // No mip chain — texStorage3D allocates levels that are never generated, and an INCOMPLETE texture
  // samples BLACK rather than blurry. Same reasoning as the facade array; real KTX2 ships its mips.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bind the roof array to the shared roof material.
 *
 * ⚠ Carries its OWN uv varying. three declares `vMapUv` only inside `#ifdef USE_MAP`, so a patch that
 * used it would fail to COMPILE on any roof material without a bound map — see D-30, which cost a
 * drive when the facade patch made exactly that assumption.
 */
export function patchRoofArrayMaterial(material, arrayTex) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRoofArray = { value: arrayTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aLayer;\nvarying float vRoofLayer;\nvarying vec2 vRoofUv;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvRoofLayer = aLayer;\nvRoofUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray uRoofArray;\n' +
        'varying float vRoofLayer;\nvarying vec2 vRoofUv;')
      .replace('#include <map_fragment>',
        'diffuseColor *= texture(uRoofArray, vec3(vRoofUv, vRoofLayer));');
  };
  material.customProgramCacheKey = () => 'roofArray-v1';
  material.needsUpdate = true;
  return material;
}

/**
 * treeCards.js — v3 P3-10: photographic crossed-quad tree cards.
 *
 * WHAT THIS REPLACES. The legacy trees are a trunk cylinder plus 2-3 icosahedron foliage lobes
 * (~20 tris each) tinted with a flat green — the "20-tri tree blobs" the v2 audit named as one of
 * the three headline ASSET gaps. Six real Barcelona species now live in one 3072x2048 atlas
 * (tools/build-tree-atlas.py), and each renders as two crossed quads: 4 triangles instead of ~80,
 * carrying a photographic canopy instead of a solid colour. Cheaper AND better, which is unusual
 * enough to be worth stating: the win comes from moving detail out of geometry and into a texture.
 *
 * THE THREE THINGS THAT MAKE OR BREAK A CARD, and what this file does about each:
 *
 *   1. SIZE. A card must be sized from the tree's real height, and the quad's UV must be the
 *      OPAQUE sub-rect of its atlas cell, not the whole cell. Map the whole cell and the
 *      transparent packing margin scales into the quad, so a 15 m Washingtonia draws visibly
 *      shorter than 15 m. The bake emits `contentUV` for exactly this.
 *
 *   2. LIGHTING. Crossed quads are flat, so face normals make a tree read as two pieces of card.
 *      The normals here are a DOME radiating from the canopy centre, which is what makes the
 *      silhouette shade like a volume. That dome is then undone by three's own double-sided
 *      shading, which negates the normal on back faces — a dome normal seen from behind points
 *      INTO the tree and the card goes black. So this material cancels the flip (see CARD_UNLIT_BACK).
 *
 *   3. SORTING. These are alphaTest cutouts, never `transparent: true`. A city block is tens of
 *      thousands of quads; blending them means a per-frame depth sort of the whole set and no
 *      early-z. The existing billboard impostor material still sets transparent:true — that is a
 *      known separate cost, tracked as the P3-10c billboard collapse.
 */
import * as THREE from 'three';
import { patchMaterial } from './materialRegistry.js';
import { injectTreeWind } from './treeWind.js';
import MANIFEST from './treeAtlas.js';

const ATLAS_ALBEDO = '/textures/vegetation/tree_atlas_albedo.png';
const ATLAS_NORMAL = '/textures/vegetation/tree_atlas_normal.png';

/** The six species, in atlas cell order. Index === the variant index the worker buckets by. */
export const TREE_CARD_SPECIES = MANIFEST.species;
export const TREE_CARD_COUNT = MANIFEST.species.length;

// Cutout threshold. 0.5 is the neutral midpoint; this sits deliberately below it because the mip
// chain averages canopy alpha toward zero, and a canopy that erodes as it recedes is a far more
// visible error than one that is a pixel too generous. Cards only survive to TREE_FULL_DISTANCE
// before the billboard impostors take over, so only the low mips are ever asked to hold up.
const CARD_ALPHA_TEST = 0.4;

// Where the canopy mass sits, as a fraction of card height — the origin of the dome normals.
const CANOPY_CENTRE_Y = 0.62;
// How much the dome is pulled back toward straight up. Pure radial makes the lower card face
// downward and read as dead shadow; this keeps the underside lit like foliage rather than like a
// floor. Tuned by eye against the sun elevation in the default day rig.
const DOME_UP_BIAS = 0.35;

let _geometries = null;
let _material = null;
let _albedoTex = null;
let _normalTex = null;

function loadAtlasTextures() {
  if (_albedoTex) return { albedo: _albedoTex, normal: _normalTex };
  const loader = new THREE.TextureLoader();
  // Loaded async, assigned NOW: three fills the image in later and simply re-uploads. It does not
  // recompile the program, because the map/normalMap slots are already declared on the material —
  // which is what keeps this clear of G-53 (no shader churn after the boot warm-up).
  _albedoTex = loader.load(ATLAS_ALBEDO);
  _albedoTex.colorSpace = THREE.SRGBColorSpace;
  _normalTex = loader.load(ATLAS_NORMAL);
  _normalTex.colorSpace = THREE.NoColorSpace;   // a normal map is data, not colour
  for (const t of [_albedoTex, _normalTex]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;   // an atlas must never wrap into its neighbour
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;                                 // canopies are viewed at grazing angles
  }
  return { albedo: _albedoTex, normal: _normalTex };
}

/**
 * One species' card: two quads crossed at 90°, standing on y=0, centred on the trunk.
 * 8 vertices, 4 triangles. Returns a non-indexed-free (indexed) BufferGeometry.
 */
function buildCardGeometry(species) {
  const h = species.heightM;
  const w = h * species.aspect;     // preserve the image's own proportions — canopyM is advisory
  const hw = w / 2;
  const [u0, v0, du, dv] = species.contentUV;

  const pos = [], nrm = [], uv = [], idx = [];
  const cy = h * CANOPY_CENTRE_Y;

  // corners as (across, up) with `across` mapped onto X for one quad and Z for the other
  const corners = [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
  const uvs = [[u0, v0], [u0 + du, v0], [u0 + du, v0 + dv], [u0, v0 + dv]];

  for (let q = 0; q < 2; q++) {
    const base = q * 4;
    for (let c = 0; c < 4; c++) {
      const [a, y] = corners[c];
      const x = q === 0 ? a : 0;
      const z = q === 0 ? 0 : a;
      pos.push(x, y, z);

      // Dome normal: radiate from the canopy centre, then bias back toward up.
      let nx = x, ny = y - cy, nz = z;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      ny += DOME_UP_BIAS;
      const l2 = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l2, ny / l2, nz / l2);

      uv.push(uvs[c][0], uvs[c][1]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // The pools allocate from these bounds; a card that sways must still be inside them.
  geo.computeBoundingSphere();
  geo.userData.species = species.name;
  return geo;
}

/**
 * The atlas textures. Exported because the billboard impostors draw from the same albedo — a tree
 * must not change species when it crosses the LOD band.
 */
export function getTreeCardAtlas() { return loadAtlasTextures(); }

/** Card geometry per species, indexed by variant index. Built once. */
export function buildTreeCardGeometries() {
  if (_geometries) return _geometries;
  _geometries = TREE_CARD_SPECIES.map(buildCardGeometry);
  return _geometries;
}

// Set true once the double-sided flip has actually been cancelled in a compiled shader. If a three
// upgrade renames the chunk this stays false and the test that guards it fails loudly, rather than
// every tree in the city quietly going black on its far side.
export let CARD_UNLIT_BACK = false;
export function _resetCardBackFlagForTest() { CARD_UNLIT_BACK = false; }

const FACE_DIRECTION_SRC = 'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;';
const NORMAL_CHUNK_INCLUDE = '#include <normal_fragment_begin>';

/**
 * Cancel the double-sided normal flip in a material's fragment shader.
 *
 * Foliage is not a solid surface: both faces of a card are the same leaves and must shade the same
 * way. Without this the dome normal inverts on back faces and the tree is black from behind.
 *
 * THE TRAP, which this already fell into once. `onBeforeCompile` hands you the shader with its
 * `#include <...>` directives STILL UNRESOLVED — three expands chunks afterwards, inside
 * WebGLProgram. So searching shader.fragmentShader for the chunk's TEXT can never match, the
 * replace silently no-ops, and every card in the city darkens from behind while the build, the
 * tests and the shader compile all stay green. The include directive is what is actually present,
 * so the chunk must be expanded here by hand and substituted for the directive.
 *
 * Exported so the test can drive the real code path rather than assert against a source file that
 * the bundle does not even use — which is exactly how this shipped broken the first time.
 */
export function patchCardFaceDirection(shader) {
  const chunk = THREE.ShaderChunk.normal_fragment_begin;
  if (!shader.fragmentShader.includes(NORMAL_CHUNK_INCLUDE) || !chunk || !chunk.includes(FACE_DIRECTION_SRC)) {
    console.warn('[treeCards] normal_fragment_begin not patchable — cards will darken from behind (three upgrade?)');
    return false;
  }
  shader.fragmentShader = shader.fragmentShader.replace(
    NORMAL_CHUNK_INCLUDE,
    chunk.replace(FACE_DIRECTION_SRC,
      'float faceDirection = 1.0;   // treeCards: foliage shades alike on both faces'),
  );
  return true;
}

export function getTreeCardMaterial() {
  if (_material) return _material;
  const { albedo, normal } = loadAtlasTextures();

  _material = new THREE.MeshLambertMaterial({
    map: albedo,
    normalMap: normal,
    // Same texture as the albedo — see CARD_NIGHT_EMISSIVE for why the night lift must be
    // modulated rather than flat. Declared at CREATION so the USE_EMISSIVEMAP define is baked in
    // before the boot warm-up compiles this material; adding it later would recompile every tree
    // shader mid-drive, which is exactly what G-53 forbids.
    emissiveMap: albedo,
    alphaTest: CARD_ALPHA_TEST,
    transparent: false,        // see (3) in the file header — never blend these
    side: THREE.DoubleSide,
    vertexColors: false,       // per-instance tint arrives via BatchedMesh.setColorAt, not vertex colours
  });
  // AD-5: the normal map is CALIBRATED at bake into the §3.7 foliage band (mean |N.xy| 0.20-0.35),
  // which is what makes 1.0 the correct value here. This knob is reserved for LOD fade, never taste.
  _material.normalScale = new THREE.Vector2(1.0, 1.0);
  _applyCardNight(_material);   // match current day/night state at creation

  patchMaterial(_material, (shader) => {
    injectTreeWind(shader);

    if (patchCardFaceDirection(shader)) CARD_UNLIT_BACK = true;
  }, 'vegTreeCard');

  return _material;
}

// ── Night ─────────────────────────────────────────────────────────────────────────────────────
//
// Normalize put foliage at L* 45, which is right under a sun and far too dark under none: at night
// the canopies went near-black while the buildings behind them stayed lit.
//
// The lever has to be `emissive`, not `color`. Cards are lit MeshLambert, so colour MULTIPLIES the
// incoming light — and the incoming light at canopy height is close to zero, because the dominant
// night sources are street lamps mounted BELOW the crowns and pointing down. Multiplying zero by a
// brighter number is still zero. Emissive adds light independent of the rig, which is also the
// honest physical story: a city canopy at night is lit by skyglow, not by the lamps under it.
//
// A FLAT emissive is not enough on its own, and the first attempt proved it: 0.05 constant across
// the card lifted every texel by the same amount, so the canopy's own light and shade cancelled out
// and the trees went pale, flat and MINT — brighter than the facades behind them, which is worse
// than the black they replaced. The bible's §4.4 note lists this exact overshoot three times in
// this repo's history.
//
// So the lift is MODULATED BY THE ALBEDO: `emissiveMap = map`. Emissive then scales with each
// texel's own colour, dark leaves stay dark, gaps stay gaps, and the canopy keeps its structure.
// Because the map is multiplied in, the scalar has to be larger than an unmodulated one would be —
// mean foliage albedo is ~0.25 linear, so the net lift is roughly a quarter of the number below.
const CARD_NIGHT_EMISSIVE = [0.042, 0.050, 0.044];

// Night also DARKENS the albedo. Cancelling the double-sided flip (patchCardFaceDirection) was
// correct but it lit the back half of every canopy that used to fall dark, so the cards got
// materially brighter at exactly the moment the lift landed — the two changes compounded and the
// trees read as daylit foliage in a night scene. This tint pulls the lit response back down; the
// emissive above then sets the floor so they do not go black.
export const CARD_NIGHT_TINT = [0.55, 0.62, 0.56];

/**
 * How much light a canopy actually receives at night, as a fraction of full albedo.
 *
 * The LOD impostors are UNLIT (MeshBasic): what you see is albedo x tint, full stop. The near cards
 * are LIT (MeshLambert): albedo x tint x whatever the night rig delivers, plus the emissive floor.
 * Those are two different equations, so giving each its own hand-picked night tint guarantees they
 * disagree — which is exactly what a tree changing brightness as it crosses the LOD band looks like.
 *
 * So the impostor tint is DERIVED from the card tint by this factor rather than guessed separately.
 * One number to move, and the two sides cannot drift apart.
 */
export const NIGHT_LIGHT_FRACTION = 0.38;

// The impostor material registers here so the live knob moves both sides together.
const _nightTintListeners = [];
export function onCardNightTint(fn) { _nightTintListeners.push(fn); }

let _cardNight = false;
function _applyCardNight(m) {
  if (!m) return;
  if (_cardNight) {
    m.emissive.setRGB(...CARD_NIGHT_EMISSIVE);
    m.color.setRGB(...CARD_NIGHT_TINT);
  } else {
    m.emissive.setRGB(0, 0, 0);
    m.color.setRGB(1, 1, 1);
  }
}

/**
 * Live tuning knob — `window._ddTreeNight(scale)` in the console while driving at night.
 *
 * Night foliage brightness cannot be judged from a screenshot or a contact sheet; it has to be
 * seen against lit facades, street lamps and headlights, at speed. Rebuilding between guesses puts
 * that judgement a full round-trip away, so this exposes it directly: dial it, then tell me the
 * number and it becomes the default. Dev convenience only — it changes one uniform, nothing else.
 */
if (typeof window !== 'undefined') {
  window._ddTreeNight = (emissiveScale = 1, tintScale = 1) => {
    if (!_material) return 'no card material yet — drive first';
    const e = CARD_NIGHT_EMISSIVE.map((c) => c * emissiveScale);
    const t = CARD_NIGHT_TINT.map((c) => Math.min(1, c * tintScale));
    _material.emissive.setRGB(...e);
    _material.color.setRGB(...t);
    // Move the LOD impostors with the near cards, or tuning one just breaks the match again.
    _nightTintListeners.forEach((fn) => fn(t));
    return `emissive ${e.map((c) => c.toFixed(4)).join(', ')} (x${emissiveScale})  ·  ` +
           `tint ${t.map((c) => c.toFixed(3)).join(', ')} (x${tintScale})  ·  ` +
           `impostors ${t.map((c) => (c * NIGHT_LIGHT_FRACTION).toFixed(3)).join(', ')}`;
  };
}

/**
 * Day/night switch for the card material. Called from envToggle alongside the other material
 * callbacks. Safe with respect to G-53: `emissive` is a plain uniform on MeshLambert (the slot
 * always exists), so changing it uploads a uniform and does NOT recompile the program.
 */
export function setTreeCardNightMode(isNight) {
  _cardNight = isNight;
  _applyCardNight(_material);
}

/** Test/debug seam. */
export function _cardInternals() {
  return { CARD_ALPHA_TEST, CANOPY_CENTRE_Y, DOME_UP_BIAS, FACE_DIRECTION_SRC, NORMAL_CHUNK_INCLUDE, CARD_NIGHT_EMISSIVE, CARD_NIGHT_TINT };
}

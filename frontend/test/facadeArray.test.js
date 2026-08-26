/**
 * v3 P3-04 — the facade array UV spec. P3-05 authors 8 layers against this, so a mistake here is
 * six days of art painted to the wrong dimensions.
 */
import test from 'node:test';
import fsSync from 'node:fs';
import assert from 'node:assert/strict';
import {
  LAYER_W_M, BODY_LAYER_H_M, GROUND_LAYER_H_M, BODY_LAYERS, GROUND_LAYERS,
  facadeLayerFor, groundLayerFor, bandUV, texelDensity,
  GROUND_LAYER_BASE, encodeGroundLayer, decodeLayer,
} from '../src/map/facadeArray.js';
import { STOREY_H, WALL_REPEAT_HORIZONTAL_M } from '../src/buildingConstants.js';

test('the layer set is 8 wide, matching the 8-layer array', () => {
  assert.equal(BODY_LAYERS.length, 8);
  assert.equal(GROUND_LAYERS.length, 8);
  assert.equal(new Set(BODY_LAYERS).size, 8, 'duplicate names would make the authoring order ambiguous');
});

test('texel density hits the art bible band (85-150 texels/m)', () => {
  const body = texelDensity(1024, LAYER_W_M);
  assert.ok(body >= 85 && body <= 150, `body ${body} texels/m outside 85-150`);
  // Body layers are 1024² over LAYER_W_M x BODY_LAYER_H_M, and those are 8.0 and 7.0 — so the layer
  // is NOT square in metres per texel, and must not be asserted to be. BODY_LAYER_H_M is derived
  // from the bake's STOREY_H (2 x 3.5) rather than the plan's assumed 4.0 m, because a layer that
  // disagrees with the geometry drifts its window rows against the floors they belong to.
  const bodyV = texelDensity(1024, BODY_LAYER_H_M);
  assert.ok(bodyV >= 85 && bodyV <= 150, `body vertical ${bodyV} texels/m outside 85-150`);
  // Ground is 512 over 8.0 x 4.0 — half across. Deliberate: it never tiles vertically.
  assert.ok(texelDensity(512, GROUND_LAYER_H_M) >= 85, 'ground vertical density stays in band');
});

test('the body layer span is derived from the bake storey, not judged by eye', () => {
  // Four values were tried and the first three were all chasing a unit error rather than a size:
  //   8.0   the plan's "2 storeys of 4.0 m", against a bake storey of 3.5 — rows drifted vs floors
  //   7.0   derived as 2 x STOREY_H — the drift went, the stretch stayed
  //   12x12 judged on screen; it looked best of the three because it COMPENSATED for the stretch
  //   7x7   once v was divided by STOREY_H instead of FLOOR_HEIGHT, the physical value is right
  // The lesson is that "it looks better" is not evidence about a span when a UNIT is wrong: every
  // value felt like an improvement and none of them could work.
  assert.equal(BODY_LAYER_H_M, 2 * STOREY_H, 'body layer is two REAL storeys');
  assert.ok(BODY_LAYER_H_M > GROUND_LAYER_H_M, 'a body tile must cover more than one ground module');
});

test('variant pick is DETERMINISTIC — a building split across tiles must not differ', () => {
  // A building straddling a tile boundary is emitted by both tiles. A random pick would give its
  // halves different facades: a seam down the middle of one building.
  for (const id of [1, 2, 7, 12345, 902208621, 20353556]) {
    const a = facadeLayerFor('residential', id);
    assert.equal(a, facadeLayerFor('residential', id), `id ${id} was not stable`);
    assert.ok(Number.isInteger(a) && a >= 0 && a < BODY_LAYERS.length, `id ${id} gave layer ${a}`);
  }
});

test('the hash spreads across all five residential variants', () => {
  // `id % n` alone clusters badly on sequential OSM ids — that is why there is a hash at all.
  const seen = new Set();
  for (let id = 1000; id < 1400; id++) seen.add(facadeLayerFor('residential', id));
  assert.equal(seen.size, 5, `expected all 5 residential variants, saw ${[...seen].sort()}`);
});

test('single-variant categories always land on their own layer', () => {
  for (const [cat, expected] of [['commercial', 5], ['office', 6], ['industrial', 7]]) {
    for (const id of [1, 999, 123456]) assert.equal(facadeLayerFor(cat, id), expected, cat);
  }
});

test('an unknown category degrades to residential rather than undefined', () => {
  const l = facadeLayerFor('not-a-category', 42);
  assert.ok(l >= 0 && l <= 4, `fell through to ${l}`);
});

test('ground and body stay in the same variant family', () => {
  // Otherwise a brick body gets a glass lobby.
  for (const id of [3, 77, 5150]) {
    assert.equal(groundLayerFor('residential', id), facadeLayerFor('residential', id));
  }
});

test('the GROUND band never tiles vertically — the pavement is not periodic', () => {
  const uv = bandUV('ground', 24, 3.8);
  assert.equal(uv.vRepeat, 1, 'a repeating ground band would stack shopfronts up the wall');
  assert.equal(uv.uRepeat, 24 / LAYER_W_M, 'u must still repeat along the street');
});

test('the BODY band repeats per 2-storey layer, not per storey', () => {
  const uv = bandUV('body', 24, 16);            // 16 m of body = 2 layers
  assert.equal(uv.vRepeat, 16 / BODY_LAYER_H_M);
  assert.ok(uv.vRepeat > 1, 'authoring a 1-storey tile and repeating per storey reads as a grid');
});

test('u repeat is height-independent — the same wall length gives the same u at any height', () => {
  assert.equal(bandUV('body', 24, 8).uRepeat, bandUV('body', 24, 40).uRepeat);
  assert.equal(bandUV('ground', 24, 3.8).uRepeat, bandUV('body', 24, 40).uRepeat,
    'ground and body must share u so their vertical seam lines up horizontally');
});

// ── v3 P3-04: the per-vertex aLayer path ─────────────────────────────────────────────────────────
import { extrudePolygonWallBands, mergeBufferSets } from '../src/workers/workerGeometry.js';

const SQ = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];   // CW
const OPTS = { hRepeatM: 8, groundH: 3.8, gFrac: 0.38, storeyH: 3.5, crownH: 1.2 };

test('aLayer is PER-BAND — ground indexes one array, body and crown the other', () => {
  // This is the whole reason aLayer is per-vertex rather than per-building: each array layer then
  // wraps independently, which is what removes the fract() seam the task warns about.
  const g = extrudePolygonWallBands(SQ, 21, 0, { ...OPTS, groundLayer: 3, bodyLayer: 6 });
  const quads = g.layers.length / 4;
  assert.ok(quads > 0);
  for (let q = 0; q < quads; q++) {
    const y0 = g.positions[q * 12 + 1];
    const L = [0, 1, 2, 3].map((k) => g.layers[q * 4 + k]);
    assert.ok(L.every((v) => v === L[0]), `quad ${q} has mixed layers ${L} — it straddles two arrays`);
    // The band starting at baseY is the ground band; every other band is body or crown.
    assert.equal(L[0], y0 === 0 ? 3 : 6, `quad ${q} (y0=${y0}) got layer ${L[0]}`);
  }
});

test('no layers are emitted when none are asked for — nothing pays for the attribute', () => {
  const g = extrudePolygonWallBands(SQ, 21, 0, OPTS);
  assert.equal(g.layers, undefined, 'emitting an unused per-vertex float costs VRAM and bandwidth');
});

test('mergeBufferSets carries layers through — merging is where attributes get silently dropped', () => {
  const g = extrudePolygonWallBands(SQ, 21, 0, { ...OPTS, groundLayer: 1, bodyLayer: 2 });
  const m = mergeBufferSets([g, g]);
  assert.ok(m.layers, 'layers vanished in the merge — the attribute would reach the GPU as zeros');
  assert.equal(m.layers.length, m.positions.length / 3, 'one layer index per vertex');
  assert.equal(m.layers.length, g.layers.length * 2);
});

test('merging a layered set with an UNLAYERED one does not corrupt indices', () => {
  // Detail geometry has no layers. If the merge allocated but skipped the copy, those vertices would
  // silently read layer 0 — a wrong facade rather than an obvious failure.
  const a = extrudePolygonWallBands(SQ, 21, 0, { ...OPTS, groundLayer: 5, bodyLayer: 5 });
  const b = extrudePolygonWallBands(SQ, 21, 0, OPTS);        // no layers
  const m = mergeBufferSets([a, b]);
  assert.equal(m.layers.length, m.positions.length / 3);
  for (let i = 0; i < a.layers.length; i++) assert.equal(m.layers[i], 5, 'layered half was corrupted');
});

// ── v3 P3-04: the one-float-two-arrays encoding ──────────────────────────────────────────────────
// `aLayer` is a single float per vertex addressing TWO arrays. The shader branches on
// GROUND_LAYER_BASE; if these two ever disagree, ground bands sample the body array and every
// shopfront becomes a window wall.

test('encode/decode round-trips for every layer index', () => {
  for (let i = 0; i < BODY_LAYERS.length; i++) {
    assert.deepEqual(decodeLayer(i), { array: 'body', index: i });
    assert.deepEqual(decodeLayer(encodeGroundLayer(i)), { array: 'ground', index: i });
  }
});

test('the base leaves room for the body array to grow', () => {
  assert.ok(GROUND_LAYER_BASE >= BODY_LAYERS.length,
    'a ground index would collide with a body index — shopfronts would sample the body array');
  assert.ok(GROUND_LAYER_BASE >= 16, 'headroom to 16 body variants before the encoding must change');
});

test('encoded ground indices never collide with body indices', () => {
  const body = new Set(BODY_LAYERS.map((_, i) => i));
  for (let i = 0; i < GROUND_LAYERS.length; i++) {
    assert.ok(!body.has(encodeGroundLayer(i)), `ground ${i} encodes onto a body index`);
  }
});

test('the shader branch constant matches the JS constant', () => {
  // The GLSL is built by string concatenation from GROUND_LAYER_BASE, so this asserts they cannot
  // drift — a mismatch is invisible in JS and shows only as wrong facades on screen.
  const src = fsSync.readFileSync(new URL('../src/map/facadeArray.js', import.meta.url), 'utf8');
  const patch = src.slice(src.indexOf('patchFacadeArrayMaterial'));
  const derived = (patch.match(/GROUND_LAYER_BASE \+/g) || []).length;
  assert.ok(derived >= 2, `the shader must derive its threshold from the JS constant (${derived} uses)`);
  assert.ok(!/lyr >= 16\.0/.test(patch), 'a hard-coded 16.0 in the GLSL would drift from the constant');
});

// ── v3 P3-04: the shader patch must not depend on three's CONDITIONAL varyings ───────────────────
// Measured failure, 2026-08-25: the patch used `vMapUv`, which three declares only inside
// `#ifdef USE_MAP`. The glass facade path is a MeshPhongMaterial without that map, so the shader
// failed to compile —
//     ERROR: 0:887: 'vMapUv' : undeclared identifier   [Material Type: MeshPhongMaterial]
// — which removed every wall in the city, left only unpatched roof/detail materials visible, and
// lagged the frame while three retried the broken program per material key.
import { patchFacadeArrayMaterial } from '../src/map/facadeArray.js';

function generate() {
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main(){ #include <begin_vertex> }',
    // BOTH includes: the patch samples the array at <map_fragment> and rewrites diffuseColor after
    // <color_fragment>, because three applies the per-building vertex tint between the two. A stub
    // with only map_fragment silently skips half the patch and tests the wrong shader.
    // All three includes: the patch samples at <map_fragment>, drives night windows at
    // <emissivemap_fragment>, and rewrites diffuseColor after <color_fragment>. A stub missing any
    // of them silently skips part of the patch and tests a shader that does not ship.
    fragmentShader: '#include <common>\nvoid main(){ #include <map_fragment>\n'
      + '#include <color_fragment>\n#include <emissivemap_fragment> }',
  };
  const mat = { needsUpdate: false };
  patchFacadeArrayMaterial(mat, { body: 'B', ground: 'G' });
  mat.onBeforeCompile(shader);
  return shader;
}

test('the patch never references a map-conditional varying', () => {
  const s = generate();
  const src = s.vertexShader + s.fragmentShader;
  for (const cond of ['vMapUv', 'vAlphaMapUv', 'vEmissiveMapUv', 'vNormalMapUv']) {
    assert.ok(!src.includes(cond),
      `${cond} is declared only under its #ifdef — a material without that map fails to COMPILE`);
  }
});

test('it declares and fills its own UV varying from the stock `uv` attribute', () => {
  const s = generate();
  assert.match(s.vertexShader, /varying vec2 vFacadeUv/, 'vertex must declare the varying');
  assert.match(s.vertexShader, /vFacadeUv\s*=\s*uv/, 'and fill it from the stock attribute');
  assert.match(s.fragmentShader, /varying vec2 vFacadeUv/, 'fragment must declare it too');
});

test('both array uniforms are bound and both branches sample', () => {
  const s = generate();
  // uFacadeScale converts the LEGACY wall UV into layer space — u arrives in units of
  // WALL_REPEAT_HORIZONTAL_M (12 m) and v in FLOOR_HEIGHT (10 m), while the layers are 8 x 7.
  // Sampling the array with the raw attribute stretched it by different factors on each axis, so
  // windows rendered landscape where every source plate draws them portrait.
  assert.deepEqual(Object.keys(s.uniforms).sort(),
    ['uFacadeBody', 'uFacadeGround', 'uFacadeScale', 'uFacadeTintAmt', 'uFacadeTintMean',
     'uFacadeWindowGlow']);
  // The per-building vertex tint must NOT multiply an authored albedo — it did, and eight normalized
  // variants all rendered the same brown. Its luminance survives, its hue is discarded.
  assert.match(s.fragmentShader, /facadeTexel\.rgb \* facTint/, 'authored albedo is the base, not a multiplicand');
  assert.match(s.vertexShader, /vFacadeUv = uv \* uFacadeScale/, 'wall UV is converted, not raw');
  assert.match(s.fragmentShader, /texture\(uFacadeGround, vec3\(vFacadeUv/);
  assert.match(s.fragmentShader, /texture\(uFacadeBody, vec3\(vFacadeUv/);
});

test('aLayer is declared as an attribute and forwarded', () => {
  const s = generate();
  assert.match(s.vertexShader, /attribute float aLayer/);
  assert.match(s.vertexShader, /vLayer\s*=\s*aLayer/);
});

test('night windows are a generated grid in facade UV space', () => {
  // Buildings carry a separately GENERATED emissiveMap whose grid sits at the old FLOOR_HEIGHT
  // pitch, while the facade array is at LAYER_W_M x BODY_LAYER_H_M. Two window systems at two
  // pitches cannot agree — lit rectangles floated between and across the painted windows. The
  // albedo's alpha IS the window mask, so driving emissive from it aligns them by construction.
  const s = generate();
  // NOT from the mask. A mask derived from COLOUR was good on six of eight plates — fine for
  // deciding what to GRADE, useless for deciding what EMITS, because every dirty patch becomes a
  // glowing blob. A generated grid drawn in the SAME UV space aligns with the painted windows by
  // construction without depending on mask quality at all.
  assert.match(s.fragmentShader, /totalEmissiveRadiance = uFacadeWindowGlow \* tone/,
    'night glow is a generated grid');
  assert.ok(!/facadeTexel\.a/.test(s.fragmentShader), 'the alpha mask is not used anywhere');
  // Hash the window CELL, not the fragment: per-fragment randomness shimmers as the camera moves.
  assert.match(s.fragmentShader, /vec2 wcell = floor\(wuv\)/, 'lit/unlit is per window cell');
});

test('a square layer maps to a SQUARE patch of wall — the 2.9x stretch', () => {
  // THE BUG THIS LOCKS. The wall UV has two vertical conventions, and the array path uses the one
  // that is NOT obvious:
  //     u  always   wallLen / WALL_REPEAT_HORIZONTAL_M   (12 m per repeat)
  //     v  legacy   ...FLOOR_HEIGHT                      (10 m per repeat)
  //     v  ARRAY    bodyH / STOREY_H                     (3.5 m per repeat)  <- windowOnlyTile
  // Scaling v by FLOOR_HEIGHT/BODY_LAYER_H_M made the layer span 4.2 m vertically against 12 m
  // horizontally: every window rendered 2.86x too wide. Three different BODY_LAYER_H_M values were
  // tried against it and none worked, because rescaling an axis cannot fix a wrong UNIT.
  const metresPerRepeatU = LAYER_W_M;
  const metresPerRepeatV = BODY_LAYER_H_M;
  const aspect = metresPerRepeatU / metresPerRepeatV;
  assert.ok(Math.abs(aspect - 1) < 1e-6,
    `layer maps ${metresPerRepeatU}m x ${metresPerRepeatV}m of wall — aspect ${aspect.toFixed(2)}x, must be 1`);

  // And the scale must divide v by the storey height, not the legacy floor height.
  const s = generate();
  assert.equal(s.uniforms.uFacadeScale.value.y, STOREY_H / BODY_LAYER_H_M,
    'v scale must use STOREY_H — windowOnlyTile makes v per-storey');
  assert.equal(s.uniforms.uFacadeScale.value.x, WALL_REPEAT_HORIZONTAL_M / LAYER_W_M);
});

/**
 * v3 P3-06 — roof UVs and the roof surface array.
 *
 * Roofs went through `ensureUvs`, which zero-fills: every roof vertex sampled uv (0,0), so no roof in
 * the city could carry a texture even if one were bound. `getRoofMaterialKey()` is a literal constant,
 * so one material dresses every roof — which is why the plan calls this the best ratio in the
 * programme.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { processBuildingsInWorker } from '../src/workers/buildingWorker.js';
import { ROOF_LAYERS, ROOF_REPEAT_M, roofLayerFor, patchRoofArrayMaterial } from '../src/map/roofArray.js';

const square = (x, z, s = 12) => [{ x, y: z }, { x, y: z + s }, { x: x + s, y: z + s }, { x: x + s, y: z }];
const mk = (id, height, type = 'residential', x = 100, z = 200) =>
  ({ id, footprint: square(x, z), height, type, shapeType: 'polygon' });
const run = (b) => processBuildingsInWorker({ buildings: b, roads: [], cx: 0, cy: 0, tileId: '16_0_0' }, { ...CONFIG });

test('roof UVs are no longer the zero-fill', () => {
  const g = run([mk(1, 21)]).roofGroups[0];
  assert.ok(g.uvs && g.uvs.length > 0, 'no roof uvs at all');
  assert.ok(!g.uvs.every((v) => v === 0), 'roof uvs are still all zero — every vertex samples (0,0)');
});

test('UVs are WORLD-planar, so the repeat is a real size not a per-building fraction', () => {
  // Per-building 0..1 UVs would scale the texture with the roof: a 6 m shed and a 60 m block would
  // show the same tile count, encoding building SIZE instead of material.
  const g = run([mk(1, 21, 'residential', 100, 200)]).roofGroups[0];
  let minU = Infinity, maxU = -Infinity;
  for (let i = 0; i < g.uvs.length; i += 2) { minU = Math.min(minU, g.uvs[i]); maxU = Math.max(maxU, g.uvs[i]); }
  // Tolerances are in WORLD CENTIMETRES, not float epsilon: the roof footprint is INSET ~2.8 cm from
  // the wall footprint. That is real geometry. The inset applies on EACH side, so the span tolerance
  // must be twice the origin tolerance — getting that wrong is what made this test fail once.
  const tolEdge = 0.05 / ROOF_REPEAT_M;          // 5 cm at one edge
  const tolSpan = 0.10 / ROOF_REPEAT_M;          // 5 cm at both edges
  assert.ok(Math.abs(minU - 100 / ROOF_REPEAT_M) < tolEdge, `u should start near worldX/${ROOF_REPEAT_M}, got ${minU}`);
  assert.ok(Math.abs((maxU - minU) - 12 / ROOF_REPEAT_M) < tolSpan, 'a 12 m roof must span ~12/repeat in u');
});

test('a bigger roof gets proportionally MORE repeats, not the same number', () => {
  const small = run([mk(1, 21, 'residential', 0, 0)]).roofGroups[0];
  const spanU = (g) => { let a = Infinity, b = -Infinity; for (let i = 0; i < g.uvs.length; i += 2) { a = Math.min(a, g.uvs[i]); b = Math.max(b, g.uvs[i]); } return b - a; };
  const big = processBuildingsInWorker({ buildings: [{ id: 2, footprint: square(0, 0, 48), height: 21, type: 'residential', shapeType: 'polygon' }], roads: [], cx: 0, cy: 0, tileId: 't' }, { ...CONFIG }).roofGroups[0];
  assert.ok(spanU(big) > spanU(small) * 3.5, 'a 4x wider roof must show ~4x the repeats');
});

test('neighbouring roofs CONTINUE each other — world projection means no per-roof reset', () => {
  const g = run([mk(1, 21, 'residential', 0, 0), mk(2, 21, 'residential', 12, 0)]).roofGroups[0];
  let maxU = -Infinity;
  for (let i = 0; i < g.uvs.length; i += 2) maxU = Math.max(maxU, g.uvs[i]);
  assert.ok(Math.abs(maxU - 24 / ROOF_REPEAT_M) < 0.05 / ROOF_REPEAT_M,
    'the far edge of the second roof must be at worldX 24 / repeat — a per-roof reset would cap it lower');
});

test('roof surface kind reaches the group — the literal that silently drops it (D-29)', () => {
  const g = run([mk(1, 21), mk(2, 21), mk(3, 45, 'commercial'), mk(4, 12, 'industrial')]).roofGroups[0];
  assert.ok(g.layers, 'roofGroups literal is not forwarding layers');
  assert.equal(g.layers.length, g.positions.length / 3);
});

test('roof kinds are deterministic and in range', () => {
  for (const id of [1, 2, 7, 902208621, 20353556]) {
    const a = roofLayerFor('residential', id, 21);
    assert.equal(a, roofLayerFor('residential', id, 21), 'not stable — a split building would differ');
    assert.ok(a >= 0 && a < ROOF_LAYERS.length);
  }
});

test('industrial, glass and towers get concrete decks', () => {
  assert.equal(roofLayerFor('industrial', 5, 12), 2);
  assert.equal(roofLayerFor('commercial_glass', 5, 80), 2);
  assert.equal(roofLayerFor('residential', 5, 40), 2, 'a 40 m block is a concrete deck, not pantile');
});

test('residential is mostly terrat with some pantile — Barcelona, not a village', () => {
  const kinds = { 0: 0, 1: 0, 2: 0 };
  for (let id = 1; id < 300; id++) kinds[roofLayerFor('residential', id, 18)]++;
  assert.ok(kinds[1] > kinds[0] * 2, `flat terrat must clearly dominate: got ${kinds[1]} terrat vs ${kinds[0]} pantile`);
  assert.ok(kinds[0] > 20, 'but pantile must be a real minority, not a rarity');
  assert.equal(kinds[2], 0, 'an 18 m residential block is not a concrete deck');
});

test('the roof patch declares its OWN uv varying, not three\'s map-conditional one', () => {
  // D-30: `vMapUv` exists only under #ifdef USE_MAP. A roof material without a bound map would fail
  // to COMPILE, not fall back.
  const shader = { uniforms: {}, vertexShader: '#include <common>\nvoid main(){ #include <begin_vertex> }',
                   fragmentShader: '#include <common>\nvoid main(){ #include <map_fragment> }' };
  const mat = {};
  patchRoofArrayMaterial(mat, 'TEX');
  mat.onBeforeCompile(shader);
  const src = shader.vertexShader + shader.fragmentShader;
  assert.ok(!src.includes('vMapUv'), 'references a map-conditional varying');
  assert.match(shader.vertexShader, /varying vec2 vRoofUv/);
  assert.match(shader.fragmentShader, /texture\(uRoofArray, vec3\(vRoofUv, vRoofLayer\)\)/);
  assert.deepEqual(Object.keys(shader.uniforms), ['uRoofArray']);
});

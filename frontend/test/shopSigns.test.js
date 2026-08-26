/**
 * Shop-name boards. Two of these guard bugs that are invisible until you look closely at a sign in
 * the right lighting, which is how the originals survived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/map/shopSignRenderer.js', 'utf8');

test('the boards light with the scene rather than being unlit', () => {
  assert.doesNotMatch(SRC, /MeshBasicMaterial/,
    'an unlit board is the same brightness at noon and under an awning — that is the sticker look');
  assert.match(SRC, /MeshLambertMaterial/);
  // The old night handling was a flat grey swapped into `color` — a hand-drawn stand-in for the
  // lighting the material was opting out of.
  assert.doesNotMatch(SRC, /_SIGN_NIGHT\s*=\s*0x6a6a78/, 'the fake night tint is gone');
});

test('emissiveMap gets the per-instance cell UV, not cell 0', () => {
  // three declares one varying PER MAP SLOT. Binding emissiveMap and only rewriting vMapUv leaves
  // every sign glowing with cell 0's artwork while its albedo shows the right name.
  assert.match(SRC, /emissiveMap/, 'the night glow rides the atlas so each board glows its own colour');
  assert.match(SRC, /vEmissiveMapUv\s*=/, 'emissive UV must be offset per instance');
  const vMap = SRC.indexOf('vMapUv = cellUv');
  const vEmi = SRC.indexOf('vEmissiveMapUv = cellUv');
  assert.ok(vMap > 0 && vEmi > vMap, 'both varyings take the same per-instance cell');
});

test('emissiveMap is bound at construction, not added later', () => {
  // Giving a material a map slot it was not compiled with forces a recompile mid-drive (G-53).
  const at = SRC.indexOf('new THREE.MeshLambertMaterial');
  const ctor = SRC.slice(at, SRC.indexOf('patchMaterial', at));   // search FROM the ctor — the import is above it
  assert.match(ctor, /emissiveMap:/, 'bound in the constructor');
});

test('the atlas is mipmapped — a fascia seen from a car is a minification case', () => {
  assert.match(SRC, /generateMipmaps\s*=\s*true/);
  assert.match(SRC, /LinearMipmapLinearFilter/);
});

test('every board colour passes the palette gate', async () => {
  // The pre-normalize set had SIX OF EIGHT over ΔE 15, the worst at C* 53 — see BOARDS.
  const block = SRC.slice(SRC.indexOf('const BOARDS = ['), SRC.indexOf('];', SRC.indexOf('const BOARDS = [')));
  const des = [...block.matchAll(/dE\s+([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(des.length, 8, 'all eight boards record their measured ΔE');
  for (const d of des) assert.ok(d <= 15, `board at ΔE ${d} exceeds the gate-4 threshold of 15`);
});

test('the board is painted, not filled', () => {
  // A flat fillRect + 2px stroke is a vector rectangle; no palette work rescues that.
  assert.match(SRC, /function paintBoard/);
  assert.match(SRC, /createLinearGradient/, 'occluded top / bounce-lit bottom');
  assert.match(SRC, /createRadialGradient/, 'corner grime');
});

/**
 * Awnings are geometry that must sit ON something else: every toldo has to land over a storefront
 * bay. The two renderers used to hold hand-synced COPIES of the row layout, and nothing failed
 * loudly when they drifted — you just got canopies floating on blank wall. These tests pin the
 * alignment, the outward projection, and the palette band.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildAwningMesh } from '../src/map/awningRenderer.js';
import { buildShopfrontMeshes, SHOP_ROW, shopSegSkipped } from '../src/map/shopfrontRenderer.js';

// A typical Eixample parcel: 26 m street frontage, 14 m deep, 6 storeys.
const parcel = (w = 26, d = 14, height = 21) => ({
  height,
  footprint: [ { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d } ],
});

/** Along-edge (t) spans of each quad row, from world positions on the +X edge. */
function spans(mesh) {
  const p = mesh.geometry.getAttribute('position');
  const out = [];
  for (let i = 0; i < p.count; i++) out.push(p.getX(i));
  return out;
}

test('every awning segment lands over a storefront bay', () => {
  const b = parcel();
  const awn = buildAwningMesh([b], {});
  const [frame] = buildShopfrontMeshes([b], {}) ?? [];
  assert.ok(awn, 'awnings built');
  assert.ok(frame, 'shopfronts built');

  const awnX = new Set(spans(awn).map(v => v.toFixed(2)));
  const shopX = spans(frame);
  // Each awning t-coordinate must coincide with a storefront coordinate (the bays share t0/t1).
  const shopMin = Math.min(...shopX), shopMax = Math.max(...shopX);
  for (const v of awnX) {
    const x = Number(v);
    assert.ok(x >= shopMin - 0.2 && x <= shopMax + 0.2,
      `awning at t=${x} lies outside the storefront row [${shopMin.toFixed(2)}, ${shopMax.toFixed(2)}]`);
  }
});

test('the row layout is shared, not copied', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('src/map/awningRenderer.js', 'utf8'));
  assert.match(src, /SHOP_ROW/, 'awningRenderer imports the shared layout');
  assert.doesNotMatch(src, /const SEG_LEN\s*=\s*[\d.]/, 'awningRenderer must not redeclare SEG_LEN');
  assert.doesNotMatch(src, /Math\.min\(\s*\d+\s*,/, 'awningRenderer must not hardcode the per-building cap');
});

test('awnings project outward over the sidewalk, not into the building', () => {
  const b = parcel();
  const awn = buildAwningMesh([b], {});
  const p = awn.geometry.getAttribute('position');
  const cz = 7;  // footprint centre in z
  let outward = 0, inward = 0;
  for (let i = 0; i < p.count; i++) (Math.abs(p.getZ(i) - cz) > 7 ? outward++ : inward++);
  assert.ok(outward > 0, 'some awning vertices reach past the façade');
  assert.equal(inward, 0, 'no awning vertex sits inside the footprint');
});

test('toldo colours sit inside the art-bible fabric band', () => {
  const awn = buildAwningMesh([parcel()], {});
  const c = awn.geometry.getAttribute('color');
  const col = new THREE.Color();
  for (let i = 0; i < c.count; i++) {
    col.setRGB(c.getX(i), c.getY(i), c.getZ(i));
    // sRGB relative luminance as a cheap stand-in for L*: the old palette sat far below this.
    const Y = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
    assert.ok(Y > 0.10, `toldo colour too dark (Y=${Y.toFixed(3)}) — the pre-normalize palette failed here`);
    assert.ok(Y < 0.75, `toldo colour too bright (Y=${Y.toFixed(3)})`);
  }
});

test('a long frontage is capped but a normal parcel is not', () => {
  const long = buildAwningMesh([parcel(400, 14, 21)], {});
  const p = long.geometry.getAttribute('position');
  const segs = p.count / 6;
  assert.ok(segs <= SHOP_ROW.MAX_SEGS_PER_BUILDING,
    `${segs} segments exceeds the per-building cap ${SHOP_ROW.MAX_SEGS_PER_BUILDING}`);
});

test('buildingRenderer no longer emits its own awning slab', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync('src/map/buildingRenderer.js', 'utf8'));
  assert.doesNotMatch(src, /awningGeoms\.push/, 'the legacy slab awning is gone');
  assert.doesNotMatch(src, /geoms:\s*awningGeoms/, 'the legacy slab awning group is gone');
});

test('the 3D shopfront is night-only, and switches on the material not the mesh', async () => {
  const { buildShopfrontMeshes, setShopfrontNightMode } = await import('../src/map/shopfrontRenderer.js');
  const b = parcel();

  setShopfrontNightMode(false);
  let meshes = buildShopfrontMeshes([b], {});
  for (const m of meshes) {
    assert.equal(m.material.visible, false,
      `${m.userData.type} must be hidden in day — P3-05's ground texture owns daylight`);
  }

  setShopfrontNightMode(true);
  for (const m of meshes) {
    assert.equal(m.material.visible, true, `${m.userData.type} must be visible at night`);
  }

  // mesh.visible is the distance LOD's, not ours — if we ever switch on it, tileManager overwrites us.
  const src = await import('node:fs').then(fs => fs.readFileSync('src/map/shopfrontRenderer.js', 'utf8'));
  assert.doesNotMatch(src, /mesh\.visible\s*=|m\.visible\s*=/, 'must not toggle mesh.visible');

  // Both materials are singletons, so tile unload must be told not to dispose them.
  for (const m of meshes) {
    assert.equal(m.userData.sharedMaterial, true, `${m.userData.type} shares its material`);
  }
  setShopfrontNightMode(false);
});

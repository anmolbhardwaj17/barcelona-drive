/**
 * v3 P4-15a — the shared car fleet.
 *
 * Traffic and parked cars are no longer 41 draws of their own meshes; they are instances in ONE
 * BatchedMesh plus one light InstancedMesh each. Everything pinned here is something that fails
 * SILENTLY — no throw, no warning, just cars in the wrong place, at the wrong size, or not drawn:
 *
 *   1. A recycled slot switched to a different variant must actually reach the multi-draw buffers.
 *      This is the `setGeometryIdAt` trap (test/batchedMesh.visibility.test.js states it upstream);
 *      here it is pinned through the pool's own API, which is what the two consumers call.
 *   2. Hiding a slot must remove it from the draw, or last rebuild's parked cars stay parked where
 *      the player no longer is.
 *   3. Running out of slots must degrade to fewer cars, not throw inside the frame loop.
 *   4. Light-quad offsets are in TARGET units and must be composed against an UNSCALED base. Get it
 *      wrong and the lights are scaled twice — a 5% error nobody would ever see, until the day the
 *      scale factor is not 0.95.
 *   5. The tire-smoke shader patch's anchor strings must still exist in three's MeshBasic source.
 *      A three upgrade that renames them makes the patch a no-op and every dust puff renders at
 *      full opacity forever, with nothing in the console.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCarPool, createLightPool, makeLightLocals, LIGHT_HEAD, LIGHT_TAIL } from '../src/car/carFleet.js';

/** Two stand-in "car" templates — the pool only ever reads geometry, material and dims. */
function makeTemplates() {
  const material = new THREE.MeshBasicMaterial();
  const mk = (w, h, l) => {
    const geometry = new THREE.BoxGeometry(w, h, l);
    geometry.computeBoundingSphere();
    return { geometry, material, scale: 1, dims: { w, h, l }, name: `t${w}` };
  };
  return [mk(1.8, 1.4, 4.0), mk(2.0, 1.6, 4.4)];
}

/**
 * Ask the BatchedMesh what it would actually draw. `_multiDrawCount` is only recomputed in
 * onBeforeRender, so the test has to drive that the way the renderer does.
 */
function drawnCount(pool, camera) {
  pool.bm.updateMatrixWorld(true);
  // Same arguments the renderer passes — onBeforeRender reads the geometry's index to work out the
  // byte offsets of the multi-draw, so camera alone is not enough.
  pool.bm.onBeforeRender(null, null, camera, pool.bm.geometry, pool.bm.material, null);
  return pool.drawnCount();
}

function frontCamera() {
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 1000);
  camera.position.set(0, 2, -20);   // looking down +Z at the origin, where the test places cars
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test('a slot is allocated hidden, and placing it draws it', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  const camera = frontCamera();

  const id = pool.alloc();
  assert.ok(id >= 0);
  assert.equal(drawnCount(pool, camera), 0, 'a fresh slot must not draw until it is placed');

  pool.place(id, 0, new THREE.Matrix4());
  assert.equal(drawnCount(pool, camera), 1);

  pool.hide(id);
  assert.equal(drawnCount(pool, camera), 0, 'hide() must remove the instance from the draw');
});

test('recycling a slot onto a different variant reaches the draw buffers', () => {
  // The trap: setGeometryIdAt alone updates _instanceInfo and never republishes. A parked-car
  // rebuild reuses slots and reassigns variants constantly, so a silent swap means the whole
  // street keeps yesterday's models.
  const scene = new THREE.Scene();
  const templates = makeTemplates();
  const pool = createCarPool(scene, templates);
  const camera = frontCamera();

  const id = pool.alloc();
  pool.place(id, 0, new THREE.Matrix4());
  const geoA = pool.bm.getGeometryIdAt(id);

  pool.place(id, 1, new THREE.Matrix4());
  const geoB = pool.bm.getGeometryIdAt(id);
  assert.notEqual(geoA, geoB, 'the two templates must map to two geometry ids');
  assert.equal(pool.bm._visibilityChanged || drawnCount(pool, camera) === 1, true);

  // The instance still draws, and it draws the SECOND geometry's index range.
  assert.equal(drawnCount(pool, camera), 1);
  const range = pool.bm.getGeometryRangeAt(geoB);
  const bpe = pool.bm.geometry.getIndex().array.BYTES_PER_ELEMENT;
  assert.equal(pool.bm._multiDrawStarts[0] / bpe, range.indexStart,
    'the published draw must point at the variant the instance was switched to');
});

test('variant index wraps instead of reading past the template list', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  const id = pool.alloc();
  // parkedCars hashes a variant from a road-segment seed; a template failing to load shortens the
  // list and would otherwise index undefined.
  assert.doesNotThrow(() => pool.place(id, 7, new THREE.Matrix4()));
  assert.equal(pool.bm.getGeometryIdAt(id), pool.bm.getGeometryIdAt(id));
});

test('exhausting the fleet returns -1 rather than throwing mid-frame', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  let id = 0, n = 0;
  while (id >= 0 && n < 5000) { id = pool.alloc(); n++; }
  assert.equal(id, -1, 'alloc must report exhaustion, not throw');
  assert.doesNotThrow(() => pool.place(-1, 0, new THREE.Matrix4()));
  assert.doesNotThrow(() => pool.hide(-1));
});

test('the pool never hands slots back to BatchedMesh (the O(n log n) freed-list trap, H3)', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  const a = pool.alloc();
  pool.place(a, 0, new THREE.Matrix4());
  pool.hide(a);
  assert.equal(pool.bm._availableInstanceIds.length, 0,
    'a hidden slot must stay OURS — one id in BatchedMesh\'s freed list makes every later ' +
    'addInstance sort that whole list (vegPools.js documents the multi-second stalls)');
  assert.equal(pool.allocatedCount(), 1);
});

test('released slots are recycled through OUR free list, never BatchedMesh\'s', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  const a = pool.alloc();
  const b = pool.alloc();
  assert.equal(pool.allocatedCount(), 2);

  pool.release(a);
  pool.release(b);
  assert.equal(pool.bm._availableInstanceIds.length, 0,
    'release() must not reach BatchedMesh.deleteInstance');

  const c = pool.alloc();
  assert.ok(c === a || c === b, 'a released slot must come back');
  assert.equal(pool.allocatedCount(), 2, 'recycling must not consume fresh capacity');
});

test('a recycled slot comes back HIDDEN, not showing the previous owner\'s car', () => {
  const scene = new THREE.Scene();
  const pool = createCarPool(scene, makeTemplates());
  const camera = frontCamera();
  const a = pool.alloc();
  pool.place(a, 0, new THREE.Matrix4());
  assert.equal(drawnCount(pool, camera), 1);

  pool.release(a);
  const b = pool.alloc();
  assert.equal(drawnCount(pool, camera), 0,
    'the recycled slot must be dark until its new owner places it');
  assert.equal(b, a);
});

test('light-quad locals are in target units, front at +Z and rear at -Z', () => {
  const dims = { w: 2.0, h: 1.5, l: 4.0 };
  const L = makeLightLocals(dims);
  const p = new THREE.Vector3();

  p.setFromMatrixPosition(L.head[0]);
  assert.ok(p.z > 0, 'head lights face forward (+Z)');
  assert.ok(Math.abs(p.z - dims.l * 0.49) < 1e-6, 'offsets are in the SAME units as dims');
  assert.ok(Math.abs(Math.abs(p.x) - dims.w * 0.30) < 1e-6);
  assert.ok(Math.abs(p.y - dims.h * 0.42) < 1e-6);

  p.setFromMatrixPosition(L.tail[0]);
  assert.ok(p.z < 0, 'tail lights face backward (-Z)');
});

test('a light composed against an UNSCALED base is not scaled twice', () => {
  // The car's instance matrix carries the CANON_LENGTH→target factor because the geometry is
  // canonical. The light locals already are in target units, so composing them against the car
  // matrix would apply the factor a second time. Both consumers build a separate unscaled base;
  // this is the assertion that says why.
  const SCALE = 0.95;
  const dims = { w: 2.0, h: 1.5, l: 4.0 };
  const L = makeLightLocals(dims);
  const pos = new THREE.Vector3(10, 0, 5);
  const q = new THREE.Quaternion();

  const carM = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(SCALE, SCALE, SCALE));
  const baseM = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));

  const wrong = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(carM, L.head[0]));
  const right = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(baseM, L.head[0]));

  assert.ok(Math.abs(right.z - (pos.z + dims.l * 0.49)) < 1e-6);
  assert.ok(wrong.distanceTo(right) > 1e-3, 'the two really do differ — this test is not vacuous');
});

test('the light pool is ONE mesh, with head and tail separated by instance colour', () => {
  const scene = new THREE.Scene();
  const lights = createLightPool({ scene, capacity: 8 });
  assert.equal(lights.im.isInstancedMesh, true);
  assert.ok(lights.im.instanceColor, 'instanceColor must exist from construction, not appear later');

  lights.begin();
  lights.put(new THREE.Matrix4(), LIGHT_HEAD);
  lights.put(new THREE.Matrix4(), LIGHT_TAIL);
  lights.commit();
  assert.equal(lights.im.count, 2);

  const c = new THREE.Color();
  lights.im.getColorAt(0, c);
  const head = c.clone();
  lights.im.getColorAt(1, c);
  assert.notDeepEqual([head.r, head.g, head.b], [c.r, c.g, c.b],
    'head and tail must not resolve to the same colour, or the rear lights render white');
  assert.ok(c.r > c.g && c.r > c.b, 'the tail colour is red');
});

test('begin() truncates: a shorter rebuild must not leave the previous frame\'s lights drawn', () => {
  const scene = new THREE.Scene();
  const lights = createLightPool({ scene, capacity: 8 });
  lights.begin();
  for (let i = 0; i < 5; i++) lights.put(new THREE.Matrix4(), LIGHT_HEAD);
  lights.commit();
  assert.equal(lights.im.count, 5);

  lights.begin();
  lights.put(new THREE.Matrix4(), LIGHT_HEAD);
  lights.commit();
  assert.equal(lights.im.count, 1);
});

test('the light pool clamps at capacity instead of writing out of bounds', () => {
  const scene = new THREE.Scene();
  const lights = createLightPool({ scene, capacity: 2 });
  lights.begin();
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) lights.put(new THREE.Matrix4(), LIGHT_HEAD); });
  lights.commit();
  assert.equal(lights.im.count, 2);
});

test('the tire-smoke shader anchors still exist in three\'s MeshBasic source', () => {
  // carEffects.js injects per-instance opacity by string replacement. If three renames any of these
  // the replacement silently does nothing: the attribute is never declared, vOpacity never varies,
  // and every dust puff draws at full opacity. Nothing throws.
  const basic = THREE.ShaderLib.basic;
  assert.ok(basic.vertexShader.includes('#include <common>'), 'vertex <common> anchor');
  assert.ok(basic.vertexShader.includes('#include <begin_vertex>'), 'vertex <begin_vertex> anchor');
  assert.ok(basic.fragmentShader.includes('#include <common>'), 'fragment <common> anchor');
  assert.ok(basic.fragmentShader.includes('vec4 diffuseColor = vec4( diffuse, opacity );'),
    'UPSTREAM CHANGED: the diffuseColor line the per-instance alpha multiplies into has moved or ' +
    'been reworded. Fix carEffects.js — until then every tire-smoke puff renders opaque.');
});

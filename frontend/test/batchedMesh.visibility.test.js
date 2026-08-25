/**
 * Pins the BatchedMesh trap that P2's LOD banding rests on.
 *
 * THE TRAP. `setGeometryIdAt` is the only instance mutator in BatchedMesh that does NOT set
 * `_visibilityChanged`. `onBeforeRender` early-returns when
 *
 *     !_visibilityChanged && !perObjectFrustumCulled && !sortObjects
 *
 * and that is exactly the configuration our pools run in (vegPools.js sets both flags false on
 * purpose — per-instance culling and sorting cost a matrix multiply per instance per frame and buy
 * nothing when our own distance LOD already hides far instances).
 *
 * So a discrete LOD band implemented as "swap the instance to the low-poly geometry" compiles,
 * runs, allocates nothing, throws nothing — and changes nothing on screen, because the multi-draw
 * buffers are never rebuilt. All three P2 audits rediscovered this independently, which is a good
 * sign that reading the code is not enough to avoid it.
 *
 * WHAT THIS FILE ASSERTS
 *   1. The upstream behaviour is what we think it is (test 1-3). If a three upgrade starts setting
 *      the flag, test 2 fails LOUDLY rather than silently making our workaround dead code.
 *   2. vegPools' current safety is real (test 4) — it is rescued by the setVisibleAt that follows,
 *      NOT by setGeometryIdAt itself. That rescue is incidental, so it is pinned here: reordering
 *      those two lines, or adding a path that swaps geometry without a visibility call, breaks it.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/** A pool configured the way ours are: both per-frame passes off. */
function makePool() {
  const bm = new THREE.BatchedMesh(4, 4096, 8192, new THREE.MeshBasicMaterial());
  bm.perObjectFrustumCulled = false;   // vegPools.js:45
  bm.sortObjects = false;              // vegPools.js:46
  const hi = bm.addGeometry(new THREE.BoxGeometry(1, 1, 1));
  const lo = bm.addGeometry(new THREE.PlaneGeometry(1, 1));
  const id = bm.addInstance(hi);
  bm._visibilityChanged = false;       // clear what construction set, to isolate the mutator
  return { bm, hi, lo, id };
}

test('the pool config is the one that triggers the early-return', () => {
  const { bm } = makePool();
  assert.equal(bm.perObjectFrustumCulled, false);
  assert.equal(bm.sortObjects, false);
  assert.equal(bm._visibilityChanged, false,
    'preconditions for the onBeforeRender early-return must hold, or this file tests nothing');
});

test('setGeometryIdAt does NOT set _visibilityChanged (the trap itself)', () => {
  const { bm, lo, id } = makePool();
  bm.setGeometryIdAt(id, lo);
  assert.equal(bm.getGeometryIdAt(id), lo, 'the swap itself must have happened');
  assert.equal(bm._visibilityChanged, false,
    'UPSTREAM CHANGED: three now sets _visibilityChanged in setGeometryIdAt. The manual flag-set ' +
    'in our pool code is no longer required — remove it and delete this assertion, but check every ' +
    'call site before assuming the workaround is harmless dead code.');
});

test('setVisibleAt DOES set it — this is what rescues vegPools', () => {
  const { bm, id } = makePool();
  bm.setVisibleAt(id, false);
  assert.equal(bm._visibilityChanged, true);
});

test('setVisibleAt is a NO-OP when visibility does not actually change', () => {
  // The sharp edge. setVisibleAt early-returns when the value is unchanged (BatchedMesh.js:1151),
  // so it sets the flag only on a real transition. "Call setVisibleAt afterwards" is therefore NOT
  // a reliable way to publish a geometry swap.
  const { bm, id } = makePool();
  bm.setVisibleAt(id, true);   // already visible
  assert.equal(bm._visibilityChanged, false);
});

test('vegPools recycle path IS safe — but only because the slot was hidden first', () => {
  // Mirrors vegPools.js: remove() hides the slot (:157) before pushing it to freeIds, so allocSlot's
  // setVisibleAt(id, true) (:74) is a REAL transition and does set the flag. Safe — but safe because
  // of the hide in a different function, not because of anything allocSlot does.
  const { bm, lo, id } = makePool();
  bm.setVisibleAt(id, false);          // remove(): hide before freeing
  bm._visibilityChanged = false;       // isolate the recycle
  bm.setGeometryIdAt(id, lo);          // allocSlot(): swap geometry
  bm.setVisibleAt(id, true);           // allocSlot(): show — false -> true, a real change
  assert.equal(bm._visibilityChanged, true);
});

test('P2 LOD BAND: swapping geometry on a VISIBLE instance publishes NOTHING', () => {
  // This is the P2 hazard, and it is worse than "remember to set the flag after setGeometryIdAt".
  // An LOD band swap keeps the instance visible and only changes its geometry, so BOTH calls are
  // silent: setGeometryIdAt never sets the flag, and setVisibleAt(id, true) on an already-visible
  // instance early-returns. The swap is real in _instanceInfo and never reaches the draw buffers.
  const { bm, lo, id } = makePool();
  bm.setGeometryIdAt(id, lo);
  bm.setVisibleAt(id, true);
  assert.equal(bm.getGeometryIdAt(id), lo, 'the swap happened in the data model...');
  assert.equal(bm._visibilityChanged, false, '...and was never published to the draw buffers');
});

test('setGeometryIdSafe publishes the swap', async () => {
  const { setGeometryIdSafe } = await import('../src/map/batchedMeshSafe.js');
  const { bm, lo, id } = makePool();
  setGeometryIdSafe(bm, id, lo);
  assert.equal(bm.getGeometryIdAt(id), lo);
  assert.equal(bm._visibilityChanged, true);
});

test('setGeometryIdSafe skips the flag when the geometry is unchanged', () => {
  // Setting _visibilityChanged forces onBeforeRender to walk every instance. Doing that on a
  // no-op swap would hand back the per-frame cost the early-return exists to avoid — at pool
  // sizes of 15k+ instances, on every LOD pass.
  return import('../src/map/batchedMeshSafe.js').then(({ setGeometryIdSafe }) => {
    const { bm, hi, id } = makePool();
    setGeometryIdSafe(bm, id, hi);   // already this geometry
    assert.equal(bm._visibilityChanged, false);
  });
});

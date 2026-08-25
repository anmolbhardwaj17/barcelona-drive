/**
 * The one correct way to swap a BatchedMesh instance's geometry.
 *
 * WHY A HELPER FOR ONE LINE. `setGeometryIdAt` is the only instance mutator in BatchedMesh that
 * does not set `_visibilityChanged`, and `onBeforeRender` early-returns when
 * `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects` — the exact configuration our
 * pools run in. So a discrete LOD band that swaps an instance to its low-poly geometry updates
 * `_instanceInfo` and never reaches the draw buffers. It throws nothing and looks like it works.
 *
 * The obvious workaround — "call setVisibleAt afterwards" — does NOT fix it. setVisibleAt
 * early-returns when the value is unchanged (BatchedMesh.js:1151), and an LOD band swap keeps the
 * instance visible by definition. Both calls are silent, and the band never fires. vegPools is safe
 * from this only because remove() hides a slot before freeing it, making allocSlot's setVisibleAt a
 * real transition — safety that lives in a different function and would not survive a refactor.
 *
 * See test/batchedMesh.visibility.test.js, which pins all of the above against a three upgrade.
 */

/**
 * Swap an instance's geometry AND publish it to the draw buffers.
 *
 * @param {import('three').BatchedMesh} bm
 * @param {number} instanceId
 * @param {number} geometryId
 * @returns {boolean} true if the geometry actually changed
 */
export function setGeometryIdSafe(bm, instanceId, geometryId) {
  // No-op guard is not micro-optimisation: setting the flag forces onBeforeRender to walk EVERY
  // instance that frame, which is the per-frame cost the early-return exists to avoid. At 15k+
  // instances per pool, publishing a swap that did not happen is a real regression.
  if (bm.getGeometryIdAt(instanceId) === geometryId) return false;
  bm.setGeometryIdAt(instanceId, geometryId);
  bm._visibilityChanged = true;
  return true;
}

/**
 * tileDisposal.js — the ONE rule for freeing a tile's GPU resources (task #39).
 *
 * ═══ WHY IT IS ITS OWN FILE ═════════════════════════════════════════════════════════════════════
 *
 * This logic has had three silent bugs, and it lived inside `tileManager.js`, which cannot be
 * imported outside Vite (it pulls in `./tileParserWorker.js?worker`). So it could only ever be
 * "tested" by regex-matching the source for a branch condition — which pins the shape of the code
 * rather than what it does, and duly broke the moment the code was refactored rather than when the
 * behaviour changed.
 *
 * It is one function with one import. Extracting it makes it a thing that can be exercised, which
 * is what a function with this history needs.
 */
import { isShared } from '../sharedMaterial.js';

/**
 * TASK #39 · ONE disposal rule, because two of them drifted.
 *
 * The unload path used to branch: a Group was `traverse`d and its `isMesh` children freed, anything
 * else went down a flat path. The flat path had learned three things the group path never did —
 *
 *   1. `isMesh` ALONE IS NOT ENOUGH. A LineSegments/Line/Points holds a geometry exactly like a Mesh
 *      and fails `isMesh`. That is the `streetlightWireMesh` leak, already fixed once on the flat
 *      path — and still live inside every Group (reflectorGroup, tunnelMeshGroup, canopyMeshGroup).
 *   2. `userData.sharedGeometry` must be honoured. The group path disposed unconditionally, which is
 *      the OPPOSITE defect: a pooled geometry freed out from under every other tile using it.
 *   3. InstancedMesh/BatchedMesh own instanceMatrix/instanceColor GPU buffers that
 *      `geometry.dispose()` does not free — **and the call that was supposed to free them was a
 *      silent no-op.** `instanceMatrix.dispose` DOES NOT EXIST on a BufferAttribute in three
 *      0.183; the code read `m.instanceMatrix?.dispose?.()`, and the optional CALL swallowed it.
 *      What actually frees those buffers is `InstancedMesh.dispose()`, which dispatches the
 *      'dispose' event the renderer listens for. Verified against the installed three.
 *
 * Nothing threw in any of those cases. So there is now one routine and both entry points call it;
 * `test/tileDisposal.test.js` pins that a Group and a bare object are treated identically.
 */
export function disposeOwnedResources(o, acct) {
  if (!o) return;
  // Sprites are deliberately absent: three shares ONE module-level geometry across every Sprite,
  // so disposing it through a tile unload would take out every sprite in the game.
  if (!(o.isMesh || o.isLine || o.isLineSegments || o.isPoints)) return;
  if (acct) acct.held++;
  if (o.userData?.sharedGeometry) { if (acct) acct.shared++; }
  else if (o.geometry) { o.geometry.dispose(); if (acct) acct.freed++; }
  // v3 P0-02: isShared() consults the MATERIAL, which always knows what it is; userData is kept
  // for back-compat with existing tags.
  if (!o.userData?.sharedMaterial && !isShared(o.material) && o.material) {
    if (Array.isArray(o.material)) o.material.forEach((mat) => { if (mat.map) mat.map.dispose(); mat.dispose(); });
    else { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  }
  // ⚠ NOT `o.instanceMatrix.dispose()` — that method does not exist, and `?.()` hid it. The object's
  // own dispose() is what dispatches the event the renderer frees these buffers on. Gated on
  // sharedGeometry so a pooled BatchedMesh that somehow reaches here is never torn down.
  if ((o.isInstancedMesh || o.isBatchedMesh) && !o.userData?.sharedGeometry) o.dispose?.();
}

/** Dispose an object and everything under it. `traverse` includes the root, so this covers both. */
export function disposeTileObject(root, acct) {
  if (!root) return;
  if (root.children?.length) root.traverse((c) => disposeOwnedResources(c, acct));
  else disposeOwnedResources(root, acct);
}

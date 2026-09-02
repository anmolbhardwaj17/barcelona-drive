/**
 * treeShadowProxies.js — cast tree shadows without putting trees in the shadow pass. v3 P-L2.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────────────────────────
 * The day frame at the Gran Via spawn has ZERO cast shadows. Not soft ones — none. Shadows are
 * enabled, the sun casts, buildings and cars cast; but the only things in frame on a plane-tree
 * avenue are trees, and every vegetation pool sets `castShadow = false`:
 *
 *     vegetationRenderer.js:706  "trees do NOT cast shadows — 150k+ trees in the shadow pass
 *                                 tanked FPS (33→)"
 *
 * That measurement is real but it does not support the rule it became. The shadow camera is ±85 m
 * with far 600 (`scene.js:747`), so only trees inside that box can contribute a texel. The 33 fps
 * came from handing the depth pass EVERY tree in the world, which happens because the BatchedMesh
 * pools set both `frustumCulled = false` and `perObjectFrustumCulled = false`. "All 150k trees are
 * unaffordable" was generalised into "trees cannot cast".
 *
 * ── WHY NOT JUST FLIP castShadow ON THE POOLS ─────────────────────────────────────────────────
 * Because the trees are CARDS. `treeCards.js` collapses each tree to 4 triangles that rotate to
 * face the camera, and a camera-facing billboard cannot cast a correct shadow: from the sun's point
 * of view it is edge-on or an arbitrary slice. You would trade no shadow for a wrong one.
 *
 * So the caster is a separate, invisible PROXY: a low-poly blob roughly the size of a real canopy,
 * standing where the tree is. The player never sees it; the sun does.
 *
 * ── HOW IT STAYS INVISIBLE (the part that is easy to get wrong) ───────────────────────────────
 * Two obvious mechanisms both FAIL, and both fail silently by removing the shadow as well:
 *
 *   - `object.layers` — three's shadow walk tests `object.layers.test( camera.layers )` against the
 *     MAIN camera (`WebGLShadowMap.renderObject`). An object parked on a layer the camera does not
 *     draw is skipped by the shadow pass too.
 *   - `material.visible = false` — the same walk gates the depth draw on `material.visible`.
 *
 * What works is writing nothing: `colorWrite = false` + `depthWrite = false`. The mesh is still
 * "visible" by both tests above, so it casts; it just contributes no pixels and no depth to the
 * colour pass. One extra instanced draw with a trivial fragment shader is the whole cost.
 *
 * ── BOUNDED BY CONSTRUCTION ───────────────────────────────────────────────────────────────────
 * The instance count is capped and the radius matches the shadow frustum, so this cannot regress
 * into the thing that was measured at 33 fps: trees beyond the frustum could not cast a texel even
 * if they were submitted. Rebuilt only when the camera has moved `REBUILD_STEP_M`.
 */
import * as THREE from 'three';

/** Matches the ±85 m shadow camera, plus margin for canopies straddling the edge. */
const RADIUS_M = 95;
/** Hard ceiling on submitted casters. 20 tris each → ≤10k triangles in a depth-only pass. */
const MAX_PROXIES = 512;
/** Rebuild only after the camera has moved this far — the set is stable at driving speed. */
const REBUILD_STEP_M = 10;
/** Plane-tree canopy: ~3.6 m radius centred ~6 m up. Deliberately a little SMALL — an oversized
 *  proxy reads as a dark slab on the road, which is the failure the canopy AO already had. */
const CANOPY_R = 3.6;
const CANOPY_H = 6.0;
/** Squashed vertically: a plane tree's canopy is wider than it is tall. */
const CANOPY_FLATTEN = 0.72;

let _mesh = null;
let _enabled = true;
let _lastX = Infinity, _lastZ = Infinity;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(CANOPY_R, CANOPY_R * CANOPY_FLATTEN, CANOPY_R);
const _p = new THREE.Vector3();

export const treeShadowStats = { proxies: 0, rebuilds: 0, considered: 0 };

/**
 * @param {THREE.Object3D} parent  worldGroup — proxies use the same local frame as the trees, so
 *                                 the X-mirror applies to them exactly as it does to the canopy.
 */
export function initTreeShadowProxies(parent, enabled = true) {
  _enabled = enabled;
  if (!enabled) return null;
  // Detail 0 icosahedron = 20 triangles. The shadow is soft (dirLight.shadow.radius = 6), so
  // silhouette detail beyond "roughly a blob" is thrown away by the filter anyway.
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshBasicMaterial();
  mat.colorWrite = false;   // ← draws no pixels …
  mat.depthWrite = false;   // ← and no depth, so it cannot occlude anything …
  mat.userData.sharedMaterial = true;
  _mesh = new THREE.InstancedMesh(geo, mat, MAX_PROXIES);
  _mesh.castShadow = true;  // … but still casts, because it is `visible` to both of three's tests.
  _mesh.receiveShadow = false;
  _mesh.frustumCulled = false;   // spans the shadow frustum; culling it by the CAMERA frustum would
                                 // drop shadows cast from just off-screen, which is most of them.
  _mesh.count = 0;
  _mesh.name = 'treeShadowProxies';
  parent.add(_mesh);
  return _mesh;
}

/**
 * @param {number} camX  camera X in the PARENT's local frame (worldGroup-local, same as tree data)
 * @param {number} camZ  camera Z, likewise
 * @param {() => Float32Array[]} getTreeArrays  returns per-tile [x, groundY, z] triples
 */
export function updateTreeShadowProxies(camX, camZ, getTreeArrays, force = false) {
  if (!_enabled || !_mesh) return;
  const dx = camX - _lastX, dz = camZ - _lastZ;
  if (!force && dx * dx + dz * dz < REBUILD_STEP_M * REBUILD_STEP_M) return;
  _lastX = camX; _lastZ = camZ;

  const r2 = RADIUS_M * RADIUS_M;
  let n = 0, considered = 0;
  const arrays = getTreeArrays() || [];
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      considered++;
      const tx = arr[i], ty = arr[i + 1], tz = arr[i + 2];
      const ex = tx - camX, ez = tz - camZ;
      if (ex * ex + ez * ez > r2) continue;
      _p.set(tx, ty + CANOPY_H, tz);
      _m.compose(_p, _q, _s);
      _mesh.setMatrixAt(n, _m);
      if (++n >= MAX_PROXIES) break;
    }
    if (n >= MAX_PROXIES) break;
  }
  _mesh.count = n;
  _mesh.instanceMatrix.needsUpdate = true;
  treeShadowStats.proxies = n;
  treeShadowStats.considered = considered;
  treeShadowStats.rebuilds++;
}

/** Force the next update to rebuild — call when the resident tile set changes. */
export function invalidateTreeShadowProxies() { _lastX = _lastZ = Infinity; }

export function disposeTreeShadowProxies() {
  if (!_mesh) return;
  _mesh.geometry.dispose();
  _mesh.material.dispose();
  _mesh.parent?.remove(_mesh);
  _mesh = null;
}

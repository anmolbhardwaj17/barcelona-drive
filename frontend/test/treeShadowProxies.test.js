/**
 * P-L2 tree shadow proxies.
 *
 * The day frame at the Gran Via spawn had ZERO cast shadows: shadows are enabled and the sun casts,
 * but on a plane-tree avenue the only candidate casters are trees, and every vegetation pool sets
 * castShadow = false. Trees render as camera-facing CARDS, so flipping that flag would produce a
 * wrong shadow rather than a missing one — hence invisible proxy blobs.
 *
 * These tests pin the two things that make the mechanism work at all, both of which are easy to
 * break silently because the symptom is identical to having no feature: no shadows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  initTreeShadowProxies, updateTreeShadowProxies, invalidateTreeShadowProxies,
  disposeTreeShadowProxies, treeShadowStats,
} from '../src/map/treeShadowProxies.js';

function freshParent() {
  disposeTreeShadowProxies();
  const parent = new THREE.Group();
  const mesh = initTreeShadowProxies(parent, true);
  return { parent, mesh };
}

/** n trees on a line running east from the origin, 5 m apart, ground at y=0. */
function treeLine(n, spacing = 5) {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = i * spacing; a[i * 3 + 1] = 0; a[i * 3 + 2] = 0; }
  return [a];
}

test('the caster writes no colour and no depth, but still casts', () => {
  const { mesh } = freshParent();
  // These three together ARE the feature. material.visible = false or a spare layer would each
  // remove the shadow as well — three's shadow walk gates on both (WebGLShadowMap.renderObject).
  assert.equal(mesh.material.colorWrite, false, 'must contribute no pixels');
  assert.equal(mesh.material.depthWrite, false, 'must not occlude anything');
  assert.equal(mesh.castShadow, true, 'but must still be handed to the depth pass');
  assert.equal(mesh.material.visible, true, 'material.visible=false would kill the shadow too');
  assert.equal(mesh.visible, true, 'object.visible=false returns early in the shadow walk');
  disposeTreeShadowProxies();
});

test('only trees within the shadow frustum are submitted', () => {
  freshParent();
  // 200 trees at 5 m spacing spans 995 m; the shadow camera is ±85 m, radius 95 m.
  updateTreeShadowProxies(0, 0, () => treeLine(200), true);
  assert.equal(treeShadowStats.considered, 200, 'every tree is scanned');
  // Trees at x = 0..95 inclusive → 20 of them.
  assert.equal(treeShadowStats.proxies, 20, 'but only the ones that could cast a texel are sent');
  disposeTreeShadowProxies();
});

test('the instance count is hard-capped, so it cannot regress into the 33fps measurement', () => {
  freshParent();
  // 4000 trees packed inside the radius — every one qualifies on distance.
  const dense = new Float32Array(4000 * 3);
  for (let i = 0; i < 4000; i++) { dense[i * 3] = (i % 40) - 20; dense[i * 3 + 2] = Math.floor(i / 40) - 50; }
  updateTreeShadowProxies(0, 0, () => [dense], true);
  assert.ok(treeShadowStats.proxies <= 512, `capped, got ${treeShadowStats.proxies}`);
  disposeTreeShadowProxies();
});

test('a small camera move does not rebuild; a large one does', () => {
  freshParent();
  updateTreeShadowProxies(0, 0, () => treeLine(50), true);
  const after = treeShadowStats.rebuilds;
  updateTreeShadowProxies(2, 0, () => treeLine(50));       // 2 m — under REBUILD_STEP_M
  assert.equal(treeShadowStats.rebuilds, after, 'no rebuild for a 2 m move');
  updateTreeShadowProxies(40, 0, () => treeLine(50));      // 40 m — over it
  assert.equal(treeShadowStats.rebuilds, after + 1, 'rebuilt after a 40 m move');
  disposeTreeShadowProxies();
});

test('a tile streaming in forces a rebuild even if the camera has not moved', () => {
  freshParent();
  updateTreeShadowProxies(0, 0, () => treeLine(50), true);
  const after = treeShadowStats.rebuilds;
  updateTreeShadowProxies(0, 0, () => treeLine(50));        // stationary → nothing
  assert.equal(treeShadowStats.rebuilds, after);
  invalidateTreeShadowProxies();
  updateTreeShadowProxies(0, 0, () => treeLine(50));        // invalidated → rebuilds in place
  assert.equal(treeShadowStats.rebuilds, after + 1);
  disposeTreeShadowProxies();
});

test('proxies sit above the stored ground Y, not at it', () => {
  const { mesh } = freshParent();
  const one = new Float32Array([0, 12.5, 0]);   // one tree, ground at y = 12.5
  updateTreeShadowProxies(0, 0, () => [one], true);
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(pos.y > 12.5, 'a canopy that sits ON the ground casts no shadow across a road');
  assert.ok(pos.y < 12.5 + 15, 'nor should it float');
  disposeTreeShadowProxies();
});

test('disabled means no mesh at all, not an empty one', () => {
  disposeTreeShadowProxies();
  const parent = new THREE.Group();
  assert.equal(initTreeShadowProxies(parent, false), null);
  assert.equal(parent.children.length, 0, '?treeshadows=0 adds nothing to the scene');
});

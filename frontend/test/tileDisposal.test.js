/**
 * Tile disposal. Every failure here is silent — nothing throws when you skip freeing a geometry,
 * and the only symptom is a heap that drifts up over a long drive.
 *
 * Measured 2026-08-27 before the fix: geometries climbed ~6/s at a CONSTANT resident tile count
 * (+79 over 18 s at 12 tiles, +98 over 24 s at 15, +76 over 12 s at 20), heap +2.01 MB/s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { disposeTileObject } from '../src/map/tileDisposal.js';

const SRC = fs.readFileSync('src/map/tileManager.js', 'utf8');
const DISPOSAL = SRC.slice(SRC.indexOf('const allMeshes = []'), SRC.indexOf('_pendingDisposals.push'));

test('every mesh-ish tile-entry field is disposed, aliased, or pool-managed', () => {
  const assigned = [...SRC.matchAll(/entry\.(\w*(?:Mesh|Meshes|Group|Handles))\s*=/g)].map((m) => m[1]);
  // Fields that legitimately do NOT appear in the disposal block, each with the reason it is safe.
  // Anything NOT on this list and NOT in the block is a leak.
  const exempt = {
    laneArrowMesh: 'alias into entry.roadInfraMeshes, which IS disposed',
    markingsMesh: 'alias into roadMeshes, which IS disposed',
    metalRailingMesh: 'alias into roadMeshes, which IS disposed — held for the post drawRange LOD',
    vegPoolHandles: 'released via h.pool.remove(h) — pool slots, not owned geometry',
  };
  const leaks = [...new Set(assigned)].filter((f) => !DISPOSAL.includes(`entry.${f}`) && !exempt[f]);
  assert.deepEqual(leaks, [],
    `these are assigned to a tile entry and never freed — add them to the disposal block, or to the ` +
    `exempt map with the reason they are safe`);
});

// ── The disposal rule itself, EXERCISED rather than regex-matched ───────────────────────────────
//
// This block used to assert that `tileManager.js` contained the literal text
// `m.isMesh || m.isLine || m.isLineSegments || m.isPoints`. That pins the SHAPE OF THE CODE, not
// what it does: it passed while a Group's children were still being walked by an isMesh-only
// branch, and it failed the moment the two branches were merged into one correct routine. The
// logic now lives in `map/tileDisposal.js` — one function, one import, importable outside Vite —
// so these tests run it.

/** A tracked geometry that records its own disposal. */
function geo() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  g.userData.disposed = false;
  g.addEventListener('dispose', () => { g.userData.disposed = true; });
  return g;
}
const mat = () => new THREE.MeshBasicMaterial();

test('a bare Mesh is freed', () => {
  const g = geo();
  disposeTileObject(new THREE.Mesh(g, mat()));
  assert.equal(g.userData.disposed, true);
});

test('LineSegments, Line and Points are freed — they hold geometry and fail isMesh', () => {
  // streetlightWireMesh is a LineSegments. This is the leak that was found and fixed once already,
  // on ONE of the two branches.
  for (const Kind of [THREE.LineSegments, THREE.Line, THREE.Points]) {
    const g = geo();
    disposeTileObject(new Kind(g, mat()));
    assert.equal(g.userData.disposed, true, `${Kind.name} must be freed`);
  }
});

test('THE REGRESSION: geometry inside a GROUP is freed the same as a bare one', () => {
  // reflectorGroup, tunnelMeshGroup and canopyMeshGroup are all Groups. The group branch walked
  // only `child.isMesh`, so every LineSegments inside one was freed by nobody — the exact bug that
  // had already been fixed on the flat path, still live one level down.
  const gm = geo(), gl = geo();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(gm, mat()));
  group.add(new THREE.LineSegments(gl, mat()));
  disposeTileObject(group);
  assert.equal(gm.userData.disposed, true, 'Mesh in a group');
  assert.equal(gl.userData.disposed, true, 'LineSegments in a group — the leak');
});

test('nested groups are reached', () => {
  const g = geo();
  const inner = new THREE.Group(); inner.add(new THREE.LineSegments(g, mat()));
  const outer = new THREE.Group(); outer.add(inner);
  disposeTileObject(outer);
  assert.equal(g.userData.disposed, true);
});

test('SHARED geometry is never freed — including inside a group', () => {
  // The opposite defect, and the group branch had it: disposing unconditionally frees a pooled
  // geometry out from under every other tile still using it.
  const g = geo();
  const m = new THREE.Mesh(g, mat());
  m.userData.sharedGeometry = true;
  const group = new THREE.Group(); group.add(m);
  disposeTileObject(group);
  assert.equal(g.userData.disposed, false, 'a shared geometry must survive a tile unload');
});

test('a Mesh that itself has children is freed, and so are the children', () => {
  // `traverse` includes the root, so a Mesh-with-children must not fall down the group path and
  // lose its own geometry.
  const gRoot = geo(), gChild = geo();
  const root = new THREE.Mesh(gRoot, mat());
  root.add(new THREE.Mesh(gChild, mat()));
  disposeTileObject(root);
  assert.equal(gRoot.userData.disposed, true, 'the root Mesh itself');
  assert.equal(gChild.userData.disposed, true, 'and its child');
});

test('an InstancedMesh is disposed, which is what frees its instance buffers', () => {
  // ⚠ The old code called `m.instanceMatrix?.dispose?.()`. `dispose` DOES NOT EXIST on a
  // BufferAttribute in three 0.183, and the optional CALL swallowed that — so the line that existed
  // to free these buffers had never freed anything. What works is the object's own dispose(),
  // which dispatches the event the renderer releases them on.
  const im = new THREE.InstancedMesh(geo(), mat(), 2);
  let disposed = false;
  im.addEventListener('dispose', () => { disposed = true; });
  const group = new THREE.Group(); group.add(im);
  disposeTileObject(group);   // through the GROUP path, which used to skip this entirely
  assert.equal(disposed, true, 'InstancedMesh.dispose() must be called');
});

test('the no-op that hid for so long stays named', () => {
  // If a three upgrade ever adds BufferAttribute.dispose, this fails and the comment above can be
  // simplified. Until then it is the evidence that the old call could not have worked.
  const im = new THREE.InstancedMesh(new THREE.BufferGeometry(), mat(), 1);
  assert.equal(typeof im.instanceMatrix.dispose, 'undefined',
    'UPSTREAM CHANGED: BufferAttribute now has dispose() — re-read tileDisposal.js note 3');
});

test('a POOLED instanced mesh is never torn down by a tile unload', () => {
  const im = new THREE.InstancedMesh(geo(), mat(), 2);
  im.userData.sharedGeometry = true;
  let disposed = false;
  im.addEventListener('dispose', () => { disposed = true; });
  disposeTileObject(im);
  assert.equal(disposed, false, 'the veg/car pools outlive every tile');
});

test('a Sprite is left alone — three shares ONE geometry across every sprite', () => {
  // Disposing it through a tile unload would take out every sprite in the game.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  let disposed = false;
  sprite.geometry.addEventListener('dispose', () => { disposed = true; });
  disposeTileObject(sprite);
  assert.equal(disposed, false);
});

test('the accounting counts what it held, freed and skipped', () => {
  // `?debug=leak` reads these. If they are wrong the probe lies about where the leak is.
  const acct = { held: 0, freed: 0, shared: 0 };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo(), mat()));
  group.add(new THREE.LineSegments(geo(), mat()));
  const shared = new THREE.Mesh(geo(), mat());
  shared.userData.sharedGeometry = true;
  group.add(shared);
  group.add(new THREE.Object3D());   // holds no geometry — must not be counted
  disposeTileObject(group, acct);
  assert.deepEqual(acct, { held: 3, freed: 2, shared: 1 });
});

test('null, undefined and a bare Object3D are no-ops, not throws', () => {
  for (const x of [null, undefined, new THREE.Object3D(), {}]) {
    assert.doesNotThrow(() => disposeTileObject(x));
  }
});

test('the streetlight wire mesh is disposed', () => {
  assert.match(DISPOSAL, /entry\.streetlightWireMesh/,
    'per-tile LineSegments from streetlightRenderer — the measured leak');
});

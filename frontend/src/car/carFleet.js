/**
 * carFleet.js — the ONE draw call every city car in the world renders through (v3 P4-15a).
 *
 * ── WHAT THIS REPLACED ────────────────────────────────────────────────────────────────────────
 * Traffic drew 28 loose `THREE.Mesh`es, one per NPC car, each added to and removed from `scene`
 * as it spawned and despawned (≈2 allocations + 2 scene-graph splices EVERY frame at cruise).
 * Parked cars drew 9 InstancedMeshes, one per variant. Each system then carried its own pair of
 * head/tail light InstancedMeshes. That is 41 draws, 37 scene children, and a per-frame
 * `projectObject` walk over all of them — for two systems drawing the SAME nine models out of the
 * SAME atlas.
 *
 * Now: ONE BatchedMesh holds all nine geometries and every car in the world, traffic and parked
 * alike, and each system keeps ONE light InstancedMesh (head and tail told apart by instance
 * colour, not by being separate meshes). 41 draws → 3.
 *
 * ── WHY BatchedMesh AND NOT nine InstancedMeshes ──────────────────────────────────────────────
 * An InstancedMesh is one geometry. Nine variants means nine meshes, and two systems sharing them
 * means agreeing on which slice of each instance buffer belongs to whom — an offset that shifts
 * every time parked cars rebuild, one frame out of step with traffic's per-frame write. BatchedMesh
 * gives each instance its own geometry id, so a slot is just a slot: no blocks, no offsets, no
 * ordering requirement between the two systems' update calls.
 *
 * ── THE RULES THIS POOL FOLLOWS (same as vegPools.js — see H3) ─────────────────────────────────
 * · NEVER `setInstanceCount` to grow: it reallocates and re-uploads every data texture.
 * · NEVER `deleteInstance`: one id in BatchedMesh's freed list makes every later `addInstance`
 *   sort that whole list. Slots are allocated once and recycled by us, hidden with setVisibleAt.
 * · Swap an instance's geometry through `setGeometryIdSafe`, never `setGeometryIdAt` —
 *   see batchedMeshSafe.js and test/batchedMesh.visibility.test.js.
 *
 * ── PER-INSTANCE FRUSTUM CULLING IS ON HERE (and off in vegPools) ─────────────────────────────
 * vegPools turns it off because it pays a matrix multiply and a sphere test per instance per frame
 * against 15k+ instances, and its own distance LOD already hides the far ones. This pool holds a
 * few hundred, and has no distance LOD: parked cars are placed in a 200 m RADIUS around the player
 * while the camera sees roughly a third of that. At ~2,200 triangles a car, culling the two-thirds
 * behind the camera is worth far more than the walk costs.
 */
import * as THREE from 'three';
import { setGeometryIdSafe } from '../map/batchedMeshSafe.js';
import { loadCityCarTemplates, CANON_LENGTH, CAR_KIT_PATH } from './carModels.js';

/**
 * Total car slots across ALL consumers (parked + traffic + anything later).
 *
 * Fixed, because growing is the expensive operation (H3). Parked cars are the only consumer that
 * can approach it: at SPACING 17.5 m on both curbs within a 200 m radius, dense Eixample places
 * ~150-250, against its own CAPACITY of 512. Slots are allocated LAZILY, so this ceiling costs only
 * the data-texture size — the per-frame cull walk is over slots actually handed out, not the ceiling.
 */
const FLEET_CAPACITY = 640;   // parked 512 + traffic 28 + headroom

let _poolPromise = null;

/**
 * The shared car pool. Idempotent: every consumer gets the same pool, and the templates behind it
 * are parsed once (carModels.js caches them).
 *
 * @returns {Promise<object|null>} null if no car model could be loaded at all.
 */
export function getCarPool(scene) {
  if (_poolPromise) return _poolPromise;
  _poolPromise = loadCityCarTemplates(CAR_KIT_PATH, CANON_LENGTH)
    .then((templates) => (templates.length ? createCarPool(scene, templates) : null))
    .catch((e) => { console.warn('[carFleet] car models load failed:', e?.message || e); return null; });
  return _poolPromise;
}

/**
 * Build the pool from already-loaded templates. Exported so tests can drive it without a GLB
 * loader; production code goes through getCarPool(), which is the single shared instance.
 */
export function createCarPool(scene, templates) {
  let totalVerts = 0, totalIndices = 0;
  for (const t of templates) {
    totalVerts += t.geometry.getAttribute('position').count;
    totalIndices += t.geometry.getIndex() ? t.geometry.getIndex().count : 0;
  }
  const bm = new THREE.BatchedMesh(FLEET_CAPACITY, totalVerts, totalIndices, templates[0].material);
  const geoIds = templates.map((t) => bm.addGeometry(t.geometry));
  bm.frustumCulled = false;          // the pool spans the whole loaded area — never cull the container
  bm.perObjectFrustumCulled = true;  // see the header: a few hundred instances, ~2,200 tris each
  bm.sortObjects = false;            // opaque cars; depth sorting buys nothing and costs a sort per frame
  bm.castShadow = false;             // grounded by contact-shadow blobs, like the meshes this replaced
  bm.receiveShadow = false;
  bm.userData = { sharedGeometry: true, sharedMaterial: true, isCarFleet: true };
  scene.add(bm);

  let allocated = 0;
  // OUR free list, never BatchedMesh's — see the header. Recycling through this keeps
  // bm._availableInstanceIds empty, which is what stops addInstance from sorting.
  const freeIds = [];

  return {
    bm,
    templates,
    variantCount: templates.length,

    /** A slot, hidden. Returns -1 when the fleet is full (the caller must cope, not throw). */
    alloc() {
      if (freeIds.length) { const id = freeIds.pop(); bm.setVisibleAt(id, false); return id; }
      if (allocated >= FLEET_CAPACITY) return -1;
      allocated++;
      const id = bm.addInstance(geoIds[0]);
      bm.setVisibleAt(id, false);
      return id;
    },

    /**
     * Give a slot back for good (a whole system shutting down — NOT a car despawning, which just
     * hides). Goes on our own list; `deleteInstance` is never called.
     */
    release(id) {
      if (id < 0) return;
      bm.setVisibleAt(id, false);
      freeIds.push(id);
    },

    /** Show slot `id` as variant `v` at `matrix`. */
    place(id, v, matrix) {
      if (id < 0) return;
      setGeometryIdSafe(bm, id, geoIds[v % geoIds.length]);
      bm.setMatrixAt(id, matrix);
      bm.setVisibleAt(id, true);
    },

    hide(id) { if (id >= 0) bm.setVisibleAt(id, false); },

    /** Slots handed out so far — the upper bound of the per-frame cull walk. */
    allocatedCount() { return allocated; },

    /**
     * Cars currently drawn. Reads BatchedMesh's own multi-draw count, so it answers "what is on
     * screen", not "what is in the pool" — the distinction that matters when someone reports
     * missing cars.
     */
    drawnCount() { return bm._multiDrawCount ?? 0; },
  };
}

/**
 * Head+tail lights for one car system, as ONE InstancedMesh.
 *
 * Head and tail used to be two meshes because they were two materials. They differ only in colour,
 * and an instance can carry its own colour — so they are one mesh whose material is white and
 * whose instances are tinted. Emissive-basic, so bloom picks them up at night.
 *
 * Usage is strictly begin() → put()×n → commit(); the buffer is rewritten wholesale, never patched.
 */
export const LIGHT_HEAD = 0xfff4d8;
export const LIGHT_TAIL = 0xff2a12;

export function createLightPool({ scene, capacity, width = 0.28, height = 0.14 }) {
  const geo = new THREE.PlaneGeometry(width, height);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: true });
  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  im.castShadow = false;
  im.count = 0;
  // Allocating instanceColor up front (rather than letting the first setColorAt do it) keeps the
  // material's program cache key stable: USE_INSTANCING_COLOR appearing later is a recompile.
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(im);

  let n = 0;
  const _c = new THREE.Color();

  return {
    im,
    begin() { n = 0; },
    put(matrix, colorHex) {
      if (n >= capacity) return;
      im.setMatrixAt(n, matrix);
      im.setColorAt(n, _c.setHex(colorHex));
      n++;
    },
    commit() {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
    },
    setVisible(on) { im.visible = on; if (!on) { im.count = 0; n = 0; } },
    dispose() { scene.remove(im); geo.dispose(); mat.dispose(); im.dispose(); },
  };
}

/**
 * The four light-quad transforms of one car variant, relative to its wheel-base centre.
 *
 * Offsets are in TARGET units (`dims` already is), so a caller must compose these against the
 * car's position and rotation ONLY — never against the car's instance matrix, which also carries
 * the CANON_LENGTH→target scale and would apply it twice, shrinking the quads as well as the
 * offsets. This is why the two matrices are built separately in every consumer.
 */
export function makeLightLocals(dims) {
  const w = dims.w, h = dims.h, l = dims.l, y = h * 0.42;
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const mk = (x, z, ry) => {
    const m = new THREE.Matrix4();
    q.setFromAxisAngle(yAxis, ry);
    m.compose(new THREE.Vector3(x, y, z), q, one);
    return m;
  };
  return {
    head: [mk(-w * 0.30, l * 0.49, 0), mk(w * 0.30, l * 0.49, 0)],
    tail: [mk(-w * 0.30, -l * 0.49, Math.PI), mk(w * 0.30, -l * 0.49, Math.PI)],
  };
}

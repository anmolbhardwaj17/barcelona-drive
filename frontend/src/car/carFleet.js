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
import { CONFIG } from '../config.js';   // DEBUG_INIT gates the boot chatter below
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

  const _bodyColor = new THREE.Color();
  // ── ONE-SHOT COLOUR CENSUS (V-7) ───────────────────────────────────────────────────────────
  // "i still see only red and black cars", against a palette that hashes to 9 distinct colours in
  // an offline test and a setColorAt path that reads correct. Three rounds of reasoning have not
  // settled it, so the code reports on itself instead — the same move as the pillar and embankment
  // counters. Fires ONCE, ~6 s in, and says whether colours were applied at all and how they
  // actually landed. If `applied` is 0 the tint never ran; if it is high and `distinct` is 2, the
  // palette or the seed is collapsing.
  const _colorCensus = new Map();
  let _colorApplied = 0, _censusDone = false;
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      if (_censusDone) return;
      _censusDone = true;
      const rows = [...
        _colorCensus.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `#${k.toString(16).padStart(6, '0')}x${v}`).join(' ');
      if (CONFIG.DEBUG_INIT) console.warn(`[carFleet] colour census — setColorAt applied ${_colorApplied} times, `
        + `${_colorCensus.size} distinct: ${rows || '(none)'}`);
    }, 6000);
  }
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

    /**
     * Show slot `id` as variant `v` at `matrix`, optionally in body colour `colorHex`.
     *
     * ── WHY COLOUR ARRIVED LATE (V-5) ────────────────────────────────────────────────────────
     * The kit cars never needed it: each variant's UVs point at a different swatch of the shared
     * atlas, so their colour is baked into the geometry and every instance of a variant is the same
     * car in the same paint. An AUTHORED model has its UVs pinned to a white texel (see V-4 in
     * carModels.js), so it has no baked colour at all — without this it is a fleet of identical
     * white hatchbacks.
     *
     * Per-instance, so it costs no extra draw: BatchedMesh carries an instance colour exactly as
     * InstancedMesh does. Only the BODY takes it — glass, lamps, rubber, chrome and cabin are
     * assigned in the aPart shader branch and never multiplied by the tint, which is what stops a
     * red car having red windows.
     */
    place(id, v, matrix, colorHex) {
      if (id < 0) return;
      setGeometryIdSafe(bm, id, geoIds[v % geoIds.length]);
      bm.setMatrixAt(id, matrix);
      if (colorHex !== undefined && bm.setColorAt) {
        bm.setColorAt(id, _bodyColor.setHex(colorHex));
        _colorApplied++;
        _colorCensus.set(colorHex, (_colorCensus.get(colorHex) || 0) + 1);
      }
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
// ── BARCELONA BODY COLOURS (V-5, rebalanced V-11) ─────────────────────────────────────────────
// Authored cars have their UVs pinned to a white texel, so without a per-instance tint the fleet is
// a row of identical white hatchbacks.
//
// ⚠ THE FIRST PALETTE LOOKED FINE AND DISTRIBUTED TERRIBLY. The colour census reported
// `#e8e8e6 x464 … #2f4f7a x4` — 464 white cars against FOUR navy, out of 2,315. That is not a
// weighting decision, it is a broken hash: `(xorshift >>> 8) & 0xffff` correlates badly with the
// position-derived seeds parked cars use (`px * 7.31 + pz * 13.17` on a kerb grid), so whole
// indices were starved. User: "i see alot of white cars can we have more variety".
//
// Now a full 32-bit avalanche (the MurmurHash3 finalizer), which decorrelates neighbouring seeds
// properly, plus white cut from three entries to two. Weighted to what actually parks in Barcelona
// — pale and neutral dominant, saturated colours present but a minority — because a street of
// primary-coloured cars reads as a toy set, which is the impression this whole thread exists to
// remove.
export const BODY_COLORS = [
  0xe8e8e6, 0xdedcd8,             // whites (two shades, not one flat white)
  0xc6c9cc, 0xb4b8bc,             // silvers
  0x9aa0a6, 0x6e747a, 0x4a4f55,   // greys, light to dark
  0x2b2f33, 0x1f2226,             // blacks
  0x2f4f7a, 0x4a6fa5,             // navy, mid blue
  0xb23a30, 0x7c2b28,             // red, burgundy
  0x30594a,                       // dark green
  0x7a6a52, 0x8a6a3a,             // beige, bronze
];

/**
 * Deterministic pick — a car must keep its colour across despawn/respawn, not flicker per frame.
 *
 * MurmurHash3's finalizer rather than a plain xorshift: it avalanches every input bit across the
 * whole word, so seeds that differ by a small amount (adjacent kerb slots, consecutive spawns) land
 * far apart in the output. The previous shift-and-mask left that correlation intact.
 */
export function bodyColorFor(seed) {
  let h = (seed | 0) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  // ⚠ `>>> 0` after the final XOR, not before. In JS `^=` yields a SIGNED int32, so without this
  // the last step can go negative and `% length` returns a NEGATIVE index — BODY_COLORS[-3] is
  // undefined, and the car renders with no colour at all. Caught by running the distribution
  // offline before shipping it.
  h = (h ^ (h >>> 16)) >>> 0;
  return BODY_COLORS[h % BODY_COLORS.length];
}

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

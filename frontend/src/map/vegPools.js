/**
 * vegPools.js — GLOBAL vegetation instance pools.
 *
 * One THREE.BatchedMesh per vegetation kind (solid trees / blob shadows / bushes) shared by ALL
 * tiles, instead of one mesh per kind per tile. Tiles add their instances into the pool on build
 * and release them on unload; per-tile LOD count-fading works through handles (each handle keeps
 * its instance ids sorted nearest-to-tile-centre-first, so reducing the visible count always drops
 * the farthest trees — same semantics the per-tile meshes had via mesh.count).
 *
 * Why: with per-tile meshes, ~25 resident tiles × (1 tree + 1 shadow + 1 bush [+ zone dupes]) was
 * ~75–100 scene objects/draw calls. The pools collapse that to 3 objects total.
 *
 * Capacity auto-grows (setInstanceCount preserves live instances); freed ids are reused by
 * BatchedMesh itself, so long sessions don't fragment or leak.
 */

import * as THREE from 'three';

const YIELD_EVERY = 600; // instances between cooperative yields on the streaming path

/**
 * @param {object} opts
 * @param {string} opts.name                  pool tag (debug / userData)
 * @param {THREE.BufferGeometry[]} opts.geometries  one entry per geoIndex used by add()
 * @param {THREE.Material} opts.material      shared material (never disposed by tiles)
 * @param {number} [opts.capacity]            initial max instances (auto-grows)
 * @param {boolean} [opts.castShadow]
 * @param {boolean} [opts.receiveShadow]
 * @param {number} [opts.renderOrder]
 */
export function createVegPool({ name, geometries, material, capacity = 4096, castShadow = false, receiveShadow = true, renderOrder = 0 }) {
  let totalVerts = 0, totalIndices = 0;
  for (const g of geometries) {
    totalVerts += g.getAttribute('position').count;
    totalIndices += g.getIndex() ? g.getIndex().count : 0;
  }
  const bm = new THREE.BatchedMesh(capacity, totalVerts, totalIndices, material);
  const geoIds = geometries.map((g) => bm.addGeometry(g));
  // The pool spans the whole loaded area — never cull the container.
  bm.frustumCulled = false;
  // CRITICAL: BatchedMesh defaults to per-instance frustum culling + depth sorting on the CPU —
  // that's a matrix multiply and sphere test PER INSTANCE PER FRAME (~15k+ instances per pool),
  // which tanked the frame rate the moment the pools went in. Our own distance LOD already
  // hides far instances via setVisibleAt, so both per-frame passes buy nothing here.
  bm.perObjectFrustumCulled = false;
  bm.sortObjects = false;
  bm.castShadow = castShadow;
  bm.receiveShadow = receiveShadow;
  bm.renderOrder = renderOrder;
  bm.userData = { sharedGeometry: true, sharedMaterial: true, isVegPool: name };

  // ── Slot allocation is OURS, not BatchedMesh's ──────────────────────────────
  // NEVER call bm.deleteInstance(): once any ids sit in BatchedMesh's internal freed list, EVERY
  // subsequent addInstance() sorts that whole list (O(n log n) per instance!). With thousands of
  // instances freed by unloaded tiles and thousands added per new tile, that compounds into
  // multi-second streaming stalls that get worse the longer you drive. Instead we keep freed slots
  // in our own LIFO stack, hide them with setVisibleAt(false), and recycle them via
  // setGeometryIdAt() — BatchedMesh's freed list stays empty, so addInstance() never sorts.
  const freeIds = [];
  let slotsAllocated = 0;   // ids ever created via bm.addInstance (monotonic)
  let reserved = 0;         // slots promised to in-flight add() calls (capacity check → allocation
                            // spans awaits, so concurrent adds must see each other's reservations —
                            // without this, interleaved tiles overshot maxInstanceCount:
                            // "THREE.BatchedMesh: Maximum item count reached" killed a tile's veg)

  function freeSlots() {
    return (bm.maxInstanceCount - slotsAllocated) + freeIds.length - reserved;
  }

  function allocSlot(geoId) {
    if (freeIds.length > 0) {
      const id = freeIds.pop();
      bm.setGeometryIdAt(id, geoId);
      bm.setVisibleAt(id, true);
      return id;
    }
    slotsAllocated++;
    return bm.addInstance(geoId);
  }

  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();

  /**
   * Add one tile's instances. Never call concurrently for the same pool from two async chains
   * without awaiting (tile builds are sequential per tile; cross-tile interleave via yieldFn is
   * fine — BatchedMesh add/set calls are synchronous).
   *
   * @param {Array<{geoIndex:number, count:number, matrices:Float32Array, colors?:Float32Array}>} groups
   * @param {() => Promise<void>} [yieldFn]
   * @param {boolean} [startVisible] false → instances added hidden (e.g. billboards, which only
   *   show in their distance band once the LOD pass runs — default-visible would double-draw
   *   over the 3D trees until the viewer moves).
   * @returns {Promise<{ids:Int32Array, count:number, visCount:number, dead:boolean, pool:object}|null>} handle
   */
  async function add(groups, yieldFn, startVisible = true) {
    let total = 0;
    for (const g of groups) total += g.count;
    if (total === 0) return null;
    // Capacity is FIXED — the pool-set spawns an overflow sibling instead of growing this pool
    // (setInstanceCount reallocates + re-uploads all data textures = the 60-110ms stalls; and
    // capacities past 16384 push the matrices texture from 1 MB to 4 MB per streaming upload).
    if (freeSlots() < total) return undefined;   // caller (pool set) routes to/creates another pool
    reserved += total;                            // hold our slots across the yields below

    const ids = new Int32Array(total);
    const xs = new Float32Array(total);
    const zs = new Float32Array(total);
    let di = 0;

    try {
      for (const g of groups) {
        const geoId = geoIds[g.geoIndex];
        const matrices = g.matrices instanceof Float32Array ? g.matrices : new Float32Array(g.matrices);
        const colors = g.colors ? (g.colors instanceof Float32Array ? g.colors : new Float32Array(g.colors)) : null;
        for (let i = 0; i < g.count; i++) {
          const off = i * 16;
          _m.fromArray(matrices, off);
          const id = allocSlot(geoId);
          bm.setMatrixAt(id, _m);
          if (colors) { _c.fromArray(colors, i * 3); bm.setColorAt(id, _c); }
          ids[di] = id; xs[di] = matrices[off + 12]; zs[di] = matrices[off + 14]; di++;
          if (yieldFn && (di % YIELD_EVERY) === 0) await yieldFn();
        }
      }
    } finally {
      reserved -= total;
    }

    // Sort ids nearest-to-centroid-first so visible-count reduction culls the farthest instances.
    let cx = 0, cz = 0;
    for (let i = 0; i < di; i++) { cx += xs[i]; cz += zs[i]; }
    cx /= (di || 1); cz /= (di || 1);
    const order = new Int32Array(di);
    for (let i = 0; i < di; i++) order[i] = i;
    order.sort((a, b) => ((xs[a] - cx) ** 2 + (zs[a] - cz) ** 2) - ((xs[b] - cx) ** 2 + (zs[b] - cz) ** 2));
    const sortedIds = new Int32Array(di);
    const sortedXs = new Float32Array(di);
    const sortedZs = new Float32Array(di);
    for (let i = 0; i < di; i++) {
      sortedIds[i] = ids[order[i]];
      sortedXs[i] = xs[order[i]];
      sortedZs[i] = zs[order[i]];
    }

    if (!startVisible) { for (let i = 0; i < di; i++) bm.setVisibleAt(sortedIds[i], false); }
    // rawIds = ADDITION-ORDER ids (pre-sort) — for callers that must address "the i-th instance I
    // added" (e.g. bridge-pole night colour cycling). `ids` stays nearest-first for LOD fading.
    return { ids: sortedIds, rawIds: ids, xs: sortedXs, zs: sortedZs, count: di, visCount: startVisible ? di : 0, dead: false, pool: api };
  }

  /** Release a tile's instances (slots recycled by our own free list — see note above). */
  function remove(handle) {
    if (!handle || handle.dead) return;
    handle.dead = true;
    for (let i = 0; i < handle.ids.length; i++) {
      bm.setVisibleAt(handle.ids[i], false);
      freeIds.push(handle.ids[i]);
    }
    handle.visCount = 0;
  }

  /**
   * Per-instance "urban glow" wash factor, stored in the UNUSED ALPHA channel of BatchedMesh's
   * colours texture (setColorAt only writes rgb; the batching-colour fetch in the shader returns
   * vec4, so .a rides along for free). The pool material's night shader reads it as the
   * building-proximity factor. Uses the private _colorsTexture — three is pinned at 0.183.
   */
  function setWashAt(instanceId, w) {
    const tex = bm._colorsTexture;
    if (!tex) return;
    tex.image.data[instanceId * 4 + 3] = w;
    tex.needsUpdate = true;
  }

  /** Per-tile LOD: show exactly the `target` nearest instances of this handle. Incremental. */
  function setVisibleCount(handle, target) {
    if (!handle || handle.dead) return;
    const t = Math.max(0, Math.min(handle.count, target | 0));
    const prev = handle.visCount;
    if (t === prev) return;
    const ids = handle.ids;
    if (t > prev) { for (let i = prev; i < t; i++) bm.setVisibleAt(ids[i], true); }
    else { for (let i = t; i < prev; i++) bm.setVisibleAt(ids[i], false); }
    handle.visCount = t;
  }

  /** Per-instance colour (BatchedMesh colours texture) — e.g. bridge-pole night cycling. */
  function setColorAt(instanceId, color) {
    bm.setColorAt(instanceId, color);
  }

  const api = { name, mesh: bm, add, remove, setVisibleCount, setWashAt, setColorAt, freeSlots };
  return api;
}

/**
 * A SET of fixed-capacity pools sharing one config: adds route to the first pool with room and a
 * new sibling pool is created when all are full. This replaces in-place growth (realloc + full
 * texture re-upload = streaming stalls) with a one-time ~1 ms pool creation, and keeps every data
 * texture at the 16384-instance (256², 1 MB) size. Handles carry their owning pool (handle.pool),
 * so LOD / removal / wash calls route themselves — consumers never see the set boundary.
 */
export function createVegPoolSet(opts, parentGroup) {
  const pools = [createVegPool(opts)];
  parentGroup.add(pools[0].mesh);

  async function add(groups, yieldFn, startVisible = true) {
    for (const p of pools) {
      const h = await p.add(groups, yieldFn, startVisible);
      if (h !== undefined) return h;   // null (empty add) or a real handle
    }
    const p = createVegPool(opts);
    pools.push(p);
    parentGroup.add(p.mesh);
    const h = await p.add(groups, yieldFn, startVisible);
    return h === undefined ? null : h;   // a single tile larger than a whole pool: drop (never seen; guard)
  }

  return { name: opts.name, add, pools };
}

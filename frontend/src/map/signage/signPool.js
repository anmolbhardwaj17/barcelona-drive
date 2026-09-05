/**
 * signPool.js — every post-mounted sign face in the city, in one pool. v3 P4-11.
 *
 * ── IT RIDES createVegPool, IT DOES NOT REIMPLEMENT ONE ────────────────────────────────────────
 *
 * The ticket says "riding the existing city-wide pool", and that is `map/vegPools.js`. Building a
 * second `BatchedMesh` wrapper here would mean re-learning everything that file already paid for,
 * in particular:
 *
 *   • never call `deleteInstance()` — once ids land in BatchedMesh's freed list, every later
 *     `addInstance()` sorts the whole list, which compounds into multi-second streaming stalls;
 *   • `perObjectFrustumCulled` and `sortObjects` must be OFF or the CPU does a matrix multiply and
 *     a sphere test per instance per frame;
 *   • a `userData.type` is required, or `_ddGround()` reports the pool by its MINIFIED class name
 *     and "are the signs missing or hidden?" cannot be answered from a production build.
 *
 * Signs are a far smaller population than trees, so none of those would have bitten immediately —
 * they would have bitten later, which is worse.
 *
 * ── WHAT IS AND IS NOT IN THIS POOL ────────────────────────────────────────────────────────────
 *
 * POST-MOUNTED faces only: the vertical plates on a pole. The manifest's `mount` field says which,
 * and the road-painted pictograms (`mount: 'road'`) are deliberately NOT here — they are ground
 * paint and belong in the `groundLayers` scheme with the rest of it, under P4-12. Mixing a
 * horizontal decal into a vertical-quad pool is how a lane arrow ends up standing on its edge.
 *
 * Street NAMES are not here either. 2,427 of them cannot be baked into 18 cells, which is what
 * `textAtlas.js` exists for; this pool draws what a sign IS, the text page draws what it SAYS.
 */
import * as THREE from 'three';
import { createVegPoolSet } from '../vegPools.js';
import { getKTX2TextureSync } from '../../loaders.js';
import { registerMaterial } from '../materialRegistry.js';
import manifest from './signAtlasCells.js';
import { cellQuad, indexCells } from './signQuads.js';

/** Cells this pool draws — vertical plates only. Road paint is P4-12's, see the header. */
export const POST_CELLS = manifest.cells.filter((c) => c.mount === 'post');

const CAPACITY = 2048;   // signs per pool; the pool set spawns a sibling rather than growing one

let _material = null;
export function getSignMaterial() {
  if (_material) return _material;
  // ⚠ SYNC, not `getKTX2Texture`. The async one returns a PROMISE — assigning it to `map` gives the
  // material a Promise where a texture belongs and the sign draws untextured with no error at all.
  // `getKTX2TextureSync` hands back an empty CompressedTexture and fills it when the fetch lands,
  // which is how `urbanFeatureRenderer` loads the furniture atlas. Do not `.clone()` the result —
  // that file records three failed tile builds from cloning it before the fetch landed.
  const map = getKTX2TextureSync(manifest.texture, { srgb: true, tiling: false });
  _material = new THREE.MeshLambertMaterial({
    map,
    transparent: false,
    // ⚠ alphaTest, NOT transparent. A transparent sign would enter the sorted pass, and a
    // BatchedMesh with sortObjects off (which it must be, see the header) cannot sort within
    // itself — so signs would z-fight each other by draw order. Alpha-tested cutout is also what
    // the tree cards use for exactly the same reason.
    alphaTest: 0.5,
    side: THREE.FrontSide,
    // The retroreflective floor: a sign stays legible on an unlit street instead of going to black,
    // which is the same reasoning `getDirectionBoardMat` records for using Lambert over Basic.
    emissive: new THREE.Color(0x2a2a28),
  });
  _material.userData.sharedMaterial = true;
  // v3 P1-03: REGISTERED, so the night light grid reaches it. An unregistered material is lit by
  // ambient alone after dark — the defect Z-2a found in the parking renderer.
  // (`patchMaterial` is the wrong call here: its second argument is a patch FUNCTION, and passing a
  // string makes it return the material untouched, silently. `registerMaterial` is what enrols it.)
  registerMaterial(_material, 'signAtlas');
  return _material;
}

/**
 * @param {THREE.Object3D} parentGroup  the world group (signs live in the mirrored world, like roads)
 */
export function createSignPool(parentGroup) {
  const cells = indexCells(manifest);
  // One geometry per cell, UVs baked in — see signQuads' note on why faces do not need a
  // per-instance attribute and text does.
  const geometries = POST_CELLS.map((c) => {
    const q = cellQuad(c, c.sizeM, c.sizeM);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(q.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(q.uv, 2));
    g.setIndex(new THREE.BufferAttribute(q.index, 1));
    return g;
  });
  /** cell name → index into `geometries`, which is what the pool's `geoIndex` means. */
  const geoIndexOf = new Map(POST_CELLS.map((c, i) => [c.name, i]));

  const set = createVegPoolSet({
    name: 'signs',
    geometries,
    material: getSignMaterial(),
    capacity: CAPACITY,
    castShadow: false,     // small props; the projected pole shadow covers grounding
    receiveShadow: true,
  }, parentGroup);

  /**
   * Add one tile's signs.
   *
   * @param {{cell:string, matrix:number[]|Float32Array, tint?:number[]}[]} signs
   * @param {Function} yieldFn  frame-budget yield, same contract as the veg pools
   * @returns {Promise<object|null>} a handle to pass to `remove()` on tile unload
   */
  async function add(signs, yieldFn) {
    if (!signs?.length) return null;
    // Group by cell, because the pool's unit of work is (geometry, matrices) — one group per cell
    // rather than one per sign is the difference between 13 groups and hundreds.
    const byCell = new Map();
    for (const s of signs) {
      const gi = geoIndexOf.get(s.cell);
      if (gi === undefined) {
        // Loud, once per unknown name: silently skipping would look like the sign failing to spawn.
        cells.get(s.cell);   // throws with the full explanation
        continue;
      }
      let g = byCell.get(gi);
      if (!g) { g = { geoIndex: gi, count: 0, mats: [], cols: [] }; byCell.set(gi, g); }
      g.count++;
      g.mats.push(...s.matrix);
      g.cols.push(...(s.tint || [1, 1, 1]));
    }
    const groups = [...byCell.values()].map((g) => ({
      geoIndex: g.geoIndex, count: g.count,
      matrices: new Float32Array(g.mats), colors: new Float32Array(g.cols),
    }));
    return set.add(groups, yieldFn, true);
  }

  return {
    add,
    remove: (handle) => handle?.pool?.remove(handle),
    cells: POST_CELLS,
    get pools() { return set.pools; },
  };
}

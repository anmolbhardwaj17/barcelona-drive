/**
 * Parked cars — the signature of every Barcelona street: cars along both curbs.
 *
 * Uses the Kenney low-poly city cars through the SHARED car pool (carFleet.js): v3 P4-15a replaced
 * the nine per-variant InstancedMeshes with instances in the ONE BatchedMesh that traffic also draws
 * from, so variety now costs a geometry id per instance instead of a draw call per variant. Placement
 * marches loaded drivable road centerlines (physics frame), drops a car every SPACING m on each curb
 * (with junction gaps + ~45% empty slots). Rebuilt only when the player moves > REBUILD_DIST. Visual-only.
 *
 * Frame: physics frame (added to `scene`). World→physics: px = -(wx - origin.x), pz = wz - origin.z.
 */
import * as THREE from 'three';
import { getCarPool, createLightPool, makeLightLocals, LIGHT_HEAD, LIGHT_TAIL } from './carFleet.js';
import { parkingBayOffset, parkingBayWidth, kerbOffset } from '../map/roadWidths.js';   // R-W1
import { CANON_LENGTH } from './carModels.js';

// living_street dropped — those are the tight lanes where big parked cars look unrealistic.
const DRIVABLE = new Set([
  'residential', 'unclassified',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link',
]);
// R-W1: HALFW_BY_TYPE is gone. It was a THIRD width scale — half-widths, with numbers matching
// neither of the two full-width tables — and reading `seg.width / 2` as "the kerb" is what parked
// cars on the guard rails. Whether a road has a bay, how wide it is and where its centre sits are
// now decided once, in the bake's width model, and read through roadWidths.js.
const MIN_BAY_WIDTH = 1.8;   // m — narrower than this is a kerb stripe, not a parking space

// Flat instance ceiling across all variants. Was 180 PER VARIANT — 1,620 slots for the ~150-250 cars
// a dense 200 m radius actually places, so the old number said nothing about the real ceiling. This
// one does, which is why it is set with headroom and why binding it logs (see put()).
const CAPACITY     = 512;
const CAR_LENGTH   = 3.8;  // m
const SPACING      = 17.5; // m between parked-car slots (widened ~20% → fewer cars, better perf)
const RANGE        = 200;  // m — place within this radius of the player
const REBUILD_DIST = 35;   // m — player movement before a rebuild
const JUNCTION_GAP = 8;    // m — no parking within this of a road's ends (junctions)
const YAXIS = new THREE.Vector3(0, 1, 0);

export function createParkedCars({ scene, getRoadSegments, getGroundY, getOrigin }) {
  let _pool = null;
  let nVar = 0;
  let _enabled = true;
  let _pending = null;
  let _lastX = Infinity, _lastZ = Infinity;

  // Pool slots this system owns. Allocated lazily up to CAPACITY and then RECYCLED across rebuilds —
  // the high-water mark is what the fleet's per-frame cull walk costs, so we never over-reserve.
  const _slots = [];
  let _used = 0;        // slots written by the rebuild in progress
  let _prevUsed = 0;    // slots written by the previous rebuild, to hide the tail we no longer need

  // Glowing head/tail lights (so parked cars read at night). ONE InstancedMesh; head and tail are
  // told apart by instance colour. Each parked car contributes 2 white front + 2 red rear quads.
  // 4 quads per car. Head and tail share ONE pool now, so this is 2× the old per-mesh cap, not the
  // same number — halving it would silently strip the lights off the farther half of the street.
  const LIGHT_CAP = CAPACITY * 4;
  const BLOB_SIZE_X = 2.1, BLOB_SIZE_Z = 4.4;   // v3 P0-15: a shade wider/longer than a Kenney car body
  const lights = createLightPool({ scene, capacity: LIGHT_CAP, width: 0.24, height: 0.12 });
  let lightLocals = [];
  const _lm = new THREE.Matrix4();

  const CAR_SCALE = CAR_LENGTH / CANON_LENGTH;

  getCarPool(scene).then((pool) => {
    if (!pool) { console.warn('[parkedCars] no car templates loaded'); return; }
    _pool = pool;
    nVar = pool.variantCount;
    // Pool geometry is canonical; these dims (and so the light offsets) are at CAR_LENGTH.
    lightLocals = pool.templates.map((t) => makeLightLocals({
      w: t.dims.w * CAR_SCALE, h: t.dims.h * CAR_SCALE, l: t.dims.l * CAR_SCALE,
    }));
    if (_pending) { rebuild(_pending.x, _pending.z); _pending = null; }
  }).catch((e) => console.warn('[parkedCars] load error', e?.message || e));

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(CAR_SCALE, CAR_SCALE, CAR_SCALE), _p = new THREE.Vector3();
  const _lightBase = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1);

  // v3 P0-15: cached blob-shadow transforms. Parked cars are castShadow:false (the shadow pass
  // tanked FPS with 45 instanced casters), so without a contact blob they read as floating. They
  // cannot push blobs from put() directly: rebuild() only runs when the player has moved
  // REBUILD_DIST, while contactShadows.begin() zeroes the buffer EVERY frame — so the blobs are
  // cached here at placement time and re-pushed each frame by drawShadows().
  const _blobs = [];

  // No per-car tint: the Kenney atlas already colours the body, and multiplying a tint on top of an
  // already-painted model produced muddy shades. `colorHex` is kept in the signature because the
  // placement hash still derives one, and dropping it would silently shift every other hashed choice.
  let _warnedFull = false;
  function put(variant, px, py, pz, yaw, _colorHex) {
    if (!_pool) return;
    if (_used >= CAPACITY) {
      // Dropping cars is the right failure (better than a stall), but it must not be SILENT — a
      // street that thins out at one end is otherwise indistinguishable from a placement bug.
      if (!_warnedFull) { _warnedFull = true; console.warn('[parkedCars] hit the %d-car ceiling — raise CAPACITY', CAPACITY); }
      return;
    }
    if (_used >= _slots.length) {
      const id = _pool.alloc();
      if (id < 0) return;   // shared fleet is full — place fewer cars rather than throwing
      _slots.push(id);
    }
    _q.setFromAxisAngle(YAXIS, yaw);
    _p.set(px, py, pz);
    // The car matrix carries CAR_SCALE (the pool's geometry is canonical); the light matrix must not,
    // because the light offsets are already in CAR_LENGTH units. See makeLightLocals.
    _m.compose(_p, _q, _s);
    _pool.place(_slots[_used++], variant, _m);
    _blobs.push(px, py, pz, yaw);   // v3 P0-15 — flat quads: x, y, z, yaw

    const L = lightLocals[variant];
    if (L) {
      _lightBase.compose(_p, _q, _one);
      for (const lm of L.head) { _lm.multiplyMatrices(_lightBase, lm); lights.put(_lm, LIGHT_HEAD); }
      for (const lm of L.tail) { _lm.multiplyMatrices(_lightBase, lm); lights.put(_lm, LIGHT_TAIL); }
    }
  }

  // Compute a segment's invariant parking metadata once (cached on seg._pcMeta). Returns null if the
  // segment can never hold parked cars (not drivable, too narrow, or too short).
  function computeSegMeta(seg) {
    if (!DRIVABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) return null;
    // ⚠ NO STREET PARKING AGAINST A GUARD RAIL — now settled by the width model (R-W1).
    //
    // The original bug: the rail sat at `halfW` (reading `width` as the carriageway edge) and
    // parking at `halfW - 0.2` (reading it as INCLUDING the parking lane). Twenty centimetres
    // apart, so the cars landed on the barrier. Neither reading was wrong on its own; the field
    // had no defined meaning and nothing arbitrated it.
    //
    // Now the bake emits a parking BAY — a width and a side — and the same model puts the kerb
    // (and so the rail) outside it by construction. `test/roadWidths.test.js` asserts the bay's
    // outer edge never passes `kerbOffset`, so this specific bug cannot come back silently.
    //
    // The physical gate stays, and it is still load-bearing: the model zeroes the bay on a bridge,
    // ramp, elevated deck or tunnel, but only if those flags REACH it. They now do — see
    // tileManager.getLoadedRoadSegments, which had been dropping all four (D-42).
    if (seg.bridge || seg.isRamp || (seg.layer != null && seg.layer > 0) || seg.crossesTrench === true) return null;
    const bayL = parkingBayWidth(seg, 'left');
    const bayR = parkingBayWidth(seg, 'right');
    if (bayL < MIN_BAY_WIDTH && bayR < MIN_BAY_WIDTH) return null;   // no bay → no parked cars
    const pts = seg.points;
    let totalLen = 0, minWx = Infinity, maxWx = -Infinity, minWy = Infinity, maxWy = -Infinity;
    for (let s = 0; s < pts.length; s++) {
      if (s < pts.length - 1) totalLen += Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].y - pts[s].y);
      const px = pts[s].x, py = pts[s].y;
      if (px < minWx) minWx = px; if (px > maxWx) maxWx = px;
      if (py < minWy) minWy = py; if (py > maxWy) maxWy = py;
    }
    if (totalLen < JUNCTION_GAP * 2 + SPACING) return null;
    // Two offsets now, not one — a road can have a bay on one side only (OSM `parking:left=no`).
    return {
      offsetL: bayL >= MIN_BAY_WIDTH ? parkingBayOffset(seg, 'left') : 0,
      offsetR: bayR >= MIN_BAY_WIDTH ? parkingBayOffset(seg, 'right') : 0,
      kerb: kerbOffset(seg),
      totalLen, minWx, maxWx, minWy, maxWy,
    };
  }

  function rebuild(playerPx, playerPz) {
    if (!nVar) { _pending = { x: playerPx, z: playerPz }; return; }
    const segs = getRoadSegments?.();
    if (!segs) return;
    const origin = getOrigin();
    _prevUsed = _used;
    _used = 0;
    lights.begin();
    _blobs.length = 0;   // v3 P0-15: rebuilt in lockstep with the instance buffers
    const rangeSq = RANGE * RANGE;

    // Player position in world frame (roads are stored world-frame). Computed once, not per segment.
    const pwx = origin.x - playerPx, pwy = playerPz + origin.z;

    for (const seg of segs) {
      // Per-segment metadata (eligibility + static bbox + total length) is INVARIANT — roads don't move —
      // so compute it ONCE and cache it on the segment. Previously this walked every point of all ~4000
      // segments on EVERY rebuild (every 35 m) → the ~11 ms `ent` stutter. Now a far segment costs just the
      // cheap cached-bbox test below; only near segments run the placement walk. (`null` = ineligible.)
      let meta = seg._pcMeta;
      if (meta === undefined) { meta = computeSegMeta(seg); seg._pcMeta = meta; }
      if (!meta) continue;

      // Cheap static-bbox cull against the (cached) segment bounds.
      const ddx = Math.max(meta.minWx - pwx, 0, pwx - meta.maxWx);
      const ddy = Math.max(meta.minWy - pwy, 0, pwy - meta.maxWy);
      if (ddx * ddx + ddy * ddy > rangeSq) continue;

      const offsetL = meta.offsetL, offsetR = meta.offsetR, totalLen = meta.totalLen;
      const pts = seg.points;
      let seed = (seg.id | 0) % 997; if (seed < 0) seed += 997;
      let acc = (seed % 5) / 5 * SPACING;
      let roadDistBase = 0;

      for (let s = 0; s < pts.length - 1; s++) {
        const ax = -(pts[s].x - origin.x), az = pts[s].y - origin.z;
        const bx = -(pts[s + 1].x - origin.x), bz = pts[s + 1].y - origin.z;
        let dx = bx - ax, dz = bz - az;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 0.01) continue;
        dx /= segLen; dz /= segLen;
        const rx = dz, rz = -dx;
        let dist = acc;
        while (dist < segLen) {
          const roadDist = roadDistBase + dist;
          if (roadDist < JUNCTION_GAP || roadDist > totalLen - JUNCTION_GAP) { dist += SPACING; continue; }
          const slot = Math.floor(roadDist / SPACING);
          if (((slot * 7 + seed) % 20) < 9) { dist += SPACING; continue; } // ~45% empty
          const cx = ax + dx * dist, cz = az + dz * dist;
          if ((cx - playerPx) ** 2 + (cz - playerPz) ** 2 < rangeSq) {
            const yawR = Math.atan2(dx, dz);
            // height on the centerline (reliably on-road; curb offset can read low terrain and sink the car)
            const y = getGroundY ? (getGroundY(origin.x - cx, cz + origin.z) ?? 0) : 0;
            const vR = ((slot * 13 + seed) % nVar + nVar) % nVar;
            const vL = ((slot * 13 + seed + 4) % nVar + nVar) % nVar;
            // Each side is placed only if that side actually has a bay.
            if (offsetR) put(vR, cx + rx * offsetR, y, cz + rz * offsetR, yawR, 0);
            if (offsetL) put(vL, cx - rx * offsetL, y, cz - rz * offsetL, yawR + Math.PI, 0);
          }
          dist += SPACING;
        }
        acc = dist - segLen;
        roadDistBase += segLen;
      }
    }
    // Slots the previous rebuild used and this one did not must be switched OFF, or last frame's
    // cars stay parked where the player no longer is. Recycled slots are simply overwritten above.
    for (let i = _used; i < _prevUsed; i++) _pool.hide(_slots[i]);
    lights.commit();
  }

  function update(playerPx, playerPz) {
    if (!_enabled) return;
    if ((playerPx - _lastX) ** 2 + (playerPz - _lastZ) ** 2 < REBUILD_DIST * REBUILD_DIST) return;
    _lastX = playerPx; _lastZ = playerPz;
    rebuild(playerPx, playerPz);
  }

  function setEnabled(on) {
    _enabled = on;
    // The car pool is SHARED with traffic, so this can never hide the mesh — it hides this system's
    // own instances. Turning it back on costs one rebuild, which the next update() triggers anyway
    // because _lastX/_lastZ are reset here.
    if (!on) {
      if (_pool) for (let i = 0; i < _used; i++) _pool.hide(_slots[i]);
      _prevUsed = 0; _used = 0; _blobs.length = 0;
      _lastX = Infinity; _lastZ = Infinity;
    }
    lights.setVisible(on);
  }
  function getCount() { return _used; }
  function dispose() {
    // Geometry and material are SHARED (H6) — this system owns neither, and disposing either would
    // take the cars out from under traffic. The slots ARE ours, so they go back to the pool's own
    // free list; BatchedMesh.deleteInstance is never called (H3).
    if (_pool) for (const id of _slots) _pool.release(id);
    _slots.length = 0;
    _used = 0; _prevUsed = 0;
    lights.dispose();
  }

  /**
   * v3 P0-15: push a contact-shadow blob for every placed parked car. MUST be called every frame,
   * between contactShadows.begin() and .commit() — that buffer is zeroed each frame while our
   * placement only refreshes on REBUILD_DIST. Cheap: a flat array walk, no allocation.
   * The shared pool has capacity 700 against roughly 200 parked cars, so it fits alongside traffic.
   */
  function drawShadows(cs) {
    if (!_enabled || !cs) return;
    for (let i = 0; i < _blobs.length; i += 4) {
      cs.add(_blobs[i], _blobs[i + 1], _blobs[i + 2], BLOB_SIZE_X, BLOB_SIZE_Z, _blobs[i + 3]);
    }
  }

  return { update, setEnabled, getCount, dispose, drawShadows };
}

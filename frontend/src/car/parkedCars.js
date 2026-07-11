/**
 * Parked cars — the signature of every Barcelona street: cars along both curbs.
 *
 * Uses the Kenney low-poly city cars: one InstancedMesh PER variant (sedan/suv/van/…), parked cars
 * distributed across them by a deterministic hash → real variety + only ~9 draw calls total. Placement
 * marches loaded drivable road centerlines (physics frame), drops a car every SPACING m on each curb
 * (with junction gaps + ~45% empty slots). Rebuilt only when the player moves > REBUILD_DIST. Visual-only.
 *
 * Frame: physics frame (added to `scene`). World→physics: px = -(wx - origin.x), pz = wz - origin.z.
 */
import * as THREE from 'three';
import { loadCityCarTemplates } from './carModels.js';

// living_street dropped — those are the tight lanes where big parked cars look unrealistic.
const DRIVABLE = new Set([
  'residential', 'unclassified',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link',
]);
const MIN_PARK_WIDTH = 6.5; // m — skip parked cars on roads narrower than this (tight streets)
const HALFW_BY_TYPE = {
  residential: 4, unclassified: 4,
  tertiary: 4.5, tertiary_link: 4, secondary: 5.5, secondary_link: 4.5,
  primary: 6.5, primary_link: 5,
};

const CAPACITY_PER = 180;  // per-variant instance capacity
const SPACING      = 17.5; // m between parked-car slots (widened ~20% → fewer cars, better perf)
const RANGE        = 200;  // m — place within this radius of the player
const REBUILD_DIST = 35;   // m — player movement before a rebuild
const JUNCTION_GAP = 8;    // m — no parking within this of a road's ends (junctions)
const YAXIS = new THREE.Vector3(0, 1, 0);
// Per-car tint (multiplies the Kenney texture: white body → this colour, dark glass/wheels stay dark).
// Bright, cheerful automotive colours — no dark/grey (they read as "off"/dead against the world).
const TINT = [
  0xE8433A, // red
  0x2E86DE, // blue
  0x27AE60, // green
  0xF39C12, // orange
  0xF1C40F, // yellow
  0xF2F2F2, // white
  0x9B59B6, // purple
  0x16A085, // teal
  0xEC7FB0, // pink
  0x5DADE2, // sky blue
  0xE67E22, // pumpkin
  0x48C9B0, // mint
  0xEC7063, // coral
];

export function createParkedCars({ scene, getRoadSegments, getGroundY, getOrigin }) {
  let meshes = [];   // InstancedMesh per variant
  let nVar = 0;
  let _enabled = true;
  let _pending = null;
  let _lastX = Infinity, _lastZ = Infinity;

  // Glowing head/tail lights (so parked cars read at night). Two shared InstancedMeshes; each parked
  // car contributes 2 white front + 2 red rear quads, transformed by the car matrix.
  const LIGHT_CAP = 1400;
  let tailIM = null, headIM = null, lightLocals = [];
  let tailCount = 0, headCount = 0;
  const _lm = new THREE.Matrix4();

  loadCityCarTemplates('/models/cars/', 3.8).then((tpls) => {
    if (!tpls.length) { console.warn('[parkedCars] no car templates loaded'); return; }
    meshes = tpls.map((t) => {
      const im = new THREE.InstancedMesh(t.geometry, t.material, CAPACITY_PER);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = false; // parked cars don't cast shadow-map shadows (pedestrians.js does the same — the shadow pass tanked FPS)
      im.count = 0;
      scene.add(im);
      return im;
    });
    nVar = meshes.length;

    // Light instanced meshes + per-variant local light-quad matrices (from each car's dims).
    const lightGeo = new THREE.PlaneGeometry(0.24, 0.12);
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a12, side: THREE.DoubleSide, fog: true });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8, side: THREE.DoubleSide, fog: true });
    tailIM = new THREE.InstancedMesh(lightGeo, tailMat, LIGHT_CAP); tailIM.frustumCulled = false; tailIM.castShadow = false; tailIM.count = 0; scene.add(tailIM);
    headIM = new THREE.InstancedMesh(lightGeo, headMat, LIGHT_CAP); headIM.frustumCulled = false; headIM.castShadow = false; headIM.count = 0; scene.add(headIM);
    const _tq = new THREE.Quaternion();
    lightLocals = tpls.map((t) => {
      const w = t.dims.w, h = t.dims.h, l = t.dims.l, y = h * 0.42;
      const mk = (x, z, ry) => { const m = new THREE.Matrix4(); _tq.setFromAxisAngle(YAXIS, ry); m.compose(new THREE.Vector3(x, y, z), _tq, new THREE.Vector3(1, 1, 1)); return m; };
      return { head: [mk(-w * 0.3, l * 0.49, 0), mk(w * 0.3, l * 0.49, 0)], tail: [mk(-w * 0.3, -l * 0.49, Math.PI), mk(w * 0.3, -l * 0.49, Math.PI)] };
    });

    if (_pending) { rebuild(_pending.x, _pending.z); _pending = null; }
  }).catch((e) => console.warn('[parkedCars] load error', e?.message || e));

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3(), _col = new THREE.Color();
  const counts = [];

  function put(variant, px, py, pz, yaw, colorHex) {
    if (counts[variant] >= CAPACITY_PER) return;
    _q.setFromAxisAngle(YAXIS, yaw);
    _p.set(px, py, pz);
    _m.compose(_p, _q, _s);
    const idx = counts[variant]++;
    meshes[variant].setMatrixAt(idx, _m);
    // No per-car tint: the Kenney atlas already colours the body. Instance colour stays white so the texture
    // shows through instead of being multiplied into a muddy over-tint. (colorHex kept for signature compat.)
    meshes[variant].setColorAt(idx, _col.setHex(0xffffff));

    // Glowing lights, transformed by this car's matrix (_m still holds it).
    const L = lightLocals[variant];
    if (L && tailIM && tailCount + 2 <= LIGHT_CAP && headCount + 2 <= LIGHT_CAP) {
      for (const lm of L.head) { _lm.multiplyMatrices(_m, lm); headIM.setMatrixAt(headCount++, _lm); }
      for (const lm of L.tail) { _lm.multiplyMatrices(_m, lm); tailIM.setMatrixAt(tailCount++, _lm); }
    }
  }

  // Compute a segment's invariant parking metadata once (cached on seg._pcMeta). Returns null if the
  // segment can never hold parked cars (not drivable, too narrow, or too short).
  function computeSegMeta(seg) {
    if (!DRIVABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) return null;
    const halfW = (seg.width && seg.width > 1) ? seg.width / 2 : (HALFW_BY_TYPE[seg.highwayType] ?? 4);
    if (halfW * 2 < MIN_PARK_WIDTH) return null; // tight street → no parked cars
    const pts = seg.points;
    let totalLen = 0, minWx = Infinity, maxWx = -Infinity, minWy = Infinity, maxWy = -Infinity;
    for (let s = 0; s < pts.length; s++) {
      if (s < pts.length - 1) totalLen += Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].y - pts[s].y);
      const px = pts[s].x, py = pts[s].y;
      if (px < minWx) minWx = px; if (px > maxWx) maxWx = px;
      if (py < minWy) minWy = py; if (py > maxWy) maxWy = py;
    }
    if (totalLen < JUNCTION_GAP * 2 + SPACING) return null;
    return { halfW, offset: halfW - 0.2, totalLen, minWx, maxWx, minWy, maxWy };
  }

  function rebuild(playerPx, playerPz) {
    if (!nVar) { _pending = { x: playerPx, z: playerPz }; return; }
    const segs = getRoadSegments?.();
    if (!segs) return;
    const origin = getOrigin();
    for (let v = 0; v < nVar; v++) counts[v] = 0;
    tailCount = 0; headCount = 0;
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

      const halfW = meta.halfW, offset = meta.offset, totalLen = meta.totalLen;
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
            const cR = TINT[((slot * 5 + seed) % TINT.length + TINT.length) % TINT.length];
            const cL = TINT[((slot * 5 + seed + 6) % TINT.length + TINT.length) % TINT.length];
            put(vR, cx + rx * offset, y, cz + rz * offset, yawR, cR);
            put(vL, cx - rx * offset, y, cz - rz * offset, yawR + Math.PI, cL);
          }
          dist += SPACING;
        }
        acc = dist - segLen;
        roadDistBase += segLen;
      }
    }
    for (let v = 0; v < nVar; v++) {
      meshes[v].count = counts[v];
      meshes[v].instanceMatrix.needsUpdate = true;
      if (meshes[v].instanceColor) meshes[v].instanceColor.needsUpdate = true;
    }
    if (tailIM) { tailIM.count = tailCount; tailIM.instanceMatrix.needsUpdate = true; }
    if (headIM) { headIM.count = headCount; headIM.instanceMatrix.needsUpdate = true; }
  }

  function update(playerPx, playerPz) {
    if (!_enabled) return;
    if ((playerPx - _lastX) ** 2 + (playerPz - _lastZ) ** 2 < REBUILD_DIST * REBUILD_DIST) return;
    _lastX = playerPx; _lastZ = playerPz;
    rebuild(playerPx, playerPz);
  }

  function setEnabled(on) {
    _enabled = on;
    for (const m of meshes) { m.visible = on; if (!on) m.count = 0; }
    if (tailIM) { tailIM.visible = on; if (!on) tailIM.count = 0; }
    if (headIM) { headIM.visible = on; if (!on) headIM.count = 0; }
  }
  function getCount() { let n = 0; for (const m of meshes) n += m.count; return n; }
  function dispose() {
    for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose?.(); }
    for (const im of [tailIM, headIM]) { if (im) { scene.remove(im); im.geometry.dispose(); im.material.dispose?.(); } }
  }

  return { update, setEnabled, getCount, dispose };
}

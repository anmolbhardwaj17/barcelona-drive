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

const DRIVABLE = new Set([
  'residential', 'living_street', 'unclassified',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link',
]);
const HALFW_BY_TYPE = {
  residential: 4, living_street: 3.5, unclassified: 4,
  tertiary: 4.5, tertiary_link: 4, secondary: 5.5, secondary_link: 4.5,
  primary: 6.5, primary_link: 5,
};

const CAPACITY_PER = 180;  // per-variant instance capacity
const SPACING      = 14;   // m between parked-car slots along a curb
const RANGE        = 200;  // m — place within this radius of the player
const REBUILD_DIST = 35;   // m — player movement before a rebuild
const JUNCTION_GAP = 8;    // m — no parking within this of a road's ends (junctions)
const YAXIS = new THREE.Vector3(0, 1, 0);
// Per-car tint (multiplies the Kenney texture: white body → this colour, dark glass/wheels stay dark).
const TINT = [
  0xE8E8E8, 0xCED2D6, 0xBFC3C7, 0x2B2F34, 0x8A9099, 0x565B61,
  0xB23A2E, 0x2471A3, 0x239B56, 0x34495E, 0xC9A227, 0x7B4B2A, 0x922B21,
];

export function createParkedCars({ scene, getRoadSegments, getGroundY, getOrigin }) {
  let meshes = [];   // InstancedMesh per variant
  let nVar = 0;
  let _enabled = true;
  let _pending = null;
  let _lastX = Infinity, _lastZ = Infinity;

  loadCityCarTemplates('/models/cars/', 3.8).then((tpls) => {
    if (!tpls.length) { console.warn('[parkedCars] no car templates loaded'); return; }
    meshes = tpls.map((t) => {
      const im = new THREE.InstancedMesh(t.geometry, t.material, CAPACITY_PER);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      im.count = 0;
      scene.add(im);
      return im;
    });
    nVar = meshes.length;
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
    meshes[variant].setColorAt(idx, _col.setHex(colorHex));
  }

  function rebuild(playerPx, playerPz) {
    if (!nVar) { _pending = { x: playerPx, z: playerPz }; return; }
    const segs = getRoadSegments?.();
    if (!segs) return;
    const origin = getOrigin();
    for (let v = 0; v < nVar; v++) counts[v] = 0;
    const rangeSq = RANGE * RANGE;

    for (const seg of segs) {
      if (!DRIVABLE.has(seg.highwayType) || !seg.points || seg.points.length < 2) continue;
      const halfW = (seg.width && seg.width > 1) ? seg.width / 2 : (HALFW_BY_TYPE[seg.highwayType] ?? 4);
      const offset = halfW - 0.2;
      const pts = seg.points;
      let seed = (seg.id | 0) % 997; if (seed < 0) seed += 997;
      let acc = (seed % 5) / 5 * SPACING;

      let totalLen = 0;
      for (let s = 0; s < pts.length - 1; s++) totalLen += Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].y - pts[s].y);
      if (totalLen < JUNCTION_GAP * 2 + SPACING) continue;
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
  }

  function update(playerPx, playerPz) {
    if (!_enabled) return;
    if ((playerPx - _lastX) ** 2 + (playerPz - _lastZ) ** 2 < REBUILD_DIST * REBUILD_DIST) return;
    _lastX = playerPx; _lastZ = playerPz;
    rebuild(playerPx, playerPz);
  }

  function setEnabled(on) { _enabled = on; for (const m of meshes) { m.visible = on; if (!on) m.count = 0; } }
  function getCount() { let n = 0; for (const m of meshes) n += m.count; return n; }
  function dispose() { for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose?.(); } }

  return { update, setEnabled, getCount, dispose };
}

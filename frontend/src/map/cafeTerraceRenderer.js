/**
 * Café terraces — the parasol-and-table clusters that spill onto Barcelona sidewalks in front of bars
 * and cafés. For a deterministic subset of ground-floor buildings with a wide street-facing frontage we
 * lay a short row of tables out on the sidewalk, each with two chairs and a fabric parasol.
 *
 * Two InstancedMeshes per tile, both driven by the SAME per-table transforms:
 *   1. furniture  — table + pole + umbrella pole + 2 chairs, merged once, baked vertex colours (neutral).
 *   2. canopies   — the parasol cone, tinted per-instance (setColorAt) from a café-parasol palette.
 * So a whole tile of terraces is 2 draw calls, and both dim naturally with the day/night lights.
 * Purely decorative — no colliders (you drive through them, same as the trees).
 *
 * Built in world coords, added to the mirrored worldGroup (same as awnings / shop signs).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldToLatLon } from '../projection.js';

const MIN_EDGE   = 12;    // only wide frontages (→ wider streets, room on the sidewalk)
const SIDEWALK_OFFSET = 1.95;  // how far the tables sit out from the façade (past the 1.35 m awning line)
const TABLE_GAP  = 2.4;   // spacing between tables along the frontage
const CAFE_CHANCE = 0.34; // fraction of eligible buildings that become a terrace
const TABLE_CAP  = 90;    // per-tile table budget

// Parasol fabric palette.
const CANOPY_COLORS = [
  0xEDE4CF, 0xF2F0EA, 0xC0603A, 0xA83232, 0x2F6B3A, 0x2E5A8A, 0xC79A2E,
];

// ── unit furniture + canopy geometries (built once, shared) ──────────────────
let _furnitureGeo = null;
let _canopyGeo = null;

function colored(geo, hex) {
  const n = geo.attributes.position.count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

function buildFurnitureGeo() {
  if (_furnitureGeo) return _furnitureGeo;
  const parts = [];

  const tableTop = new THREE.CylinderGeometry(0.36, 0.36, 0.05, 12);
  tableTop.translate(0, 0.72, 0);
  parts.push(colored(tableTop, 0xd8d4cc));

  const tablePole = new THREE.CylinderGeometry(0.035, 0.05, 0.72, 6);
  tablePole.translate(0, 0.36, 0);
  parts.push(colored(tablePole, 0x3a3a3a));

  const umbPole = new THREE.CylinderGeometry(0.045, 0.045, 2.15, 6);
  umbPole.translate(0, 1.075, 0);
  parts.push(colored(umbPole, 0x6b5a44));

  for (const dz of [-0.72, 0.72]) {
    const seat = new THREE.BoxGeometry(0.42, 0.08, 0.42);
    seat.translate(0, 0.46, dz);
    parts.push(colored(seat, 0x4b5560));
    const legs = new THREE.BoxGeometry(0.4, 0.46, 0.4);
    legs.translate(0, 0.23, dz);
    parts.push(colored(legs, 0x39424c));
  }

  _furnitureGeo = mergeGeometries(parts, false);
  return _furnitureGeo;
}

function buildCanopyGeo() {
  if (_canopyGeo) return _canopyGeo;
  const cone = new THREE.ConeGeometry(1.15, 0.42, 8);
  cone.translate(0, 2.26, 0);   // base ring ≈ 2.05 (sits on the umbrella-pole top ~2.15)
  _canopyGeo = cone;
  return _canopyGeo;
}

let _furnMat = null, _canopyMat = null;
function getFurnitureMaterial() {
  if (!_furnMat) _furnMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _furnMat;
}
function getCanopyMaterial() {
  if (!_canopyMat) _canopyMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  return _canopyMat;
}

/**
 * @param {Array<{footprint:{x:number,y:number}[], height?:number}>} buildings
 * @param {{ getElevationAt?: (lat:number,lon:number)=>number|null, vertExag?: number }} opts
 * @returns {THREE.InstancedMesh[]|null}
 */
/** Shortest distance from a point to any road's carriageway edge (negative-ish → on the road). */
function tooCloseToRoad(px, pz, roads) {
  if (!roads) return false;
  for (const r of roads) {
    const pts = r.points;
    if (!pts || pts.length < 2 || r.bridge) continue;
    const halfW = (Number.isFinite(r.width) && r.width > 0 ? r.width : 6) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y, bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
      const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
      if (d < halfW + 0.8) return true;   // table would sit on the carriageway
    }
  }
  return false;
}

export function buildCafeTerrace(buildings, opts = {}) {
  if (!buildings || !buildings.length) return null;
  const getElevationAt = opts.getElevationAt;
  const vertExag = Number.isFinite(opts.vertExag) ? opts.vertExag : 1;
  const roads = opts.roads;

  const matrices = [];
  const colorIdx = [];
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const YAXIS = new THREE.Vector3(0, 1, 0);

  let seed = 0x9e3779b9 >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (const b of buildings) {
    if (matrices.length >= TABLE_CAP) break;
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    if ((b.height || 6) < 4) continue;

    // longest edge + centroid (same selection as awnings / shop signs)
    let bestLen = 0, bi = -1, cx = 0, cz = 0;
    for (const p of fp) { cx += p.x; cz += p.y; }
    cx /= fp.length; cz /= fp.length;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length];
      const dx = c.x - a.x, dz = c.y - a.y;
      const l = dx * dx + dz * dz;
      if (l > bestLen) { bestLen = l; bi = i; }
    }
    const edgeLen = Math.sqrt(bestLen);
    if (bi < 0 || edgeLen < MIN_EDGE) continue;
    if (rand() > CAFE_CHANCE) continue;   // only some buildings are cafés

    const a = fp[bi], c = fp[(bi + 1) % fp.length];
    let dx = c.x - a.x, dz = c.y - a.y;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    let nx = dz, nz = -dx;
    const mx = (a.x + c.x) / 2, mz = (a.y + c.y) / 2;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }

    let groundY = 0;
    if (getElevationAt) {
      const { lat, lon } = worldToLatLon(mx, mz);
      groundY = (getElevationAt(lat, lon) ?? 0) * vertExag;
    }

    const usable = edgeLen - 2.0;
    const n = Math.max(1, Math.min(4, Math.floor(usable / TABLE_GAP)));
    const rowLen = (n - 1) * TABLE_GAP;
    let t = (edgeLen - rowLen) / 2;

    for (let s = 0; s < n && matrices.length < TABLE_CAP; s++, t += TABLE_GAP) {
      const jitterAlong = (rand() - 0.5) * 0.4;
      const jitterOut = (rand() - 0.5) * 0.3;
      const off = SIDEWALK_OFFSET + jitterOut;
      const px = a.x + dx * (t + jitterAlong) + nx * off;
      const pz = a.y + dz * (t + jitterAlong) + nz * off;
      if (tooCloseToRoad(px, pz, roads)) continue;   // don't spill tables onto a narrow street's carriageway
      _p.set(px, groundY, pz);
      _q.setFromAxisAngle(YAXIS, rand() * Math.PI * 2);
      _m.compose(_p, _q, _s);
      matrices.push(_m.clone());
      colorIdx.push((rand() * CANOPY_COLORS.length) | 0);
    }
  }

  if (!matrices.length) return null;

  const furniture = new THREE.InstancedMesh(buildFurnitureGeo(), getFurnitureMaterial(), matrices.length);
  const canopies = new THREE.InstancedMesh(buildCanopyGeo(), getCanopyMaterial(), matrices.length);
  const _col = new THREE.Color();
  for (let i = 0; i < matrices.length; i++) {
    furniture.setMatrixAt(i, matrices[i]);
    canopies.setMatrixAt(i, matrices[i]);
    canopies.setColorAt(i, _col.setHex(CANOPY_COLORS[colorIdx[i]]));
  }
  furniture.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;

  for (const mesh of [furniture, canopies]) {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // v3 P0-17: frustum culling was OFF because three never computes an InstancedMesh's bounds
    // automatically ("must be called by your app" — InstancedMesh.js:122), so culling would have
    // used the base geometry's tiny origin sphere and wrongly culled the whole tile's terraces.
    // Computing it from the instance matrices makes culling correct, so it can be enabled.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    // geometry + material are module-level singletons shared across all tiles — don't dispose on unload
    mesh.userData = { type: 'cafeTerrace', sharedGeometry: true, sharedMaterial: true };
  }
  return [furniture, canopies];
}

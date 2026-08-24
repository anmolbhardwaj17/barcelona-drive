/**
 * Procedural concrete median dividers on wide roads (≥ 12 m).
 * Uses InstancedMesh with shared geometry + material for minimal draw calls.
 */
import * as THREE from 'three';

const DIVIDER_LENGTH = 3;       // m per segment
const DIVIDER_WIDTH  = 0.6;     // m
const DIVIDER_HEIGHT = 0.8;     // m
const DIVIDER_MIN_ROAD_WIDTH = 12;
const DIVIDER_JUNCTION_SKIP  = 8;  // m gap near junctions
const LAYER_HEIGHT_STEP = 6;

/** Type-based widths match roadRenderer's visual widths (fallback when OSM width tag absent). */
const ROAD_WIDTHS_BY_TYPE = {
  motorway: 15, trunk: 12, primary: 10, secondary: 8,
  tertiary: 7, residential: 6, service: 5, unclassified: 6,
};

function getRoadWidth(road) {
  const osm = Number(road.width);
  if (osm > 0) return Math.min(30, osm);
  return ROAD_WIDTHS_BY_TYPE[road.highwayType] || 6;
}

// Shared resources (created once on first use)
let sharedDividerGeom = null;
let sharedDividerMat  = null;

const DIVIDER_COLOR_DAY   = 0xb0a898; // concrete tan
const DIVIDER_COLOR_NIGHT = 0x484440; // darker at night — concrete is not self-lit

/** Dim/restore divider color when toggling day ↔ night (shared MeshStandardMaterial). */
export function setDividerNightMode(isNight) {
  if (sharedDividerMat) {
    sharedDividerMat.color.set(isNight ? DIVIDER_COLOR_NIGHT : DIVIDER_COLOR_DAY);
  }
}

function getSharedResources() {
  if (!sharedDividerGeom) {
    sharedDividerGeom = new THREE.BoxGeometry(DIVIDER_LENGTH, DIVIDER_HEIGHT, DIVIDER_WIDTH);
    sharedDividerGeom.userData.sharedGeometry = true;
  }
  if (!sharedDividerMat) {
    sharedDividerMat = new THREE.MeshStandardMaterial({ color: 0xb0a898, roughness: 0.9, metalness: 0 });
    sharedDividerMat.userData.sharedMaterial = true;
  }
  return { geom: sharedDividerGeom, mat: sharedDividerMat };
}

/**
 * Parameterise a polyline by arc length; emit a sample every `step` metres.
 * Points use tile-data convention: p.x = world X, p.y = world Z.
 * @returns {{ x: number, z: number, tx: number, tz: number }[]}
 */
function walkPolyline(points, step) {
  const result = [];
  if (!points || points.length < 2) return result;

  let distAlongLine = 0;
  let nextEmit = step * 0.5; // first sample at half-step into polyline

  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x,   az = points[i].y;
    const bx = points[i+1].x, bz = points[i+1].y;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) continue;
    const ux = dx / len, uz = dz / len;

    const eA = points[i].elevation ?? 0;
    const eB = points[i+1].elevation ?? 0;
    while (nextEmit <= distAlongLine + len) {
      const t = (nextEmit - distAlongLine) / len;
      result.push({ x: ax + t * dx, z: az + t * dz, tx: ux, tz: uz, elevation: eA + t * (eB - eA) });
      nextEmit += step;
    }
    distAlongLine += len;
  }
  return result;
}

function isNearJunction(x, z, junctionPoints, skipDist) {
  const skipSq = skipDist * skipDist;
  for (const jp of junctionPoints) {
    if ((x - jp.x) ** 2 + (z - jp.z) ** 2 < skipSq) return true;
  }
  return false;
}

/**
 * Build an InstancedMesh of concrete dividers for all wide roads in this tile.
 * @param {object[]} roads
 * @param {{ x: number, z: number }[]} junctionPoints
 * @returns {THREE.InstancedMesh | null}
 */
export function buildDividers(roads, junctionPoints) {
  const { geom, mat } = getSharedResources();

  const instances = []; // { x, z, tangentAngle, baseY }

  for (const road of roads || []) {
    if (getRoadWidth(road) < DIVIDER_MIN_ROAD_WIDTH) continue;
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;

    const samples = walkPolyline(road.points, DIVIDER_LENGTH);
    for (const s of samples) {
      if (isNearJunction(s.x, s.z, junctionPoints, DIVIDER_JUNCTION_SKIP)) continue;
      instances.push({
        x: s.x,
        z: s.z,
        tangentAngle: Math.atan2(-s.tz, s.tx),
        baseY: s.elevation != null ? s.elevation : layer * LAYER_HEIGHT_STEP,
      });
    }
  }

  if (instances.length === 0) return null;

  const mesh = new THREE.InstancedMesh(geom, mat, instances.length);
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _axisY = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < instances.length; i++) {
    const { x, z, tangentAngle, baseY } = instances[i];
    _pos.set(x, baseY + DIVIDER_HEIGHT * 0.5, z);
    _q.setFromAxisAngle(_axisY, tangentAngle);
    _m.compose(_pos, _q, _scale);
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

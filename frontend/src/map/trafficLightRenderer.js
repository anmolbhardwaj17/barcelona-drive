/**
 * Traffic lights (visual only) at intersections. No logic or physics.
 * Disabled by default; set CONFIG.ENABLE_TRAFFIC_LIGHTS to true to enable.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const MAX_PER_TILE = 20;
const ENDPOINT_TOLERANCE = 2;
const POLE_HEIGHT = 4;
const POLE_RADIUS = 0.06;
const BOX_WIDTH = 0.5;
const BOX_HEIGHT = 0.3;
const BOX_DEPTH = 0.2;

function hashPoint(x, z, tol) {
  const g = 1 / (tol || 1);
  return `${Math.floor(x * g)}_${Math.floor(z * g)}`;
}

/**
 * Find intersection points: endpoints shared by at least two road segments.
 * @param {object[]} roads
 * @returns {{ x: number, z: number }[]}
 */
function findIntersectionCorners(roads) {
  const byHash = new Map();
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const h = hashPoint(p.x, p.y, ENDPOINT_TOLERANCE);
      if (!byHash.has(h)) byHash.set(h, { x: p.x, z: p.y, count: 0 });
      byHash.get(h).count += 1;
    }
  }
  const corners = [];
  for (const v of byHash.values()) {
    if (v.count >= 2) corners.push({ x: v.x, z: v.z });
  }
  return corners.slice(0, MAX_PER_TILE);
}

function createTrafficLightGeometry() {
  const pole = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.1, POLE_HEIGHT, 6);
  pole.translate(0, POLE_HEIGHT / 2, 0);
  const box = new THREE.BoxGeometry(BOX_WIDTH, BOX_HEIGHT, BOX_DEPTH);
  box.translate(0, POLE_HEIGHT, 0);
  const merged = mergeGeometries([pole, box]);
  pole.dispose();
  box.dispose();
  return merged;
}

let sharedGeometry = null;
let sharedMaterial = null;

function getSharedResources() {
  if (!sharedGeometry) sharedGeometry = createTrafficLightGeometry();
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshLambertMaterial({
      color: 0x333333,
      roughness: 0.8,
      metalness: 0,
    });
  }
  return { geometry: sharedGeometry, material: sharedMaterial };
}

/**
 * Render traffic light meshes for a tile. Visual only; no logic.
 * @param {object} tileData - { roads }
 * @param {string} [tileKey]
 * @returns {THREE.InstancedMesh|null}
 */
export function renderTrafficLights(tileData, tileKey) {
  if (!CONFIG.ENABLE_TRAFFIC_LIGHTS) return null;
  const corners = findIntersectionCorners(tileData?.roads || []);
  if (corners.length === 0) return null;

  const { geometry, material } = getSharedResources();
  const mesh = new THREE.InstancedMesh(geometry, material, corners.length);
  mesh.count = corners.length;
  mesh.frustumCulled = true;
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);

  const groundHeight = 0;
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    position.set(c.x, groundHeight, c.z);
    quat.identity();
    matrix.compose(position, quat, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

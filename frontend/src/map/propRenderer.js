/**
 * Small environment props (rocks, bushes, grass clusters) scattered on terrain via instancing.
 * Avoids roads, water, and buildings. Lightweight low-poly geometry, no textures.
 * Returns a THREE.Group containing one InstancedMesh per prop type.
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { latLonToWorld, worldToLatLon } from '../projection.js';
import { isVegetationAllowed, isInsideOrNearBuilding } from './vegetationMask.js';

// ---------------------------------------------------------------------------
// Density budget per tile
// ---------------------------------------------------------------------------
const ROCKS_PER_TILE     = 150;
const BUSHES_PER_TILE    = 200;
const GRASS_PER_TILE     = 300;
const MAX_ATTEMPTS_MULT  = 8; // attempts = budget * this

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------
function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}


// ---------------------------------------------------------------------------
// Shared geometries (created once, reused across all tiles)
// ---------------------------------------------------------------------------

// rock_01: small flat stone (dodecahedron squashed)
let _rock01Geo = null;
function getRock01Geo() {
  if (_rock01Geo) return _rock01Geo;
  _rock01Geo = new THREE.DodecahedronGeometry(0.3, 0);
  const pos = _rock01Geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * 0.4);
  pos.needsUpdate = true;
  _rock01Geo.computeVertexNormals();
  _rock01Geo.computeBoundingBox();
  _rock01Geo.translate(0, -_rock01Geo.boundingBox.min.y, 0);
  return _rock01Geo;
}

// rock_02: rounder boulder (icosahedron with vertex jitter)
let _rock02Geo = null;
function getRock02Geo() {
  if (_rock02Geo) return _rock02Geo;
  _rock02Geo = new THREE.IcosahedronGeometry(0.35, 0);
  const pos = _rock02Geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const jitter = 0.85 + Math.sin(i * 7.31) * 0.15;
    pos.setX(i, pos.getX(i) * jitter);
    pos.setY(i, pos.getY(i) * (0.5 + Math.sin(i * 3.17) * 0.15));
    pos.setZ(i, pos.getZ(i) * jitter);
  }
  pos.needsUpdate = true;
  _rock02Geo.computeVertexNormals();
  _rock02Geo.computeBoundingBox();
  _rock02Geo.translate(0, -_rock02Geo.boundingBox.min.y, 0);
  return _rock02Geo;
}

// bush_01: small sphere cluster
let _bushGeo = null;
function getBushGeo() {
  if (_bushGeo) return _bushGeo;
  _bushGeo = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = _bushGeo.getAttribute('position');
  // Flatten bottom half and add slight random distortion
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) pos.setY(i, y * 0.3); // flatten bottom
    const jitter = 1.0 + Math.sin(i * 5.13) * 0.12;
    pos.setX(i, pos.getX(i) * jitter);
    pos.setZ(i, pos.getZ(i) * jitter);
  }
  pos.needsUpdate = true;
  _bushGeo.computeVertexNormals();
  _bushGeo.computeBoundingBox();
  _bushGeo.translate(0, -_bushGeo.boundingBox.min.y, 0);
  return _bushGeo;
}

// grass_cluster: two crossed triangle planes
let _grassGeo = null;
function getGrassGeo() {
  if (_grassGeo) return _grassGeo;
  const verts = new Float32Array([
    // Plane 1 (XY)
    -0.3, 0, 0,   0.3, 0, 0,   0.0, 0.6, 0,
    0.3, 0, 0,   -0.3, 0, 0,   0.0, 0.6, 0,
    // Plane 2 (ZY, rotated 90)
    0, 0, -0.3,   0, 0, 0.3,   0, 0.6, 0,
    0, 0, 0.3,   0, 0, -0.3,   0, 0.6, 0,
  ]);
  _grassGeo = new THREE.BufferGeometry();
  _grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  _grassGeo.computeVertexNormals();
  return _grassGeo;
}

// ---------------------------------------------------------------------------
// Shared materials (created once)
// ---------------------------------------------------------------------------
let _rockMat = null;
function getRockMat() {
  if (_rockMat) return _rockMat;
  _rockMat = new THREE.MeshLambertMaterial({ color: 0x8a8578 });
  return _rockMat;
}

let _bushMat = null;
function getBushMat() {
  if (_bushMat) return _bushMat;
  _bushMat = new THREE.MeshLambertMaterial({ color: 0x3d6b2e });
  return _bushMat;
}

let _grassMat = null;
function getGrassMat() {
  if (_grassMat) return _grassMat;
  _grassMat = new THREE.MeshLambertMaterial({
    color: 0x5a8a3c,
    side: THREE.DoubleSide,
  });
  return _grassMat;
}

// ---------------------------------------------------------------------------
// Position scattering
// ---------------------------------------------------------------------------

/**
 * Scatter candidate positions within a tile's world-space bounds.
 * @param {number} count - target number of positions
 * @param {number} minX
 * @param {number} maxX
 * @param {number} minZ
 * @param {number} maxZ
 * @param {number} seed - tile seed
 * @param {number} seedOffset - offset to differentiate prop types
 * @param {number} placementChance - 0-1, fraction of attempts that pass random gate
 * @param {object[]} roads
 * @param {object[]} buildings
 * @param {object[]} waterAreas
 * @param {number} roadMargin - clearance from road edges
 * @returns {{ x: number, z: number }[]}
 */
function scatterPositions(count, minX, maxX, minZ, maxZ, seed, seedOffset,
                          placementChance, buildings, roadMargin, vegMask) {
  const positions = [];
  const maxAttempts = count * MAX_ATTEMPTS_MULT;
  let idx = 0;
  while (positions.length < count && idx < maxAttempts) {
    const wx = minX + seeded(idx, seed + seedOffset) * (maxX - minX);
    const wz = minZ + seeded(idx, seed + seedOffset + 1) * (maxZ - minZ);
    idx++;
    if (seeded(idx, seed + seedOffset + 2) > placementChance) continue;
    if (!isVegetationAllowed(vegMask, wx, wz, roadMargin)) continue;
    if (isInsideOrNearBuilding(wx, wz, buildings, 0)) continue;
    positions.push({ x: wx, z: wz });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Instanced mesh builders
// ---------------------------------------------------------------------------

function buildInstancedMesh(geometry, material, positions, seed, seedOffset,
                            getElevationAt, vertExag, scaleRange, ySquashRange) {
  if (positions.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  mesh.count = positions.length;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;

  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    let y = 0;
    if (getElevationAt) {
      const ll = worldToLatLon(p.x, p.z);
      y = (getElevationAt(ll.lat, ll.lon) ?? 0) * vertExag;
    }
    const s = scaleRange[0] + seeded(i, seed + seedOffset) * (scaleRange[1] - scaleRange[0]);
    const rotY = seeded(i, seed + seedOffset + 1) * Math.PI * 2;
    const tiltX = (seeded(i, seed + seedOffset + 2) - 0.5) * 0.25;
    const tiltZ = (seeded(i, seed + seedOffset + 3) - 0.5) * 0.25;
    const ySquash = ySquashRange
      ? ySquashRange[0] + seeded(i, seed + seedOffset + 4) * (ySquashRange[1] - ySquashRange[0])
      : 1;

    pos.set(p.x, y, p.z);
    quat.setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ, 'XYZ'));
    scl.set(s, s * ySquash, s);
    mat4.compose(pos, quat, scl);
    mesh.setMatrixAt(i, mat4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scatter small environment props on terrain for a tile.
 * @param {object} tileData - { roads, buildings, water, elevation }
 * @param {string} tileKey
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} options
 * @returns {THREE.Group | null}
 */
export function renderProps(tileData, tileKey, options) {
  const buildings = tileData.buildings || [];
  const getElevationAt = options?.getElevationAt;
  const vegMask = options?.vegetationMask || null;
  const elevation = tileData.elevation;
  if (!elevation) return null;

  const { south, west, north, east } = elevation;
  const sw = latLonToWorld(south, west);
  const ne = latLonToWorld(north, east);
  const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
  const minZ = Math.min(sw.z, ne.z), maxZ = Math.max(sw.z, ne.z);

  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const group = new THREE.Group();
  let added = false;

  // --- rock_01: flat stones, scattered wide ---
  const rock01Pos = scatterPositions(
    Math.floor(ROCKS_PER_TILE * 0.5), minX, maxX, minZ, maxZ,
    seed, 10, 0.25, buildings, 8, vegMask
  );
  const rock01Mesh = buildInstancedMesh(
    getRock01Geo(), getRockMat(), rock01Pos, seed, 20,
    getElevationAt, vertExag, [0.6, 2.5], [0.4, 0.8]
  );
  if (rock01Mesh) { group.add(rock01Mesh); added = true; }

  // --- rock_02: rounder boulders, fewer ---
  const rock02Pos = scatterPositions(
    Math.floor(ROCKS_PER_TILE * 0.5), minX, maxX, minZ, maxZ,
    seed, 30, 0.20, buildings, 8, vegMask
  );
  const rock02Mesh = buildInstancedMesh(
    getRock02Geo(), getRockMat(), rock02Pos, seed, 40,
    getElevationAt, vertExag, [0.5, 2.0], [0.5, 1.0]
  );
  if (rock02Mesh) { group.add(rock02Mesh); added = true; }

  // --- bush_01: small green bushes ---
  const bushPos = scatterPositions(
    BUSHES_PER_TILE, minX, maxX, minZ, maxZ,
    seed, 50, 0.30, buildings, 6, vegMask
  );
  const bushMesh = buildInstancedMesh(
    getBushGeo(), getBushMat(), bushPos, seed, 60,
    getElevationAt, vertExag, [0.4, 1.2], [0.6, 1.0]
  );
  if (bushMesh) { group.add(bushMesh); added = true; }

  // --- grass_cluster: small crossed triangle tufts ---
  const grassPos = scatterPositions(
    GRASS_PER_TILE, minX, maxX, minZ, maxZ,
    seed, 70, 0.40, buildings, 4, vegMask
  );
  const grassMesh = buildInstancedMesh(
    getGrassGeo(), getGrassMat(), grassPos, seed, 80,
    getElevationAt, vertExag, [0.6, 1.5], null
  );
  if (grassMesh) { group.add(grassMesh); added = true; }

  return added ? group : null;
}

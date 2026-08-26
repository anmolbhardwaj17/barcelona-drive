/**
 * Environment filler clusters: groups of rocks + bushes placed in large empty
 * green terrain areas. Two shared InstancedMeshes per tile (rocks + bushes).
 * 5 cluster templates with randomised rotation/scale for natural variety.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { isVegetationAllowed, isInsideOrNearBuilding } from './vegetationMask.js';
import { getTreeGeometries, getTreeMaterial, getBushGeometry, getBushMaterial } from './vegetationRenderer.js';
import { classifySpecies as classifyTreeSpecies } from './treeSpeciesSets.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (same as vegetationRenderer)
// ---------------------------------------------------------------------------
function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Shared geometry / materials (lazy-init, cached globally)
// ---------------------------------------------------------------------------
let _rockGeo = null;
let _rockMat = null;
function getRockGeometry() {
  if (_rockGeo) return _rockGeo;
  _rockGeo = new THREE.IcosahedronGeometry(1, 0); // 20 tris (was detail 1 = 80); the per-vertex distortion below still reads as an organic rock
  // Distort vertices for organic look
  const pos = _rockGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
    const noise = 0.8 + Math.abs(Math.sin(nx * 5.1 + ny * 3.7) * Math.cos(nz * 4.3 + nx * 2.1)) * 0.4;
    pos.setXYZ(i, nx * noise, ny * noise * 0.6, nz * noise);
  }
  _rockGeo.translate(0, 0.3, 0);
  _rockGeo.computeVertexNormals();
  return _rockGeo;
}

function getRockMaterial() {
  if (_rockMat) return _rockMat;
  _rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return _rockMat;
}

/**
 * Tree geometry for a background/hillside cluster item.
 *
 * v3 P3-10 follow-up: this used to be a straight `variantIdx % geos.length`, i.e. uniform random
 * across all six card species — which put Washingtonia palms and bitter-orange ornamentals on
 * Collserola hillsides. Cluster trees are wild broadleaf, so they classify under the 'hill' set.
 * On the blob path classifySpecies returns the modulo untouched, so nothing changes there.
 */
function getClusterTreeGeometry(variantIdx) {
  const geos = getTreeGeometries();
  return geos[classifyTreeSpecies('hill', variantIdx, 85, geos.length, variantIdx)];
}

// ---------------------------------------------------------------------------
// Cluster templates
// Offsets are relative to cluster center. type: 'rock' | 'bush' | 'tree'
// ---------------------------------------------------------------------------
const CLUSTER_TEMPLATES = [
  { // A: large rock + 3 bushes
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 1.8 },
      { type: 'bush', dx: 2.2, dz: 0.8, scale: 1.1 },
      { type: 'bush', dx: -1.8, dz: 1.4, scale: 0.9 },
      { type: 'bush', dx: 0.5, dz: -2.0, scale: 1.0 },
    ],
  },
  { // B: 2 medium rocks + bushes
    items: [
      { type: 'rock', dx: -1.2, dz: 0.5, scale: 1.3 },
      { type: 'rock', dx: 1.5, dz: -0.8, scale: 1.1 },
      { type: 'bush', dx: 0, dz: 1.8, scale: 1.0 },
      { type: 'bush', dx: -0.5, dz: -1.5, scale: 0.8 },
    ],
  },
  { // C: small tree + 2 bushes + 1 rock
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.0 },
      { type: 'bush', dx: 1.8, dz: 0.6, scale: 1.0 },
      { type: 'bush', dx: -1.5, dz: 1.2, scale: 0.9 },
      { type: 'rock', dx: 1.0, dz: -1.6, scale: 0.9 },
    ],
  },
  { // D: 3 bushes
    items: [
      { type: 'bush', dx: 0, dz: 0, scale: 1.3 },
      { type: 'bush', dx: 1.6, dz: 1.0, scale: 1.0 },
      { type: 'bush', dx: -1.2, dz: 0.8, scale: 1.1 },
    ],
  },
  { // E: single large rock with bushes around it
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 2.2 },
      { type: 'bush', dx: 2.5, dz: 0, scale: 1.0 },
      { type: 'bush', dx: -2.0, dz: 1.5, scale: 0.9 },
      { type: 'bush', dx: 0.8, dz: -2.2, scale: 1.1 },
      { type: 'bush', dx: -1.0, dz: -1.8, scale: 0.8 },
    ],
  },
  { // F: tree + rocks + bushes — Delhi roadside style
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.2 },
      { type: 'rock', dx: 1.5, dz: 1.0, scale: 1.0 },
      { type: 'rock', dx: -1.0, dz: -1.5, scale: 0.7 },
      { type: 'bush', dx: 2.0, dz: -0.5, scale: 1.0 },
      { type: 'bush', dx: -2.2, dz: 0.8, scale: 1.1 },
      { type: 'bush', dx: 0.5, dz: 2.0, scale: 0.8 },
    ],
  },
  { // G: scattered rocks with bushes between — rubble patch
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 1.5 },
      { type: 'rock', dx: 2.0, dz: 1.2, scale: 0.8 },
      { type: 'rock', dx: -1.5, dz: -1.0, scale: 1.0 },
      { type: 'rock', dx: 0.8, dz: -2.0, scale: 0.6 },
      { type: 'bush', dx: 1.0, dz: 0.5, scale: 0.9 },
      { type: 'bush', dx: -0.8, dz: 1.5, scale: 1.0 },
    ],
  },
  { // H: twin trees + rock border — mini grove
    items: [
      { type: 'tree', dx: -1.5, dz: 0, scale: 1.0 },
      { type: 'tree', dx: 1.5, dz: 0, scale: 0.9 },
      { type: 'rock', dx: 0, dz: 2.0, scale: 1.2 },
      { type: 'bush', dx: 0, dz: -1.8, scale: 1.1 },
      { type: 'bush', dx: -2.5, dz: 1.2, scale: 0.9 },
      { type: 'bush', dx: 2.5, dz: 1.2, scale: 0.8 },
    ],
  },
];

const CLUSTER_SPACING = 25;   // metres between cluster centres
const MAX_CLUSTERS_PER_TILE = 120;
const GATE_CLUSTER_OFFSET = 6;  // metres from gate centre to place flanking clusters

// ---------------------------------------------------------------------------
// Placement — scatter across open terrain (bbox from tile data)
// ---------------------------------------------------------------------------

/** Derive bounding box from all road/building points in the tile. */
function getTileBbox(tileData) {
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const road of tileData.roads || []) {
    for (const p of road.points || []) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
    }
  }
  for (const b of tileData.buildings || []) {
    for (const p of b.footprint || []) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
    }
  }
  if (!Number.isFinite(mnX)) return null;
  return { mnX, mxX, mnZ, mxZ };
}

function findClusterCenters(tileData, tileKey, vegMask) {
  const bbox = getTileBbox(tileData);
  if (!bbox) return [];

  const buildings = tileData.buildings || [];
  const centers = [];
  const globalSeed = ((tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) * 17) + 41;

  const tileW = bbox.mxX - bbox.mnX;
  const tileH = bbox.mxZ - bbox.mnZ;
  const tileArea = tileW * tileH;
  const maxClusters = Math.min(Math.floor(tileArea / (CLUSTER_SPACING * CLUSTER_SPACING)), MAX_CLUSTERS_PER_TILE);
  let attempts = maxClusters * 10;

  while (centers.length < maxClusters && attempts-- > 0) {
    const idx = centers.length + attempts;
    const x = bbox.mnX + seeded(idx, globalSeed) * tileW;
    const z = bbox.mnZ + seeded(idx, globalSeed + 1) * tileH;

    if (!isVegetationAllowed(vegMask, x, z, 6)) continue;
    if (isInsideOrNearBuilding(x, z, buildings, 6)) continue;

    // Check spacing against existing centers
    let tooClose = false;
    for (const c of centers) {
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < CLUSTER_SPACING * CLUSTER_SPACING * 0.7) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const templateIdx = Math.floor(seeded(idx, globalSeed + 2) * CLUSTER_TEMPLATES.length) % CLUSTER_TEMPLATES.length;
    centers.push({ x, z, templateIdx });
  }

  return centers;
}

// ---------------------------------------------------------------------------
// Gate-adjacent clusters — flanking decorative clusters near barrier gates
// ---------------------------------------------------------------------------

/** Detect road crossings along a barrier segment (same logic as barrierRenderer). */
function barrierRoadCrossings(wx0, wz0, wx1, wz1, roads) {
  const ts = [];
  const wdx = wx1 - wx0, wdz = wz1 - wz0;
  for (const road of roads) {
    const pts = road.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const rdx = pts[i + 1].x - pts[i].x;
      const rdz = pts[i + 1].y - pts[i].y;
      const denom = wdx * rdz - wdz * rdx;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((pts[i].x - wx0) * rdz - (pts[i].y - wz0) * rdx) / denom;
      const u = ((pts[i].x - wx0) * wdz - (pts[i].y - wz0) * wdx) / denom;
      if (t > 0.01 && t < 0.99 && u >= -0.1 && u <= 1.1) ts.push(t);
    }
  }
  return ts;
}

/** Collect gate positions from barrier data. Returns [{x, z, perpX, perpZ}]. */
function collectGatePositions(tileData) {
  const barriers = tileData.barriers || [];
  const roads = tileData.roads || [];
  const gates = [];

  for (const barrier of barriers) {
    const pts = barrier.points || [];
    if (pts.length < 2) continue;

    // Explicit gates from OSM data
    const explicitGates = barrier.gates || [];

    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][1];
      const bx = pts[i + 1][0], bz = pts[i + 1][1];
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;
      const dirX = dx / segLen, dirZ = dz / segLen;
      const perpX = -dirZ, perpZ = dirX;

      // Road crossings as gate positions
      for (const t of barrierRoadCrossings(ax, az, bx, bz, roads)) {
        gates.push({
          x: ax + t * dx,
          z: az + t * dz,
          perpX, perpZ,
        });
      }

      // Explicit gate nodes that project onto this segment
      for (const [gx, gz] of explicitGates) {
        const t = segLen > 1e-6 ? ((gx - ax) * dx + (gz - az) * dz) / (segLen * segLen) : -1;
        if (t >= 0 && t <= 1) {
          gates.push({ x: gx, z: gz, perpX, perpZ });
        }
      }
    }
  }
  return gates;
}

/**
 * Place clusters flanking each gate opening (bush-heavy templates D or E).
 */
function findGateAdjacentClusters(tileData, vegMask) {
  const gatePositions = collectGatePositions(tileData);
  const buildings = tileData.buildings || [];
  const centers = [];

  for (let gi = 0; gi < gatePositions.length; gi++) {
    const gp = gatePositions[gi];
    // Place a cluster on each side of the gate (along the perpendicular = into/out of the compound)
    for (const side of [1, -1]) {
      const cx = gp.x + gp.perpX * GATE_CLUSTER_OFFSET * side;
      const cz = gp.z + gp.perpZ * GATE_CLUSTER_OFFSET * side;

      if (!isVegetationAllowed(vegMask, cx, cz, 4)) continue;
      if (isInsideOrNearBuilding(cx, cz, buildings, 3)) continue;

      // Use bush-heavy templates (D=3, E=4)
      const templateIdx = (gi + side) % 2 === 0 ? 3 : 4;
      centers.push({ x: cx, z: cz, templateIdx });
    }
  }
  return centers;
}

// ---------------------------------------------------------------------------
// InstancedMesh builders
// ---------------------------------------------------------------------------

/**
 * @param {object} tileData
 * @param {string} tileKey
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {THREE.Mesh[]}
 */
export function renderEnvironmentClusters(tileData, tileKey, options) {
  const vegMask = options?.vegetationMask || null;
  const centers = findClusterCenters(tileData, tileKey, vegMask);

  // Add gate-adjacent clusters
  const gateClusters = findGateAdjacentClusters(tileData, vegMask);
  for (const gc of gateClusters) centers.push(gc);

  if (centers.length === 0) return [];

  const getElevationAt = options?.getElevationAt;
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // Tile elevation footprint. Cluster centers are scattered across a bbox built from road/building
  // points that include CLIPPED roads overhanging the tile by 200-460 m (e.g. the long Ronda de Dalt
  // ramps). For an item landing outside this footprint, getElevationAt CLAMPS the sample to the edge
  // elevation — on a hillside that holds the high edge value while the real (neighbor-tile) terrain
  // drops away downhill, so the bush hangs in mid-air in a horizontal line. That terrain belongs to
  // the neighbour tile (which places its own vegetation), so skip any item outside these bounds.
  const _e = tileData?.elevation;
  const tileBounds = (_e && Number.isFinite(_e.south) && Number.isFinite(_e.north) && Number.isFinite(_e.west) && Number.isFinite(_e.east))
    ? { south: _e.south, north: _e.north, west: _e.west, east: _e.east } : null;

  // Collect all instance transforms per type
  const rockInstances = [];  // { x, y, z, scale, rotY }
  const bushInstances = [];
  const treeInstances = [];

  for (let ci = 0; ci < centers.length; ci++) {
    const c = centers[ci];
    const template = CLUSTER_TEMPLATES[c.templateIdx];
    // Cluster-level random rotation
    const clusterRot = seeded(ci, 50) * Math.PI * 2;
    const cos = Math.cos(clusterRot), sin = Math.sin(clusterRot);
    // Cluster-level scale jitter: 0.85–1.15
    const clusterScale = 0.85 + seeded(ci, 51) * 0.3;

    for (let ii = 0; ii < template.items.length; ii++) {
      const item = template.items[ii];
      // Rotate offset around cluster center
      const rx = item.dx * cos - item.dz * sin;
      const rz = item.dx * sin + item.dz * cos;
      const wx = c.x + rx * clusterScale;
      const wz = c.z + rz * clusterScale;

      // Skip items that land on or near roads — strict check per item
      if (!isVegetationAllowed(vegMask, wx, wz, 4)) continue;

      let y = 0;
      if (getElevationAt) {
        const { lat, lon } = worldToLatLon(wx, wz);
        // Outside this tile's elevation footprint → sampling would clamp to the edge (= float). Skip;
        // the neighbour tile owns that ground and places its own vegetation there.
        if (tileBounds && (lat < tileBounds.south || lat > tileBounds.north || lon < tileBounds.west || lon > tileBounds.east)) continue;
        y = (getElevationAt(lat, lon) ?? 0) * vertExag;
      }

      const itemScale = item.scale * clusterScale * (0.9 + seeded(ci * 10 + ii, 52) * 0.2);
      const rotY = seeded(ci * 10 + ii, 53) * Math.PI * 2;

      const inst = { x: wx, y, z: wz, scale: itemScale, rotY };
      if (item.type === 'rock') rockInstances.push(inst);
      else if (item.type === 'bush') bushInstances.push(inst);
      else if (item.type === 'tree') treeInstances.push(inst);
    }
  }

  const meshes = [];
  const baseRockColor = new THREE.Color(0x8a8580);
  const baseBushColor = new THREE.Color(0x4F7D42);

  // Rock InstancedMesh
  if (rockInstances.length > 0) {
    const geo = getRockGeometry();
    const mat = getRockMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, rockInstances.length);
    mesh.count = rockInstances.length;
    mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.sharedGeometry = true;
    mesh.userData.sharedMaterial = true;

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let i = 0; i < rockInstances.length; i++) {
      const r = rockInstances[i];
      p.set(r.x, r.y, r.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rotY);
      // Irregular rock scaling
      const sx = r.scale * (0.8 + seeded(i, 60) * 0.4);
      const sy = r.scale * (0.6 + seeded(i, 61) * 0.4);
      const sz = r.scale * (0.8 + seeded(i, 62) * 0.4);
      s.set(sx, sy, sz);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      // Color variation
      const bright = 0.8 + seeded(i, 63) * 0.3;
      col.copy(baseRockColor).multiplyScalar(bright);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    meshes.push(mesh);
  }

  // Bush InstancedMesh — reuse main vegetation bush geometry/material
  if (bushInstances.length > 0) {
    const geo = getBushGeometry();
    const mat = getBushMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, bushInstances.length);
    mesh.count = bushInstances.length;
    mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.sharedGeometry = true;
    mesh.userData.sharedMaterial = true;

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let i = 0; i < bushInstances.length; i++) {
      const b = bushInstances[i];
      p.set(b.x, b.y, b.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotY);
      const sy = b.scale * (0.7 + seeded(i, 70) * 0.3);
      s.set(b.scale, sy, b.scale);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      const bright = 0.82 + seeded(i, 71) * 0.26;
      col.copy(baseBushColor).multiplyScalar(bright);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    meshes.push(mesh);
  }

  // Tree InstancedMesh — reuse main procedural tree geometries (one mesh per variant)
  if (treeInstances.length > 0) {
    const treeGeos = getTreeGeometries();
    const treeMat = getTreeMaterial();
    const numVariants = treeGeos.length;

    // Group tree instances by species. Hillside and background scatter is wild broadleaf — see
    // getClusterTreeGeometry above for why this is no longer a uniform random pick.
    const buckets = Array.from({ length: numVariants }, () => []);
    for (let i = 0; i < treeInstances.length; i++) {
      const variant = classifyTreeSpecies(
        'hill', i, 85, numVariants, Math.floor(seeded(i, 85) * numVariants));
      buckets[variant].push(treeInstances[i]);
    }

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let vi = 0; vi < numVariants; vi++) {
      const bucket = buckets[vi];
      if (bucket.length === 0) continue;
      const mesh = new THREE.InstancedMesh(treeGeos[vi], treeMat, bucket.length);
      mesh.count = bucket.length;
      mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.sharedGeometry = true;
      mesh.userData.sharedMaterial = true;

      for (let i = 0; i < bucket.length; i++) {
        const t = bucket[i];
        p.set(t.x, t.y, t.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rotY);
        // Smaller scale for cluster trees (0.4–0.7 of template items' scale)
        const sc = t.scale * 0.5;
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        const bright = 0.88 + seeded(i, 80) * 0.24;
        col.setScalar(bright);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    }
  }

  return meshes;
}

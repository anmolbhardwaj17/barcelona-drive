/**
 * Zone-based vegetation renderer: reads tileData.greens polygons and places
 * dense/sparse trees + bushes according to zone type (forest, park, grass, scrub).
 * Additive — runs after base vegetationRenderer. Reuses shared tree geometries.
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { buildProceduralTreeGeometries, getProceduralMaterial } from './vegetationRenderer.js';
import { isVegetationAllowed, isInsideOrNearBuilding } from './vegetationMask.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (same as vegetationRenderer / environmentClusterRenderer)
// ---------------------------------------------------------------------------
function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Geometry helpers (duplicated from vegetationRenderer per project pattern)
// ---------------------------------------------------------------------------
function pointInPolygon(x, z, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].y;
    const xj = polygon[j].x, zj = polygon[j].y;
    if (zi > z !== zj > z && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function polygonAreaXZ(polygon) {
  let area = 0;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
  }
  return Math.abs(area) / 2;
}

// ---------------------------------------------------------------------------
// Polygon format bridge: greens uses [[x,z],...], helpers expect [{x,y},...]
// ---------------------------------------------------------------------------
function toXYPolygon(coords) {
  if (!coords || coords.length < 3) return null;
  // Already {x,y} objects?
  if (typeof coords[0].x === 'number') return coords;
  // Array pairs [x, z]
  return coords.map(c => ({ x: c[0], y: c[1] }));
}

// ---------------------------------------------------------------------------
// Zone type configs
// ---------------------------------------------------------------------------
const ZONE_RULES = {
  forest: {
    treeDensity: 1 / 25,
    treeCap: 600,
    bushDensity: 0,          // bushes only in clearings
    bushCap: 200,
    clearings: true,
    clearingAreaFrac: [0.10, 0.15],
    clearingRadius: [6, 15],
    clearingBushDensity: 1 / 8,
    treeScaleRange: [0.7, 1.3],
  },
  park: {
    treeDensity: 1 / 500,
    treeCap: 250,
    bushDensity: 1 / 200,
    bushCap: 250,
    bushClusterSize: [3, 5],
    boundaryTrees: true,
    boundarySpacing: [6, 10],
    boundaryInset: [2, 3],
    treeScaleRange: [0.8, 1.2],
  },
  garden: {  // treat like park
    treeDensity: 1 / 500,
    treeCap: 200,
    bushDensity: 1 / 200,
    bushCap: 200,
    bushClusterSize: [3, 5],
    boundaryTrees: true,
    boundarySpacing: [6, 10],
    boundaryInset: [2, 3],
    treeScaleRange: [0.7, 1.1],
  },
  grass: {
    treeDensity: 1 / 800,
    treeCap: 200,
    bushDensity: 1 / 150,
    bushCap: 400,
    bushClusterSize: [2, 4],
    treeScaleRange: [0.6, 1.0],
  },
  scrub: {
    treeDensity: 1 / 400,
    treeCap: 200,
    bushDensity: 1 / 50,
    bushCap: 400,
    treeScaleRange: [0.4, 0.8],  // low trees
  },
};

// fallback for playground, generic_green, etc.
const DEFAULT_RULE = {
  treeDensity: 1 / 600,
  treeCap: 150,
  bushDensity: 1 / 200,
  bushCap: 200,
  treeScaleRange: [0.6, 1.0],
};

function getRuleForType(type) {
  return ZONE_RULES[type] || DEFAULT_RULE;
}

// ---------------------------------------------------------------------------
// Scatter helpers
// ---------------------------------------------------------------------------
function polygonBBox(poly) {
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const p of poly) {
    if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
    if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
  }
  return { mnX, mxX, mnZ, mxZ };
}

function scatterInPolygon(poly, density, seed, maxPoints, bbox) {
  const area = polygonAreaXZ(poly);
  const count = Math.min(Math.floor(area * density), maxPoints);
  if (count <= 0) return [];
  const { mnX, mxX, mnZ, mxZ } = bbox || polygonBBox(poly);
  const out = [];
  let tries = count * 50;
  let idx = 0;
  while (out.length < count && tries-- > 0) {
    const x = mnX + seeded(idx + seed, 100) * (mxX - mnX);
    const z = mnZ + seeded(idx + seed, 101) * (mxZ - mnZ);
    idx++;
    if (pointInPolygon(x, z, poly)) out.push({ x, y: z });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forest clearings
// ---------------------------------------------------------------------------
function generateClearings(poly, rule, seed) {
  if (!rule.clearings) return [];
  const area = polygonAreaXZ(poly);
  const [fracLo, fracHi] = rule.clearingAreaFrac;
  const targetArea = area * (fracLo + seeded(seed, 200) * (fracHi - fracLo));
  const [rLo, rHi] = rule.clearingRadius;
  const bbox = polygonBBox(poly);
  const clearings = [];
  let coveredArea = 0;
  let attempts = 200;
  let idx = 0;
  while (coveredArea < targetArea && attempts-- > 0) {
    const cx = bbox.mnX + seeded(idx + seed, 201) * (bbox.mxX - bbox.mnX);
    const cz = bbox.mnZ + seeded(idx + seed, 202) * (bbox.mxZ - bbox.mnZ);
    const r = rLo + seeded(idx + seed, 203) * (rHi - rLo);
    idx++;
    if (!pointInPolygon(cx, cz, poly)) continue;
    clearings.push({ cx, cz, r, rSq: r * r });
    coveredArea += Math.PI * r * r;
  }
  return clearings;
}

function isInClearing(x, z, clearings) {
  for (const c of clearings) {
    if ((x - c.cx) ** 2 + (z - c.cz) ** 2 < c.rSq) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Park boundary trees
// ---------------------------------------------------------------------------
function getBoundaryTreePositions(poly, rule, seed) {
  if (!rule.boundaryTrees) return [];
  const [spaceLo, spaceHi] = rule.boundarySpacing;
  const [insetLo, insetHi] = rule.boundaryInset;
  const positions = [];
  let stepIdx = 0;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // Perpendicular pointing inward (approximate — use polygon winding)
    const nx = -dz / len, nz = dx / len;

    let d = spaceLo * 0.5;
    while (d < len) {
      const s = stepIdx++;
      const spacing = spaceLo + seeded(s + seed, 300) * (spaceHi - spaceLo);
      const t = d / len;
      const px = a.x + dx * t, pz = a.y + dz * t;
      const inset = insetLo + seeded(s + seed, 301) * (insetHi - insetLo);
      // Try inward direction; validate with pointInPolygon
      const tx = px + nx * inset, tz = pz + nz * inset;
      if (pointInPolygon(tx, tz, poly)) {
        positions.push({ x: tx, y: tz });
      } else {
        // Try opposite normal
        const tx2 = px - nx * inset, tz2 = pz - nz * inset;
        if (pointInPolygon(tx2, tz2, poly)) {
          positions.push({ x: tx2, y: tz2 });
        }
      }
      d += spacing;
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Bush cluster placement
// ---------------------------------------------------------------------------
function scatterBushClusters(poly, rule, seed, bbox) {
  const density = rule.bushDensity || 0;
  if (density <= 0) return [];
  const area = polygonAreaXZ(poly);
  const clusterCount = Math.min(Math.floor(area * density), rule.bushCap || 500);
  if (clusterCount <= 0) return [];

  const clusterSize = rule.bushClusterSize || [1, 1];
  const positions = [];
  const { mnX, mxX, mnZ, mxZ } = bbox || polygonBBox(poly);
  let idx = 0;
  let tries = clusterCount * 40;

  while (positions.length < clusterCount && tries-- > 0) {
    const cx = mnX + seeded(idx + seed, 400) * (mxX - mnX);
    const cz = mnZ + seeded(idx + seed, 401) * (mxZ - mnZ);
    idx++;
    if (!pointInPolygon(cx, cz, poly)) continue;
    // Place cluster
    const size = clusterSize[0] + Math.floor(seeded(idx + seed, 402) * (clusterSize[1] - clusterSize[0] + 1));
    for (let j = 0; j < size && positions.length < clusterCount; j++) {
      const bx = cx + (seeded(idx * 7 + j, 403) - 0.5) * 3;
      const bz = cz + (seeded(idx * 7 + j, 404) - 0.5) * 3;
      if (pointInPolygon(bx, bz, poly)) {
        positions.push({ x: bx, y: bz });
      }
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Shared bush geometry / material (matches vegetationRenderer)
// ---------------------------------------------------------------------------
const BUSH_SEGMENTS = 6;
const BUSH_BASE_COLOR = 0x4F7D42;
let _bushGeo = null;
let _bushMat = null;

function getBushGeometry() {
  if (_bushGeo) return _bushGeo;
  _bushGeo = new THREE.SphereGeometry(0.5, BUSH_SEGMENTS, 4);
  _bushGeo.scale(1.4, 0.7, 1.4);
  _bushGeo.translate(0, 0.25, 0);
  return _bushGeo;
}

function getBushMaterial() {
  if (_bushMat) return _bushMat;
  _bushMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return _bushMat;
}

// ---------------------------------------------------------------------------
// Shadow system (reuse same approach as vegetationRenderer)
// ---------------------------------------------------------------------------
const SHADOW_TEX_SIZE = 128;
const SHADOW_Y_OFFSET = 0.02;

let _shadowTex = null;
let _shadowMat = null;
let _shadowGeo = null;

function getShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_TEX_SIZE;
  canvas.height = SHADOW_TEX_SIZE;
  const ctx = canvas.getContext('2d');
  const cx = SHADOW_TEX_SIZE / 2, cy = SHADOW_TEX_SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
  g.addColorStop(0,    'rgba(0,0,0,0.55)');
  g.addColorStop(0.3,  'rgba(0,0,0,0.35)');
  g.addColorStop(0.6,  'rgba(0,0,0,0.15)');
  g.addColorStop(0.85, 'rgba(0,0,0,0.04)');
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SHADOW_TEX_SIZE, SHADOW_TEX_SIZE);
  _shadowTex = new THREE.CanvasTexture(canvas);
  return _shadowTex;
}

function getShadowMaterial() {
  if (_shadowMat) return _shadowMat;
  _shadowMat = new THREE.MeshBasicMaterial({
    map: getShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 1.0,
  });
  return _shadowMat;
}

function getShadowGeometry() {
  if (_shadowGeo) return _shadowGeo;
  _shadowGeo = new THREE.PlaneGeometry(1, 1);
  _shadowGeo.rotateX(-Math.PI / 2);
  return _shadowGeo;
}

// ---------------------------------------------------------------------------
// Tile-level tree cap
// ---------------------------------------------------------------------------
const MAX_ZONE_TREES_PER_TILE = 800;
const MAX_ZONE_BUSHES_PER_TILE = 600;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render zone-based vegetation for a tile.
 * @param {object} tileData - tile payload with .greens, .roads, .buildings, .water
 * @param {string} tileKey
 * @param {{ getElevationAt?: (lat, lon) => number }} [options]
 * @returns {{ treeMeshes: THREE.InstancedMesh[], shadowMesh: THREE.InstancedMesh|null, bushMesh: THREE.InstancedMesh|null }}
 */
export function renderZoneVegetation(tileData, tileKey = '', options) {
  const greens = tileData.greens || [];
  const buildings = tileData.buildings || [];
  const getElevAt = options?.getElevationAt;
  const getWorldElev = options?.getWorldElevation || null;
  const vegMask = options?.vegetationMask || null;
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const allTreePositions = [];
  const allTreeScales = [];   // per-tree custom scale
  const allBushPositions = [];

  let globalSeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) + 7777;

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 2) &&
           !isInsideOrNearBuilding(x, z, buildings);
  }

  for (const green of greens) {
    const poly = toXYPolygon(green.polygon);
    if (!poly || poly.length < 3) continue;

    const rule = getRuleForType(green.type);
    const zoneSeed = globalSeed++;
    const bbox = polygonBBox(poly);

    // --- Trees ---
    const treePositions = [];
    const treeScales = [];
    const remaining = MAX_ZONE_TREES_PER_TILE - allTreePositions.length;
    if (remaining <= 0) { /* skip trees, still do bushes */ }
    else {
      const cap = Math.min(rule.treeCap, remaining);
      const [sLo, sHi] = rule.treeScaleRange;

      // Forest clearings
      const clearings = generateClearings(poly, rule, zoneSeed);

      // Boundary trees (parks) — DISABLED: park polygon edges often run along
      // roads, placing trees directly on road surfaces. Will re-enable with
      // proper road-edge clipping later.
      // const boundaryTrees = getBoundaryTreePositions(poly, rule, zoneSeed);
      // for (const p of boundaryTrees) {
      //   if (treePositions.length >= cap) break;
      //   if (isValid(p.x, p.y)) {
      //     treePositions.push(p);
      //     treeScales.push(sLo + seeded(treePositions.length, zoneSeed + 50) * (sHi - sLo));
      //   }
      // }

      // Interior scatter
      const scattered = scatterInPolygon(poly, rule.treeDensity, zoneSeed, cap * 2, bbox);
      for (const p of scattered) {
        if (treePositions.length >= cap) break;
        if (clearings.length > 0 && isInClearing(p.x, p.y, clearings)) continue;
        if (isValid(p.x, p.y)) {
          treePositions.push(p);
          treeScales.push(sLo + seeded(treePositions.length, zoneSeed + 51) * (sHi - sLo));
        }
      }

      allTreePositions.push(...treePositions);
      allTreeScales.push(...treeScales);

      // Forest clearing bushes
      if (clearings.length > 0 && rule.clearingBushDensity) {
        for (const c of clearings) {
          if (allBushPositions.length >= MAX_ZONE_BUSHES_PER_TILE) break;
          // Scatter bushes inside clearing circle
          const clearArea = Math.PI * c.r * c.r;
          const bushCount = Math.min(Math.floor(clearArea * rule.clearingBushDensity), 30);
          for (let bi = 0; bi < bushCount; bi++) {
            const angle = seeded(bi + zoneSeed, 500) * Math.PI * 2;
            const dist = c.r * Math.sqrt(seeded(bi + zoneSeed, 501)); // sqrt for uniform disc
            const bx = c.cx + Math.cos(angle) * dist;
            const bz = c.cz + Math.sin(angle) * dist;
            if (pointInPolygon(bx, bz, poly) && isValid(bx, bz)) {
              allBushPositions.push({ x: bx, y: bz });
            }
            if (allBushPositions.length >= MAX_ZONE_BUSHES_PER_TILE) break;
          }
        }
      }
    }

    // --- Zone bushes (non-forest) ---
    if (rule.bushDensity > 0 && allBushPositions.length < MAX_ZONE_BUSHES_PER_TILE) {
      const bushes = scatterBushClusters(poly, rule, zoneSeed + 600, bbox);
      for (const p of bushes) {
        if (allBushPositions.length >= MAX_ZONE_BUSHES_PER_TILE) break;
        if (isValid(p.x, p.y)) allBushPositions.push(p);
      }
    }
  }

  // --- Build meshes ---
  const treeMeshes = [];
  let shadowMesh = null;
  let bushMesh = null;

  if (allTreePositions.length > 0) {
    const geometries = buildProceduralTreeGeometries();
    const material = getProceduralMaterial();
    const numVariants = geometries.length;

    // Bucket positions by variant
    const buckets = Array.from({ length: numVariants }, () => ({ pos: [], scales: [] }));
    const keySeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    for (let i = 0; i < allTreePositions.length; i++) {
      const vi = Math.floor(seeded(i, keySeed + 9999) * numVariants) % numVariants;
      buckets[vi].pos.push(allTreePositions[i]);
      buckets[vi].scales.push(allTreeScales[i]);
    }

    const LEAN_MAX = (4 * Math.PI) / 180;
    const tintColor = new THREE.Color();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (let vi = 0; vi < numVariants; vi++) {
      const { pos, scales } = buckets[vi];
      if (pos.length === 0) continue;

      const mesh = new THREE.InstancedMesh(geometries[vi], material, pos.length);
      mesh.count = pos.length;
      mesh.frustumCulled = true;
      mesh.castShadow = false;  // use projected ground shadows instead of shadow map
      mesh.receiveShadow = true;
      mesh.userData.sharedGeometry = true;
      mesh.userData.sharedMaterial = true;
      mesh.userData.isTreeMesh = true;
      mesh.userData.maxInstanceCount = pos.length;

      for (let i = 0; i < pos.length; i++) {
        const p = pos[i];
        const scaleVar = scales[i];
        const rotY = seeded(i, keySeed + 2) * Math.PI * 2;
        const tiltX = (seeded(i, keySeed + 5) - 0.5) * 2 * LEAN_MAX;
        const tiltZ = (seeded(i, keySeed + 6) - 0.5) * 2 * LEAN_MAX;
        const y = getWorldElev ? getWorldElev(p.x, p.y) * vertExag
                : getElevAt ? (getElevAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;
        position.set(p.x, y, p.y);
        quat.setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ, 'XYZ'));
        scale.set(scaleVar, scaleVar, scaleVar);
        matrix.compose(position, quat, scale);
        mesh.setMatrixAt(i, matrix);

        const hueShift = (seeded(i, keySeed + 7) - 0.5) * 0.08;
        const brightShift = 0.88 + seeded(i, keySeed + 8) * 0.24;
        tintColor.setHSL(0.3 + hueShift, 0.45, 0.42 * brightShift);
        tintColor.r = 0.7 + tintColor.r * 0.6;
        tintColor.g = 0.7 + tintColor.g * 0.6;
        tintColor.b = 0.7 + tintColor.b * 0.6;
        mesh.setColorAt(i, tintColor);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      treeMeshes.push(mesh);
    }

    // Shadow mesh for all zone trees
    {
      const geo = getShadowGeometry();
      const mat = getShadowMaterial();
      const smesh = new THREE.InstancedMesh(geo, mat, allTreePositions.length);
      smesh.count = allTreePositions.length;
      smesh.frustumCulled = true;
      smesh.castShadow = false;
      smesh.receiveShadow = false;
      smesh.renderOrder = -1;
      smesh.userData.sharedGeometry = true;
      smesh.userData.sharedMaterial = true;
      smesh.userData.isTreeMesh = true;
      smesh.userData.maxInstanceCount = allTreePositions.length;

      const sPos = new THREE.Vector3();
      const sQuat = new THREE.Quaternion();
      const sScl = new THREE.Vector3();
      const sMat = new THREE.Matrix4();

      for (let i = 0; i < allTreePositions.length; i++) {
        const p = allTreePositions[i];
        const treeScale = allTreeScales[i];
        const shadowSize = 5.0 * treeScale + 2.0;
        const y = getWorldElev ? getWorldElev(p.x, p.y) * vertExag
                : getElevAt ? (getElevAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;
        sPos.set(p.x, y + SHADOW_Y_OFFSET, p.y);
        sScl.set(shadowSize, 1, shadowSize);
        sMat.compose(sPos, sQuat, sScl);
        smesh.setMatrixAt(i, sMat);
      }
      smesh.instanceMatrix.needsUpdate = true;
      shadowMesh = smesh;
    }
  }

  // Bush mesh
  if (allBushPositions.length > 0) {
    const geo = getBushGeometry();
    const mat = getBushMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, allBushPositions.length);
    mesh.count = allBushPositions.length;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.sharedGeometry = true;
    mesh.userData.sharedMaterial = true;

    const bMatrix = new THREE.Matrix4();
    const bPos = new THREE.Vector3();
    const bQuat = new THREE.Quaternion();
    const bScl = new THREE.Vector3();
    const bColor = new THREE.Color();
    const baseCol = new THREE.Color(BUSH_BASE_COLOR);

    for (let i = 0; i < allBushPositions.length; i++) {
      const p = allBushPositions[i];
      const { lat, lon } = worldToLatLon(p.x, p.y);
      const y = getElevAt ? (getElevAt(lat, lon) ?? 0) * vertExag : 0;
      const s = 0.6 + seeded(i, 440) * 0.8;
      const rotY = seeded(i, 441) * Math.PI * 2;
      const sy = 0.8 + seeded(i, 442) * 0.4;
      bPos.set(p.x, y, p.y);
      bQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      bScl.set(s, s * sy, s);
      bMatrix.compose(bPos, bQuat, bScl);
      mesh.setMatrixAt(i, bMatrix);

      const bright = 0.82 + seeded(i, 443) * 0.26;
      bColor.copy(baseCol).multiplyScalar(bright);
      mesh.setColorAt(i, bColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    bushMesh = mesh;
  }

  return { treeMeshes, shadowMesh, bushMesh };
}

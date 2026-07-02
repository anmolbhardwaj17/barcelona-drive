/**
 * Vegetation renderer: procedural low-poly trees (instanced) + green area meshes.
 * 4 tree variants styled after Delhi vegetation (Neem, Gulmohar, Ashoka, Banyan):
 *   trunk (CylinderGeometry) + overlapping foliage spheres (SphereGeometry).
 * Roadside trees on all urban road types, both sides, tight spacing.
 * Building perimeter trees for coverage near structures.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { getUrbanFeatureExclusionZones } from './urbanFeatureRenderer.js';
import { getVendorCartExclusionZones } from './vendorCartRenderer.js';
import { worldToLatLon } from '../projection.js';
import { isVegetationAllowed, isInsideOrNearBuilding } from './vegetationMask.js';
import { rasterizeSegment } from './roadOccupancyGrid.js';

// ---------------------------------------------------------------------------
// Procedural low-poly tree variants
// ---------------------------------------------------------------------------

// 4 variants: stylised Indian roadside trees (Neem, Gulmohar, Ashoka, Banyan)
// Each uses trunk cylinder + clustered dodecahedron foliage for organic canopy
const TREE_VARIANTS = [
  { // Variant 0: Umbrella tree (Neem / Peepal) — round dome canopy
    trunkRadius: 0.3, trunkHeight: 5.0,
    foliage: [
      { radius: 2.8, x: 0,    y: 6.5, z: 0,    rot: 0 },     // central (enlarged to cover gaps)
      { radius: 2.0, x: 1.8,  y: 6.0, z: 0.6,  rot: 1.2 },   // right
      { radius: 2.0, x: -1.6, y: 6.2, z: -0.7, rot: 2.5 },   // left
    ],
  },
  { // Variant 1: Spread tree (Gulmohar) — wide horizontal canopy
    trunkRadius: 0.35, trunkHeight: 4.5,
    foliage: [
      { radius: 2.4, x: -1.8, y: 5.5, z: 0,    rot: 0.5 },   // left (enlarged)
      { radius: 2.4, x: 1.8,  y: 5.5, z: 0,    rot: 2.0 },   // right (enlarged)
      { radius: 1.8, x: 0,    y: 6.2, z: 0.5,  rot: 1.0 },   // top-center
    ],
  },
  { // Variant 2: Column tree (Ashoka) — tall narrow shape
    trunkRadius: 0.25, trunkHeight: 5.5,
    foliage: [
      { radius: 1.4, x: 0,    y: 6.5, z: 0,   rot: 0,   scaleY: 1.6 },
      { radius: 1.2, x: 0.2,  y: 9.0, z: 0.1, rot: 1.5, scaleY: 1.4 },
    ],
  },
  { // Variant 3: Irregular tree (Banyan) — organic asymmetric canopy
    trunkRadius: 0.4, trunkHeight: 4.0,
    foliage: [
      { radius: 2.5, x: 0.3,  y: 5.4, z: 0.2,  rot: 0.3 },   // center (enlarged)
      { radius: 2.0, x: -1.6, y: 5.8, z: -0.4, rot: 1.8 },   // left
      { radius: 1.8, x: 1.4,  y: 6.2, z: 0.6,  rot: 3.0 },   // right
    ],
  },
];

const FOLIAGE_DETAIL = 0;          // dodecahedron detail level (0 = 20 tris)
const TRUNK_RADIAL_SEGMENTS = 3;   // 3 sides sufficient at game scale
const FOLIAGE_COLORS = [
  [0x5E7F3A, 0x6A8A3F, 0x7A8B4A],  // Neem — dusty Delhi greens
  [0x6A8A3F, 0x7A8B4A, 0x8A8F5A],  // Gulmohar (warmest)
  [0x5E7F3A, 0x6A8A3F, 0x5A7535],  // Ashoka (darker)
  [0x7A8B4A, 0x6A8A3F, 0x8A8F5A],  // Banyan (warm)
];
const TRUNK_COLOR = 0x7A6B55;      // dusty grey-brown
const DUST_COLOR = 0x9B8B6E;
const DUST_BLEND_MAX = 0.35;
const WHITE_BAND_COLOR = 0xE8E0D0;  // off-white lime wash
const WHITE_BAND_HEIGHT = 1.2;      // metres from ground

let proceduralGeometries = null;
let proceduralMaterial = null;

export function buildProceduralTreeGeometries() {
  if (proceduralGeometries) return proceduralGeometries;

  proceduralGeometries = [];
  for (let vi = 0; vi < TREE_VARIANTS.length; vi++) {
    const variant = TREE_VARIANTS[vi];
    const parts = [];

    // Trunk — tapered cylinder (toNonIndexed to match DodecahedronGeometry for merge)
    let trunk = new THREE.CylinderGeometry(
      variant.trunkRadius, variant.trunkRadius * 1.4,
      variant.trunkHeight, TRUNK_RADIAL_SEGMENTS, 2, true
    );
    trunk.translate(0, variant.trunkHeight / 2, 0);
    trunk = trunk.toNonIndexed();
    const trunkCount = trunk.attributes.position.count;
    const trunkColors = new Float32Array(trunkCount * 3);
    const tc = new THREE.Color(TRUNK_COLOR);
    const wc = new THREE.Color(WHITE_BAND_COLOR);
    const posArr = trunk.attributes.position.array;
    for (let i = 0; i < trunkCount; i++) {
      const vy = posArr[i * 3 + 1];
      const useWhite = vy <= WHITE_BAND_HEIGHT;
      trunkColors[i * 3]     = useWhite ? wc.r : tc.r;
      trunkColors[i * 3 + 1] = useWhite ? wc.g : tc.g;
      trunkColors[i * 3 + 2] = useWhite ? wc.b : tc.b;
    }
    trunk.setAttribute('color', new THREE.Float32BufferAttribute(trunkColors, 3));
    parts.push(trunk);

    // Foliage cluster — dodecahedrons with per-piece color and rotation
    const palette = FOLIAGE_COLORS[vi] ?? FOLIAGE_COLORS[0];
    for (let fi = 0; fi < variant.foliage.length; fi++) {
      const f = variant.foliage[fi];
      const geo = new THREE.DodecahedronGeometry(f.radius, FOLIAGE_DETAIL);

      // Slight random scale variation per piece (0.85–1.15)
      const sv = 0.85 + (((fi * 7 + vi * 13) % 17) / 17) * 0.3;
      geo.scale(sv, f.scaleY ? f.scaleY * sv : sv, sv);

      // Rotate each piece uniquely to break repetition
      const rotMatrix = new THREE.Matrix4();
      rotMatrix.makeRotationFromEuler(new THREE.Euler(
        f.rot * 0.7,
        f.rot,
        f.rot * 0.4
      ));
      geo.applyMatrix4(rotMatrix);

      geo.translate(f.x, f.y, f.z);

      // Per-piece color from variant palette with height-based dust gradient
      const fc = new THREE.Color(palette[fi % palette.length]);
      const brightness = 0.9 + fi * 0.04;
      fc.multiplyScalar(brightness);
      const dustC = new THREE.Color(DUST_COLOR);
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      const fPosArr = geo.attributes.position.array;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const vy = fPosArr[i * 3 + 1];
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
      const yRange = maxY - minY || 1;
      for (let i = 0; i < count; i++) {
        const heightRatio = (fPosArr[i * 3 + 1] - minY) / yRange;
        const dustAmount = DUST_BLEND_MAX * (1 - heightRatio) * (1 - heightRatio);
        colors[i * 3]     = fc.r + (dustC.r - fc.r) * dustAmount;
        colors[i * 3 + 1] = fc.g + (dustC.g - fc.g) * dustAmount;
        colors[i * 3 + 2] = fc.b + (dustC.b - fc.b) * dustAmount;
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      parts.push(geo);
    }

    // All parts are non-indexed (DodecahedronGeometry is non-indexed by default,
    // trunk converted with toNonIndexed) — required by mergeGeometries.
    const merged = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    proceduralGeometries.push(merged);
  }

  return proceduralGeometries;
}

// Phase A.2: tree wind — module-level uniform ref, populated by onBeforeCompile
let _treeWindUniforms = null;

export function getProceduralMaterial() {
  if (proceduralMaterial) return proceduralMaterial;
  proceduralMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });

  // Phase A.2: inject multi-frequency wind sway — same math as grass shader (grassRenderer.js)
  // Y-position proxy: position.y / TREE_HEIGHT gives ~0 at trunk base, ~1 at foliage tip.
  // Quadratic ramp ensures trunk base stays still, foliage tips sway fully.
  // Billboard trees use a separate material and are NOT affected by this patch.
  proceduralMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime         = { value: 0.0 };
    shader.uniforms.uWindStrength = { value: 0.6 };
    _treeWindUniforms = shader.uniforms;

    // Inject uniforms at the top of the vertex shader only.
    // No fragment shader patch — unused varyings cause linker warnings on some drivers.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      uniform float uTime;
      uniform float uWindStrength;`
    );

    // Wind displacement: use transformed.y as trunk/foliage proxy.
    // World position sampled from modelMatrix only (no instanceMatrix multiply) to
    // keep phase coherent across all instances while avoiding driver-specific issues.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>

      // Phase A.2 tree wind — reuses grass multi-frequency pattern
      float treeH = clamp(transformed.y / 10.0, 0.0, 1.0);
      float windInfluence = treeH * treeH;  // quadratic: trunk base ~0, foliage tip ~1

      // World-space phase derived from model position (stable across instances)
      vec3 windOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

      float windPhase = windOrigin.x * 0.08 + windOrigin.z * 0.06 + uTime * 1.8;
      float windGust  = sin(windPhase) * 0.6 + sin(windPhase * 2.3 + 1.4) * 0.3 + sin(windPhase * 0.4 - 0.7) * 0.1;
      float swayPhase = windOrigin.x * 0.12 - windOrigin.z * 0.09 + uTime * 1.2;
      float windSway  = sin(swayPhase) * 0.3;

      transformed.x += windGust * windInfluence * uWindStrength;
      transformed.z += windSway * windInfluence * uWindStrength * 0.6;`
    );
  };

  return proceduralMaterial;
}

/**
 * Update tree wind animation time. Call once per frame from main render loop.
 * Must be called AFTER getProceduralMaterial() has been called at least once
 * (onBeforeCompile fires on first render, setting _treeWindUniforms).
 */
export function updateTreeWind(timeSeconds) {
  if (_treeWindUniforms) {
    _treeWindUniforms.uTime.value = timeSeconds;
  }
}

/**
 * Build procedural tree geometries. Replaces GLB model loading.
 * Exported so main.js can await on startup (resolves immediately).
 */
export function preloadTreeModels() {
  buildProceduralTreeGeometries();
  return Promise.resolve();
}

// Green area mesh
const GREEN_OFFSET_Y = 0.01;
let sharedGreenMaterial = null;

// ---------------------------------------------------------------------------
// Density / roadside constants
// ---------------------------------------------------------------------------
const DENSITY_WOOD  = 1 / 15;
const DENSITY_PARK  = 1 / 30;
const DENSITY_GRASS = 1 / 55;

const ENABLE_ROADSIDE_TREES  = true;
const ROADSIDE_SPACING_MIN   = 2;
const ROADSIDE_SPACING_MAX   = 5;
const ROADSIDE_OFFSET_MIN    = 3;
const ROADSIDE_OFFSET_MAX    = 7;
const ROADSIDE_TREE_CAP      = 4000;

/** Road types that get street trees on both sides */
const TREE_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified',
]);

// ---------------------------------------------------------------------------
// Shared geometry / material helpers
// ---------------------------------------------------------------------------

function getGreenMaterial() {
  if (sharedGreenMaterial) return sharedGreenMaterial;
  sharedGreenMaterial = new THREE.MeshStandardMaterial({ color: 0x4a6e38, roughness: 0.95, metalness: 0 });
  return sharedGreenMaterial;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function seeded(index, seed) {
  const x = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

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

/** Road total widths by highway type (metres), matching roadRenderer WIDTH_BY_TYPE exactly. */
const ROAD_WIDTH_BY_TYPE = {
  motorway: 30, motorway_link: 15, trunk: 26, trunk_link: 13,
  primary: 20, primary_link: 11, secondary: 16, secondary_link: 10,
  tertiary: 13, tertiary_link: 9,
  residential: 10, service: 7, unclassified: 10, living_street: 8,
  track: 5, path: 2, footway: 2, cycleway: 2,
};

// ---------------------------------------------------------------------------
// Road-surface overlap check — removes trees that land on the actual road
// ---------------------------------------------------------------------------

function distSqToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-12) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return (ax + t * dx - px) ** 2 + (az + t * dz - pz) ** 2;
}

// ---------------------------------------------------------------------------
// Ground-road occupancy grid — O(1) lookup for "is this point on a road?"
// Only stamps ground-level roads (layer 0, no bridge, no tunnel).
// Built once per tile in collectAllPositions, used for all tree rejection.
// ---------------------------------------------------------------------------
const GRID_RES = 0.5; // metres per cell (matches vegetation mask)
const GRID_PAD = 5;   // metres padding around tile

export function buildGroundRoadGrid(roads) {
  // Compute bounds from road points (no tileBounds dependency)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let hasRoads = false;
  for (const road of roads) {
    if (road.tunnel || road.bridge || (road.layer ?? 0) !== 0) continue;
    for (const p of road.points || []) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
      hasRoads = true;
    }
  }
  if (!hasRoads) return null;
  minX -= GRID_PAD; maxX += GRID_PAD;
  minZ -= GRID_PAD; maxZ += GRID_PAD;
  const gridW = Math.ceil((maxX - minX) / GRID_RES);
  const gridH = Math.ceil((maxZ - minZ) / GRID_RES);
  const grid = new Uint8Array(gridW * gridH); // 0 = free, 1 = road

  for (const road of roads) {
    if (road.tunnel) continue;
    if (road.bridge) continue;
    if ((road.layer ?? 0) !== 0) continue; // ground level only
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
    const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
    // Shrink inward — only reject trees whose trunk center is well inside road.
    // Scale inset with road width so wide roads (trunk/primary) leave room
    // between parallel carriageways for trees.
    const rawHalf = Math.max(dataW, typeW) / 2;
    const inset = rawHalf >= 10 ? 5.0 : 3.0; // wider roads get bigger inset
    const half = rawHalf - inset;
    if (half <= 0) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(grid, gridW, gridH, minX, minZ, GRID_RES,
        pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
    }
  }
  return { grid, gridW, gridH, minX, minZ };
}

export function isOnGroundRoad(grdGrid, x, z) {
  if (!grdGrid) return false;
  const gx = Math.floor((x - grdGrid.minX) / GRID_RES);
  const gz = Math.floor((z - grdGrid.minZ) / GRID_RES);
  if (gx < 0 || gx >= grdGrid.gridW || gz < 0 || gz >= grdGrid.gridH) return false;
  return grdGrid.grid[gz * grdGrid.gridW + gx] === 1;
}

// ---------------------------------------------------------------------------
// Tree position collection
// ---------------------------------------------------------------------------

export function scatterTreesInPolygon(polygon, density, seed = 0, maxPoints = 2000) {
  if (!polygon || polygon.length < 3) return [];
  const area = polygonAreaXZ(polygon);
  const count = Math.min(Math.floor(area * density), maxPoints);
  if (count <= 0) return [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
  }
  const out = [];
  let tries = count * 50;
  while (out.length < count && tries-- > 0) {
    const x = minX + seeded(out.length + seed, 1) * (maxX - minX);
    const z = minZ + seeded(out.length + seed, 2) * (maxZ - minZ);
    if (pointInPolygon(x, z, polygon)) out.push({ x, y: z });
  }
  return out;
}

function getRoadsideTreePositions(tileData, tileKey, neighborRoads = []) {
  if (!ENABLE_ROADSIDE_TREES) return [];
  const roads = tileData.roads || [];
  const debug = CONFIG.DEBUG_TREE_SOURCES;
  const eligible = roads.filter((r) => TREE_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && !r.isRamp && (r.layer == null || r.layer === 0));
  const positions = [];
  let stepIdx = 0;

  const LINK_SKIP_DIST = 17; // metres to skip at each end of _link roads
  const JUNCTION_TREE_CLEARANCE = 10; // metres — no trees within this of a junction center
  const JUNCTION_CLUSTER_DIST = 5;    // metres — endpoints within this form a junction

  // --- Build junction set from ALL roads + neighbor tile roads ---
  // A junction = a point where 2+ road endpoints cluster together
  const junctions = [];
  {
    const allEndpoints = [];
    const allRoadSources = [...roads, ...neighborRoads];
    for (const road of allRoadSources) {
      if (road.tunnel) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
      const w = Math.max(dataW, typeW);
      allEndpoints.push({ x: pts[0].x, z: pts[0].y, w });
      allEndpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
    }
    const used = new Uint8Array(allEndpoints.length);
    const clusterDistSq = JUNCTION_CLUSTER_DIST * JUNCTION_CLUSTER_DIST;
    for (let i = 0; i < allEndpoints.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      let cx = allEndpoints[i].x, cz = allEndpoints[i].z;
      let maxW = allEndpoints[i].w;
      let count = 1;
      for (let j = i + 1; j < allEndpoints.length; j++) {
        if (used[j]) continue;
        const dx = allEndpoints[j].x - cx, dz = allEndpoints[j].z - cz;
        if (dx * dx + dz * dz < clusterDistSq) {
          used[j] = 1;
          cx = (cx * count + allEndpoints[j].x) / (count + 1);
          cz = (cz * count + allEndpoints[j].z) / (count + 1);
          maxW = Math.max(maxW, allEndpoints[j].w);
          count++;
        }
      }
      if (count >= 2) {
        // Scale clearance with junction road width — but cap it to avoid wiping long stretches
        const clearance = Math.min(JUNCTION_TREE_CLEARANCE + maxW * 0.3, 18);
        junctions.push({ x: cx, z: cz, rSq: clearance * clearance });
      }
    }

    // T-junction detection: a road endpoint near another road's segment (mid-body),
    // e.g. link road merging into trunk mid-way. Endpoint-to-endpoint misses these.
    const T_JUNCTION_DIST = 8; // metres — snap distance for T-junction detection
    const T_JUNCTION_DIST_SQ = T_JUNCTION_DIST * T_JUNCTION_DIST;
    for (const ep of allEndpoints) {
      for (const road of allRoadSources) {
        if (road.tunnel) continue;
        const pts = road.points || [];
        if (pts.length < 2) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          const d2 = distSqToSeg(ep.x, ep.z, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
          if (d2 < T_JUNCTION_DIST_SQ && d2 > 0.5) { // >0.5 avoids self-endpoint match
            const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
            const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
            const w = Math.max(dataW, typeW, ep.w);
            const clearance = Math.min(JUNCTION_TREE_CLEARANCE + w * 0.3, 18);
            junctions.push({ x: ep.x, z: ep.z, rSq: clearance * clearance });
            break; // one match per endpoint is enough
          }
        }
        if (junctions.length > 500) break; // safety cap
      }
    }
  }

  function isNearJunction(x, z) {
    for (const j of junctions) {
      if ((x - j.x) ** 2 + (z - j.z) ** 2 < j.rSq) return true;
    }
    return false;
  }

  for (const road of eligible) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const dataW3 = Number.isFinite(Number(road.width)) ? Math.max(3, Math.min(20, Number(road.width))) : 0;
    const typeW3 = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
    const roadWidth = Math.max(dataW3, typeW3);
    const halfW = roadWidth / 2;
    const ht = road.highwayType || '';
    const isLink = ht.endsWith('_link');

    // For _link roads, precompute total length for endpoint skipping
    let totalLen = 0;
    const segStarts = [0];
    for (let i = 0; i < pts.length - 1; i++) {
      totalLen += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      segStarts.push(totalLen);
    }

    let dist = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;
      const perpX = -dz / segLen, perpZ = dx / segLen;

      while (dist < segLen && positions.length < ROADSIDE_TREE_CAP) {
        const s = stepIdx;
        const stepSpacing = ROADSIDE_SPACING_MIN + seeded(s, 0) * (ROADSIDE_SPACING_MAX - ROADSIDE_SPACING_MIN);

        // Skip first and last 20m of _link roads (merge/diverge zones)
        if (isLink) {
          const cumFromStart = segStarts[i] + dist;
          if (cumFromStart < LINK_SKIP_DIST || cumFromStart > totalLen - LINK_SKIP_DIST) {
            dist += stepSpacing;
            stepIdx++;
            continue;
          }
        }

        const skipLeft  = seeded(s, 8) < 0.15;
        const skipRight = seeded(s, 9) < 0.15;
        const longJitter = (seeded(s, 10) - 0.5) * 3.0;
        const tBase = (dist + longJitter) / segLen;
        const tc = Math.max(0, Math.min(1, tBase));
        const cx = a.x + dx * tc, cz = a.y + dz * tc;
        const oMin = isLink ? -0.3 : 0.1;
        const oMax = isLink ? 0.2 : 0.5;
        const offL = halfW + oMin + seeded(s, 2) * (oMax - oMin)
                     + (seeded(s, 11) - 0.5) * (isLink ? 0.4 : 0.5);
        const offR = halfW + oMin + seeded(s, 3) * (oMax - oMin)
                     + (seeded(s, 12) - 0.5) * (isLink ? 0.4 : 0.5);
        // Skip trees near any junction/merge point
        if (isNearJunction(cx, cz)) {
          dist += stepSpacing;
          stepIdx++;
          continue;
        }
        if (!skipLeft) {
          const p = { x: cx + perpX * offL, y: cz + perpZ * offL, _sourceRoad: road };
          if (debug) { p._src = 'roadside'; p._roadType = road.highwayType; p._roadX = cx; p._roadZ = cz; }
          positions.push(p);
        }
        if (!skipRight) {
          const p = { x: cx - perpX * offR, y: cz - perpZ * offR, _sourceRoad: road };
          if (debug) { p._src = 'roadside'; p._roadType = road.highwayType; p._roadX = cx; p._roadZ = cz; }
          positions.push(p);
        }
        dist += stepSpacing;
        stepIdx++;
      }
      dist -= segLen;
    }
    if (positions.length >= ROADSIDE_TREE_CAP) break;
  }
  return positions;
}

function getBuildingPerimeterTreePositions(tileData, vegMask) {
  const buildings = tileData.buildings || [];
  const positions = [];
  const PERIM_SPACING_MIN = 8, PERIM_SPACING_MAX = 14;
  const PERIM_OFFSET_MIN = 3, PERIM_OFFSET_MAX = 5;

  for (const building of buildings) {
    const fp = building.footprint || [];
    if (fp.length < 3) continue;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], b = fp[(i + 1) % fp.length];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const nx = dz / len, nz = -dx / len;
      const spacing = PERIM_SPACING_MIN + seeded(i + (building.id || 0) * 13, 4) * (PERIM_SPACING_MAX - PERIM_SPACING_MIN);
      let d = spacing * 0.5;
      while (d < len) {
        const t = d / len;
        const wx = a.x + dx * t, wz = a.y + dz * t;
        const offset = PERIM_OFFSET_MIN + seeded(d + (building.id || 0), 5) * (PERIM_OFFSET_MAX - PERIM_OFFSET_MIN);
        const tx = wx + nx * offset, tz = wz + nz * offset;
        // Light pre-filter; real exclusion check happens in collectAllPositions
        if (isVegetationAllowed(vegMask, tx, tz, 0)) {
          positions.push({ x: tx, y: tz });
        }
        d += spacing;
        if (positions.length >= 500) return positions;
      }
    }
  }
  return positions;
}

function isNearUrbanFeature(x, y, exclusionZones) {
  for (const z of exclusionZones) {
    if ((x - z.x) ** 2 + (y - z.y) ** 2 < z.r * z.r) return true;
  }
  return false;
}

function collectAllPositions(tileData, tileKey, vegMask, neighborRoads = []) {
  const cap = Math.max(1, CONFIG.MAX_TREES_PER_TILE ?? 150);
  const positions = [];
  const roads = tileData.roads || [];
  const buildings = tileData.buildings || [];
  const veg = tileData.vegetation || {};
  const debug = CONFIG.DEBUG_TREE_SOURCES;
  // Exclusion zones around urban features (fuel stations, towers, etc.) + vendor carts
  const ufZones = getUrbanFeatureExclusionZones(tileData.urbanFeatures);
  if (CONFIG.ENABLE_VENDOR_CARTS) {
    const vcZones = getVendorCartExclusionZones(roads, buildings, tileKey, vegMask);
    ufZones.push(...vcZones);
  }

  const hasUF = ufZones.length > 0;

  function isExcluded(x, z, roadMargin = 3) {
    return !isVegetationAllowed(vegMask, x, z, roadMargin) ||
           isInsideOrNearBuilding(x, z, buildings) ||
           (hasUF && isNearUrbanFeature(x, z, ufZones));
  }

  // Ground-road occupancy grid — built before any tree placement so ALL trees
  // (including OSM-tagged ones) get rejected if they land on a road surface.
  const groundGrid = buildGroundRoadGrid(roads);

  // OSM trees: margin 3m from road edge + ground road check
  for (const p of veg.trees || []) {
    if (isOnGroundRoad(groundGrid, p.x, p.y)) continue;
    if (!isExcluded(p.x, p.y, 3)) {
      const pos = { x: p.x, y: p.y };
      if (debug) pos._src = 'osm';
      positions.push(pos);
    }
  }
  if (positions.length >= cap) return positions.slice(0, cap);

  // Roadside trees: skip vegetation mask (too aggressive near parallel roads),
  // but use ground-road grid to reject trees that land on ANY ground road surface.
  const roadside = getRoadsideTreePositions(tileData, tileKey, neighborRoads);
  for (const p of roadside) {
    if (isOnGroundRoad(groundGrid, p.x, p.y)) continue; // on any road surface — skip
    if (!isInsideOrNearBuilding(p.x, p.y, buildings) &&
        !(hasUF && isNearUrbanFeature(p.x, p.y, ufZones))) {
      const pos = { x: p.x, y: p.y };
      if (debug) { pos._src = p._src; pos._roadType = p._roadType; pos._roadX = p._roadX; pos._roadZ = p._roadZ; }
      positions.push(pos);
    }
    if (positions.length >= cap) break;
  }

  if (positions.length < cap) {
    const perim = getBuildingPerimeterTreePositions(tileData, vegMask);
    for (const p of perim) {
      if (!isExcluded(p.x, p.y, 2)) {
        if (debug) p._src = 'perimeter';
        positions.push(p);
      }
      if (positions.length >= cap) break;
    }
  }

  return positions.slice(0, cap);
}

/** Split positions into 4 buckets (one per tree variant). */
function bucketPositionsByType(positions, tileKey) {
  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const numVariants = TREE_VARIANTS.length;
  const buckets = Array.from({ length: numVariants }, () => []);
  for (let i = 0; i < positions.length; i++) {
    const t = Math.floor(seeded(i, seed) * numVariants) % numVariants;
    buckets[t].push(positions[i]);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Mesh builders
// ---------------------------------------------------------------------------

/** Batch size for progressive instance building (yield to main thread between batches). */
const INSTANCE_BATCH_SIZE = 200;
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Create instanced mesh for one procedural tree variant.
 * Builds instances in batches, yielding to main thread between batches
 * so the game loop stays responsive during tile loads.
 * Positions must be pre-sorted nearest-first so LOD mesh.count reduction
 * drops the farthest trees.
 */
async function createTreeMesh(positions, typeIndex, getElevationAt, getWorldElevation) {
  if (positions.length === 0) return null;

  const geometries = buildProceduralTreeGeometries();
  const geometry = geometries[typeIndex];
  if (!geometry) return null;
  const material = getProceduralMaterial();

  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  mesh.count = 0; // start empty — instances appear progressively
  mesh.frustumCulled = true;
  mesh.castShadow = false; // trees do NOT cast shadows — 150k+ trees in the shadow pass tanked FPS (33→). Buildings/cars still cast; trees still RECEIVE.
  mesh.receiveShadow = true;
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;
  mesh.userData.isTreeMesh = true;
  mesh.userData.maxInstanceCount = positions.length;

  const matrix   = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat     = new THREE.Quaternion();
  const scale    = new THREE.Vector3();
  const tintColor = new THREE.Color();
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const tintPalette = [0x5E7F3A, 0x6A8A3F, 0x7A8B4A, 0x8A8F5A];

  const LEAN_MAX = (4 * Math.PI) / 180;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const r = seeded(i, 1);
    const scaleVar = 0.55 + r * r * 0.9;
    const rotY  = seeded(i, 2) * Math.PI * 2;
    const tiltX = (seeded(i, 5) - 0.5) * 2 * LEAN_MAX;
    const tiltZ = (seeded(i, 6) - 0.5) * 2 * LEAN_MAX;
    const y = getWorldElevation ? getWorldElevation(p.x, p.y) * vertExag
            : getElevationAt ? (getElevationAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;
    position.set(p.x, y, p.y);
    quat.setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ, 'XYZ'));
    scale.set(scaleVar, scaleVar, scaleVar);
    matrix.compose(position, quat, scale);
    mesh.setMatrixAt(i, matrix);

    // Per-instance color tint — palette-based with wider brightness variation
    const pickIdx = Math.floor(seeded(i, 7) * tintPalette.length) % tintPalette.length;
    tintColor.set(tintPalette[pickIdx]);
    const brightShift = 0.82 + seeded(i, 8) * 0.36;  // 0.82–1.18 brightness
    tintColor.multiplyScalar(brightShift);
    // Remap to multiplier so vertex colors dominate
    tintColor.r = 0.6 + tintColor.r * 0.8;
    tintColor.g = 0.6 + tintColor.g * 0.8;
    tintColor.b = 0.6 + tintColor.b * 0.8;
    mesh.setColorAt(i, tintColor);

    // Yield to main thread every batch so the game loop stays smooth
    if ((i + 1) % INSTANCE_BATCH_SIZE === 0) {
      mesh.count = i + 1;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      await yieldToMain();
    }
  }
  mesh.count = positions.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Tree billboard impostors — 2 triangles per tree at distance, replacing ~117
// ---------------------------------------------------------------------------

let _billboardAtlasTex = null;
function getTreeBillboardAtlas() {
  if (_billboardAtlasTex) return _billboardAtlasTex;

  const cellW = 128, cellH = 256, cols = 4;
  const canvas = document.createElement('canvas');
  canvas.width = cellW * cols;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d');

  // Silhouette specs — matched to the RENDERED appearance of 3D trees
  // (MeshLambert + vertex colors + instance tint + scene lighting = very dark olive)
  const specs = [
    { trunk: '#35302A', fol: '#3A4528', folD: '#2C3620', fw: 0.55, fh: 0.45, ty: 0.38 }, // Neem
    { trunk: '#35302A', fol: '#3E4A2C', folD: '#303C22', fw: 0.48, fh: 0.42, ty: 0.40 }, // Gulmohar
    { trunk: '#35302A', fol: '#344020', folD: '#283418', fw: 0.30, fh: 0.52, ty: 0.32 }, // Ashoka
    { trunk: '#35302A', fol: '#424E30', folD: '#364226', fw: 0.60, fh: 0.44, ty: 0.36 }, // Banyan
  ];

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const ox = i * cellW, cx = ox + cellW / 2;

    // Trunk
    const tw = cellW * 0.07, th = cellH * s.ty;
    ctx.fillStyle = s.trunk;
    ctx.fillRect(cx - tw / 2, cellH - th, tw, th);

    // White lime-wash band (bottom 15% of trunk)
    ctx.fillStyle = '#E8E0D0';
    ctx.globalAlpha = 0.6;
    ctx.fillRect(cx - tw / 2, cellH - th * 0.18, tw, th * 0.18);
    ctx.globalAlpha = 1.0;

    // Main foliage ellipse
    const fw = cellW * s.fw, fh = cellH * s.fh;
    const fy = cellH - th - fh * 0.25;
    ctx.fillStyle = s.fol;
    ctx.beginPath();
    ctx.ellipse(cx, fy, fw / 2, fh / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Inner shadow blob for depth
    ctx.fillStyle = s.folD;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.ellipse(cx - fw * 0.08, fy + fh * 0.08, fw * 0.3, fh * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Dusty bottom fade (Delhi dust gradient on lower foliage) — heavier for distance realism
    const grad = ctx.createLinearGradient(0, fy + fh * 0.1, 0, fy + fh * 0.5);
    grad.addColorStop(0, 'rgba(120,110,90,0)');
    grad.addColorStop(1, 'rgba(120,110,90,0.4)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, fy, fw / 2, fh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _billboardAtlasTex = tex;
  return _billboardAtlasTex;
}

const _bbMaterials = [];
export function getTreeBillboardMaterial(variantIndex) {
  if (_bbMaterials[variantIndex]) return _bbMaterials[variantIndex];

  const atlas = getTreeBillboardAtlas();
  const mat = new THREE.MeshBasicMaterial({
    map: atlas,
    transparent: true,
    alphaTest: 0.05,
    side: THREE.DoubleSide,
    depthWrite: true,
    fog: true,
  });

  const uOff = variantIndex / 4;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.bbUvOff = { value: uOff };

    // Declare uniform
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'uniform float bbUvOff;\nvoid main() {'
    );

    // Remap UVs into atlas cell
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvMapUv = vec2(vMapUv.x * 0.25 + bbUvOff, vMapUv.y);'
    );

    // Cylindrical billboard: rotate quad to face camera around Y axis
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      // Instance world position via modelMatrix (accounts for worldGroup.scale.x=-1)
      vec4 bbWP = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float bbS = length(instanceMatrix[0].xyz);

      // Camera right vector projected to XZ plane (cylindrical billboard)
      vec3 bbR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
      vec3 bbU = vec3(0.0, 1.0, 0.0);

      vec3 bbPos = bbWP.xyz + bbR * transformed.x * bbS + bbU * transformed.y * bbS;
      vec4 mvPosition = viewMatrix * vec4(bbPos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      `
    );
  };

  _bbMaterials[variantIndex] = mat;
  return mat;
}

/**
 * Create billboard InstancedMesh for one tree variant.
 * Same positions/scales as 3D trees but rendered as camera-facing quads.
 */
function createTreeBillboardMesh(positions, variantIndex, getWorldElevation) {
  if (!positions || positions.length === 0) return null;

  // Plane sized smaller than 3D tree bounds — at distance, trees read smaller
  const W = 5, H = 7;
  const geo = new THREE.PlaneGeometry(W, H);
  // Shift up so bottom edge is at y=0 (tree base at ground)
  const pa = geo.getAttribute('position');
  for (let i = 0; i < pa.count; i++) pa.setY(i, pa.getY(i) + H / 2);
  pa.needsUpdate = true;

  const mat = getTreeBillboardMaterial(variantIndex);
  const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
  mesh.count = positions.length;
  mesh.frustumCulled = false; // billboard shader moves verts outside default bounds
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData = {
    isTreeBillboard: true,
    maxInstanceCount: positions.length,
    sharedGeometry: true,
    sharedMaterial: true,
  };

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const identityQuat = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const scaleVar = 0.55 + seeded(i, 1) ** 2 * 0.9; // same formula as 3D
    const y = getWorldElevation ? getWorldElevation(p.x, p.y) * vertExag : 0;
    pos.set(p.x, y, p.y);
    sc.setScalar(scaleVar);
    matrix.compose(pos, identityQuat, sc);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Fake tree shadows — soft radial gradient contact shadows (instanced)
// ---------------------------------------------------------------------------
const SHADOW_TEX_SIZE = 128;
const SHADOW_Y_OFFSET = 0.02;
let shadowTexture = null;
let shadowMaterial = null;
let shadowGeometry = null;

function getShadowTexture() {
  if (shadowTexture) return shadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_TEX_SIZE;
  canvas.height = SHADOW_TEX_SIZE;
  const ctx = canvas.getContext('2d');
  const cx = SHADOW_TEX_SIZE / 2, cy = SHADOW_TEX_SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
  g.addColorStop(0,    'rgba(0,0,0,0.45)');
  g.addColorStop(0.4,  'rgba(0,0,0,0.40)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.85, 'rgba(0,0,0,0.06)');
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SHADOW_TEX_SIZE, SHADOW_TEX_SIZE);
  shadowTexture = new THREE.CanvasTexture(canvas);
  return shadowTexture;
}

function getShadowMaterial() {
  if (shadowMaterial) return shadowMaterial;
  shadowMaterial = new THREE.MeshBasicMaterial({
    map: getShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 1.0,
  });
  return shadowMaterial;
}

function getShadowGeometry() {
  if (shadowGeometry) return shadowGeometry;
  shadowGeometry = new THREE.PlaneGeometry(1, 1);
  shadowGeometry.rotateX(-Math.PI / 2);
  return shadowGeometry;
}

/**
 * Create instanced shadow planes under all tree positions.
 * Shadow size scales with each tree's scale variant.
 * Async with batched instance building for smooth loading.
 */
async function createTreeShadows(positions, getElevationAt, getWorldElevation) {
  if (!positions || positions.length === 0) return null;
  const geo = getShadowGeometry();
  const mat = getShadowMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
  mesh.count = 0;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1; // render before opaque to blend correctly
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;
  mesh.userData.isTreeMesh = true;
  mesh.userData.maxInstanceCount = positions.length;

  const matrix   = new THREE.Matrix4();
  const pos      = new THREE.Vector3();
  const quat     = new THREE.Quaternion();
  const scl      = new THREE.Vector3();
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const r = seeded(i, 1);
    const treeScale = 0.55 + r * r * 0.9;
    // Shadow diameter: broad canopy coverage
    const shadowSize = 5.0 * treeScale + 2.0;
    const y = getWorldElevation ? getWorldElevation(p.x, p.y) * vertExag
            : getElevationAt ? (getElevationAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;
    pos.set(p.x, y + SHADOW_Y_OFFSET, p.y);
    scl.set(shadowSize, 1, shadowSize);
    matrix.compose(pos, quat, scl);
    mesh.setMatrixAt(i, matrix);

    if ((i + 1) % INSTANCE_BATCH_SIZE === 0) {
      mesh.count = i + 1;
      mesh.instanceMatrix.needsUpdate = true;
      await yieldToMain();
    }
  }
  mesh.count = positions.length;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function createGreenAreaMeshes(greenAreas) {
  if (!greenAreas || greenAreas.length === 0) return [];
  const geometries = [];
  for (const area of greenAreas) {
    const poly = area.polygon || [];
    if (poly.length < 3) continue;
    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
    shape.closePath();
    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, GREEN_OFFSET_Y, 0);
    geometries.push(geom);
  }
  if (geometries.length === 0) return [];
  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, getGreenMaterial());
  mesh.frustumCulled = true;
  mesh.castShadow = false; // trees do NOT cast shadows — 150k+ trees in the shadow pass tanked FPS (33→). Buildings/cars still cast; trees still RECEIVE.
  mesh.receiveShadow = true;
  return [mesh];
}

// ---------------------------------------------------------------------------
// Procedural bush system — instanced low-poly shrubs
// ---------------------------------------------------------------------------
const BUSH_SEGMENTS = 6;
const BUSH_BASE_COLOR = 0x4F7D42;
// Dark dusty bush tint palette — matches Delhi dry vegetation
const BUSH_TINTS = [
  0x3D6B30, // dark forest green
  0x4A7038, // deep olive
  0x556B2F, // dark olive green
  0x3E5926, // shadowed green
  0x4F6D3A, // dusty mid green
  0x3A5C2C, // dark lush
];
const BUSH_CAP = 3000;              // max bushes per tile
const BUSH_ROAD_SPACING_MIN = 4;
const BUSH_ROAD_SPACING_MAX = 8;
const BUSH_ROAD_OFFSET_MIN  = 3;
const BUSH_ROAD_OFFSET_MAX  = 7;
const BUSH_BARRIER_SPACING  = 4;    // metres between bushes along barriers
const BUSH_BARRIER_OFFSET   = 1.2;  // offset from barrier polyline (m)
const BUSH_TERRAIN_DENSITY  = 1 / 80; // sparse scatter

let _bushGeo = null;
let _bushMat = null;

export function getBushGeometry() {
  if (_bushGeo) return _bushGeo;
  // Organic bush: 3 overlapping dodecahedrons at different offsets/scales
  const parts = [];
  // Central lobe — main body
  const d0 = new THREE.DodecahedronGeometry(0.38, 0);
  d0.scale(1.0, 0.55, 1.0);
  d0.translate(0, 0.22, 0);
  parts.push(d0);
  // Side lobe — offset right-forward
  const d1 = new THREE.DodecahedronGeometry(0.30, 0);
  d1.scale(0.9, 0.50, 0.85);
  d1.rotateY(1.2);
  d1.translate(0.18, 0.18, 0.12);
  parts.push(d1);
  // Side lobe — offset left-back
  const d2 = new THREE.DodecahedronGeometry(0.26, 0);
  d2.scale(0.85, 0.48, 0.9);
  d2.rotateY(2.8);
  d2.translate(-0.14, 0.20, -0.10);
  parts.push(d2);

  _bushGeo = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  _bushGeo.computeBoundingBox();
  return _bushGeo;
}

export function getBushMaterial() {
  if (_bushMat) return _bushMat;
  _bushMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  return _bushMat;
}

/**
 * Collect bush positions from three sources:
 * 1. Clusters around tree bases (2–4 per tree)
 * 2. Road edges
 * 3. Sparse terrain scatter in green areas
 */
function collectBushPositions(treePositions, tileData, tileKey, vegMask) {
  const roads = tileData.roads || [];
  const buildings = tileData.buildings || [];
  const bushes = [];

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 3) &&
           !isInsideOrNearBuilding(x, z, buildings);
  }

  // 1. Tree base clusters: 2–3 clusters per tree, 2–4 bushes each
  for (let i = 0; i < treePositions.length && bushes.length < BUSH_CAP; i++) {
    const tp = treePositions[i];
    const numClusters = 2 + Math.floor(seeded(i, 20) * 2); // 2–3 clusters
    for (let ci = 0; ci < numClusters; ci++) {
      // Cluster center: 0.4–2.0m from trunk
      const cAngle = seeded(i * 7 + ci, 21) * Math.PI * 2;
      const cDist = 0.4 + Math.sqrt(seeded(i * 7 + ci, 22)) * 1.6;
      const cx = tp.x + Math.cos(cAngle) * cDist;
      const cz = tp.y + Math.sin(cAngle) * cDist;
      const bushesInCluster = 2 + Math.floor(seeded(i * 11 + ci, 23) * 3); // 2–4
      for (let j = 0; j < bushesInCluster; j++) {
        const bAngle = seeded(j * 97 + ci * 13 + i, j + 24) * Math.PI * 2;
        const bOff = Math.sqrt(seeded(j * 83 + ci * 11 + i, j + 25)) * 0.6; // 0–0.6m scatter
        const bx = cx + Math.cos(bAngle) * bOff;
        const bz = cz + Math.sin(bAngle) * bOff;
        if (isValid(bx, bz)) bushes.push({ x: bx, y: bz });
        if (bushes.length >= BUSH_CAP) break;
      }
      if (bushes.length >= BUSH_CAP) break;
    }
  }

  // 2. Road edge bushes
  const eligible = roads.filter(r =>
    TREE_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0)
  );
  let stepIdx = 0;
  for (const road of eligible) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    let dist = 0;
    for (let i = 0; i < pts.length - 1 && bushes.length < BUSH_CAP; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;
      const perpX = -dz / segLen, perpZ = dx / segLen;
      while (dist < segLen && bushes.length < BUSH_CAP) {
        const s = stepIdx++;
        const spacing = BUSH_ROAD_SPACING_MIN + seeded(s, 30) * (BUSH_ROAD_SPACING_MAX - BUSH_ROAD_SPACING_MIN);
        const t = Math.max(0, Math.min(1, dist / segLen));
        const cx = a.x + dx * t, cz = a.y + dz * t;
        // Both sides, with skip chance per side for natural gaps
        for (const side of [1, -1]) {
          if (seeded(s + side, 31) < 0.25) continue; // 25% skip per side
          const off = BUSH_ROAD_OFFSET_MIN + seeded(s + side * 3, 32) * (BUSH_ROAD_OFFSET_MAX - BUSH_ROAD_OFFSET_MIN);
          const bx = cx + perpX * off * side;
          const bz = cz + perpZ * off * side;
          if (isValid(bx, bz)) {
            bushes.push({ x: bx, y: bz });
            // Cluster mates: 1–2 nearby bushes (60% chance)
            const mates = seeded(s + side, 33) < 0.6 ? 1 + Math.floor(seeded(s + side, 36) * 2) : 0;
            for (let m = 0; m < mates && bushes.length < BUSH_CAP; m++) {
              const mx = bx + (seeded(s * 3 + m, 34) - 0.5) * 1.5;
              const mz = bz + (seeded(s * 3 + m, 35) - 0.5) * 1.5;
              if (isValid(mx, mz)) bushes.push({ x: mx, y: mz });
            }
          }
        }
        dist += spacing;
      }
      dist -= segLen;
    }
  }

  // 3. Barrier-edge bushes: along walls, compound walls, fences
  const barriers = tileData.barriers || [];
  const BARRIER_BUSH_TYPES = new Set(['wall', 'compound_wall', 'city_wall', 'fence', 'hedge']);
  let barrierSeed = 500;
  for (const barrier of barriers) {
    if (!BARRIER_BUSH_TYPES.has(barrier.type)) continue;
    const pts = barrier.points || [];
    if (pts.length < 2) continue;
    let dist = 0;
    for (let i = 0; i < pts.length - 1 && bushes.length < BUSH_CAP; i++) {
      const ax = pts[i][0], az = pts[i][1];
      const bx = pts[i + 1][0], bz = pts[i + 1][1];
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;
      const perpX = -dz / segLen, perpZ = dx / segLen;
      while (dist < segLen && bushes.length < BUSH_CAP) {
        const s = barrierSeed++;
        const t = Math.max(0, Math.min(1, dist / segLen));
        const cx = ax + dx * t, cz = az + dz * t;
        // Place on both sides of the barrier
        for (const side of [1, -1]) {
          const off = BUSH_BARRIER_OFFSET + seeded(s, 40 + side) * 0.8;
          const bxp = cx + perpX * off * side;
          const bzp = cz + perpZ * off * side;
          if (isValid(bxp, bzp)) {
            bushes.push({ x: bxp, y: bzp });
          }
        }
        dist += BUSH_BARRIER_SPACING + seeded(s, 42) * 3; // 4–7m spacing
      }
      dist -= segLen;
    }
  }

  return bushes.slice(0, BUSH_CAP);
}

/**
 * Build a single InstancedMesh for all bush positions in a tile.
 */
function createBushMesh(bushPositions, getElevationAt, getWorldElevation) {
  if (!bushPositions || bushPositions.length === 0) return null;

  const geo = getBushGeometry();
  const mat = getBushMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, bushPositions.length);
  mesh.count = bushPositions.length;
  mesh.frustumCulled = true;
  mesh.castShadow = false; // trees do NOT cast shadows — 150k+ trees in the shadow pass tanked FPS (33→). Buildings/cars still cast; trees still RECEIVE.
  mesh.receiveShadow = true;
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;

  const matrix   = new THREE.Matrix4();
  const pos      = new THREE.Vector3();
  const quat     = new THREE.Quaternion();
  const scl      = new THREE.Vector3();
  const color    = new THREE.Color();
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const baseCol  = new THREE.Color(BUSH_BASE_COLOR);

  for (let i = 0; i < bushPositions.length; i++) {
    const p = bushPositions[i];
    const y = getWorldElevation ? getWorldElevation(p.x, p.y) * vertExag
            : getElevationAt ? (getElevationAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;

    // Size variation: 0.6–1.5m diameter
    const s = 0.6 + seeded(i, 40) * 0.9;
    const rotY = seeded(i, 41) * Math.PI * 2;
    // Asymmetric squash: height and width vary independently
    const sy = 0.7 + seeded(i, 42) * 0.5;
    const sx = 0.85 + seeded(i, 44) * 0.3;

    pos.set(p.x, y, p.y);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    scl.set(s * sx, s * sy, s);
    matrix.compose(pos, quat, scl);
    mesh.setMatrixAt(i, matrix);

    // Per-instance color from dark tint palette
    const tintIdx = Math.floor(seeded(i, 43) * BUSH_TINTS.length) % BUSH_TINTS.length;
    color.set(BUSH_TINTS[tintIdx]);
    const bright = 0.80 + seeded(i, 45) * 0.30; // 0.80–1.10
    color.multiplyScalar(bright);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Debug: tree source visualization
// ---------------------------------------------------------------------------

/** Color map for tree source debug lines. */
const DEBUG_SRC_COLORS = {
  osm:       0x2222ff,  // blue — OSM positioned trees
  green:     0x22cc22,  // green — scattered in green areas
  roadside:  0xff2222,  // red — placed along roads
  perimeter: 0xffaa00,  // orange — building perimeter
};

/** Road-type colors for roadside tree link lines. */
const DEBUG_ROAD_COLORS = {
  primary:        0xff0000,
  primary_link:   0xff4444,
  secondary:      0xff8800,
  secondary_link: 0xffaa44,
  tertiary:       0xffff00,
  tertiary_link:  0xffff66,
  residential:    0x00cccc,
  living_street:  0x00aaaa,
  unclassified:   0x888888,
};

/**
 * Build debug lines showing tree sources. Returns a THREE.Group or null.
 * - Each tree gets a short vertical colored stick at its base (color = source type).
 * - Roadside trees also get a horizontal line to their source road point (color = road type).
 */
function buildTreeSourceDebug(positions, getElevAt) {
  if (!positions || positions.length === 0) return null;
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // Collect line segments per color
  const colorBuckets = {};  // hex → [x1,y1,z1, x2,y2,z2, ...]

  function addLine(hex, x1, y1, z1, x2, y2, z2) {
    if (!colorBuckets[hex]) colorBuckets[hex] = [];
    colorBuckets[hex].push(x1, y1, z1, x2, y2, z2);
  }

  for (const p of positions) {
    const src = p._src || 'unknown';
    let baseY = 0;
    if (getElevAt) {
      const { lat, lon } = worldToLatLon(p.x, p.y);
      baseY = (getElevAt(lat, lon) ?? 0) * vertExag;
    }

    // Vertical stick: 8m tall, at tree base
    const stickColor = DEBUG_SRC_COLORS[src] ?? 0xffffff;
    addLine(stickColor, p.x, baseY + 0.5, p.y, p.x, baseY + 8, p.y);

    // For roadside trees: line from tree to source road point
    if (src === 'roadside' && p._roadX != null) {
      let roadY = baseY;
      if (getElevAt) {
        const { lat: rlat, lon: rlon } = worldToLatLon(p._roadX, p._roadZ);
        roadY = (getElevAt(rlat, rlon) ?? 0) * vertExag;
      }
      const roadColor = DEBUG_ROAD_COLORS[p._roadType] ?? 0xff2222;
      addLine(roadColor, p.x, baseY + 1, p.y, p._roadX, roadY + 1, p._roadZ);
    }
  }

  const group = new THREE.Group();
  group.name = 'treeSourceDebug';

  for (const [hexStr, verts] of Object.entries(colorBuckets)) {
    const hex = Number(hexStr);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.LineBasicMaterial({ color: hex, depthTest: false, transparent: true, opacity: 0.85 });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 999;
    lines.frustumCulled = false;
    group.add(lines);
  }

  return group.children.length > 0 ? group : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sort positions nearest-first from a center point.
 * This ensures that when LOD reduces mesh.count, the farthest trees are dropped.
 */
function sortPositionsByDistance(positions, cx, cz) {
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    p._distSq = (p.x - cx) * (p.x - cx) + (p.y - cz) * (p.y - cz);
  }
  positions.sort((a, b) => a._distSq - b._distSq);
}

/**
 * Render vegetation for a tile: up to 4 instanced tree meshes + shadow mesh +
 * bush mesh + green area meshes.
 * Async — builds instances in batches for smooth loading without frame stuttering.
 * Positions are sorted nearest-to-center first so LOD mesh.count culls farthest trees.
 * @param {object} tileData
 * @param {string} [tileKey]
 * @param {{ getElevationAt?: (lat, lon) => number }} [options]
 * @returns {Promise<{ treeMeshes: THREE.InstancedMesh[], shadowMesh: THREE.InstancedMesh|null, bushMesh: THREE.InstancedMesh|null, greenAreaMeshes: THREE.Mesh[], debugGroup: THREE.Group|null }>}
 */
export async function renderVegetation(tileData, tileKey = '', options) {
  const vegMask = options?.vegetationMask || null;
  const neighborRoads = options?.neighborRoads || [];
  let positions    = collectAllPositions(tileData, tileKey, vegMask, neighborRoads);
  // Mask already handles road + bridge + water exclusion; no safety filter needed
  const getElevAt    = options?.getElevationAt;
  const getWorldElev = options?.getWorldElevation || null;  // fast path: skips worldToLatLon
  const treeMeshes   = [];
  const treeBillboardMeshes = [];
  let   shadowMesh   = null;
  let   bushMesh     = null;
  let   debugGroup   = null;

  // Sort positions nearest-to-center for distance-based LOD culling.
  // Player position from options (tile center fallback).
  const sortCx = options?.playerX ?? options?.tileCenterX ?? 0;
  const sortCz = options?.playerZ ?? options?.tileCenterZ ?? 0;

  if (positions.length > 0) {
    sortPositionsByDistance(positions, sortCx, sortCz);

    const numVariants = TREE_VARIANTS.length;
    const buckets = bucketPositionsByType(positions, tileKey);
    // Each bucket is already roughly sorted since input was sorted,
    // but re-sort each bucket for precise per-variant LOD
    for (let t = 0; t < numVariants; t++) {
      sortPositionsByDistance(buckets[t], sortCx, sortCz);
      const mesh = await createTreeMesh(buckets[t], t, getElevAt, getWorldElev);
      if (mesh) treeMeshes.push(mesh);
      // Billboard impostor mesh — same positions, 2 triangles per tree
      const bbMesh = createTreeBillboardMesh(buckets[t], t, getWorldElev);
      if (bbMesh) treeBillboardMeshes.push(bbMesh);
    }
    // Single instanced shadow mesh for all tree positions (already sorted)
    shadowMesh = await createTreeShadows(positions, getElevAt, getWorldElev);

    // Debug: tree source visualization
    if (CONFIG.DEBUG_TREE_SOURCES) {
      debugGroup = buildTreeSourceDebug(positions, getElevAt);
    }
  }

  // Bush layer — clusters around trees, road edges, terrain scatter
  const bushPositions = collectBushPositions(positions, tileData, tileKey, vegMask);
  bushMesh = createBushMesh(bushPositions, getElevAt, getWorldElev);

  const greenAreas     = (tileData.vegetation && tileData.vegetation.greenAreas) || [];
  const greenAreaMeshes = createGreenAreaMeshes(greenAreas);

  return { treeMeshes, treeBillboardMeshes, shadowMesh, bushMesh, greenAreaMeshes, treePositions: positions, debugGroup };
}

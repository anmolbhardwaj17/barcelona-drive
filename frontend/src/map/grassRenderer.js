/**
 * Instanced grass: GLB-based geometry.
 * Placement in parks/green areas and along roads; excluded from roads and buildings. No shadows.
 * options.getElevationAt(lat, lon) places grass base on terrain.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeGLTFLoader } from '../loaders.js';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { isVegetationAllowed } from './vegetationMask.js';

const MAX_GRASS_PER_TILE = Math.min(60000, Math.max(200, CONFIG.MAX_GRASS_PER_TILE ?? 500));
const DENSITY_GRASS = 1 / 3;
/** Margin in metres beyond road half-width for grass exclusion (tighter than trees). */
const GRASS_ROAD_MARGIN = 4;
const ENABLE_ROADSIDE_GRASS = true;
const ROADSIDE_SPACING_MIN = 0.3;
const ROADSIDE_SPACING_MAX = 0.8;
const ROADSIDE_OFFSET_MIN = 1.5;
const ROADSIDE_OFFSET_MAX = 4.0;
const ROADSIDE_GRASS_CAP_PER_TILE = 15000;

const GRASS_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified', 'service',
]);

const GRASS_AREA_TYPES = new Set(['park', 'grass', 'generic_green', 'scrub', 'playground', 'garden', 'meadow', 'village_green', 'recreation_ground', 'forest', 'wood']);
const ROADSIDE_DENSE_DIST_SQ = 5 * 5;
const ROADSIDE_FADE_DIST_SQ = 20 * 20;
const GRASS_Y_OFFSET_RANGE = 0.04;
const GRASS_OFFSET = 0.12;

// ---------------------------------------------------------------------------
// GLB grass assets
// ---------------------------------------------------------------------------
const GLB_GRASS_URLS = [
  '/models/vegetation/grass/grass_01.glb',
  '/models/vegetation/grass/grass_02.glb',
  '/models/vegetation/grass/grass_03.glb',
  '/models/vegetation/grass/grass_04.glb',
];

const GRASS_TEXTURE_URL = '/models/vegetation/textures/T_Grass.png';

let grassGeometries = new Array(4).fill(null);
let grassMaterial   = null;
let grassLoadPromise = null;

export function preloadGrassModels() {
  if (grassLoadPromise) return grassLoadPromise;

  grassLoadPromise = (async () => {
    const texLoader = new THREE.TextureLoader();
    const grassTex = await new Promise((resolve) => {
      texLoader.load(
        GRASS_TEXTURE_URL,
        (t) => { t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; resolve(t); },
        undefined,
        () => resolve(null)
      );
    });

    grassMaterial = new THREE.MeshStandardMaterial({
      map: grassTex,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
    });

    const loader = makeGLTFLoader();
    await Promise.all(
      GLB_GRASS_URLS.map((url, i) =>
        new Promise((resolve) => {
          loader.load(
            url,
            (gltf) => {
              const geos = [];
              gltf.scene.traverse((child) => {
                if (child.isMesh && child.geometry) geos.push(child.geometry.clone());
              });
              if (geos.length === 0) { resolve(); return; }
              let geo = geos.length === 1 ? geos[0] : mergeGeometries(geos);
              if (geos.length > 1) geos.forEach((g) => g.dispose());
              geo.computeBoundingBox();
              geo.translate(0, -geo.boundingBox.min.y, 0);
              grassGeometries[i] = geo;
              resolve();
            },
            undefined,
            () => resolve()
          );
        })
      )
    );
  })();

  return grassLoadPromise;
}

// ---------------------------------------------------------------------------
// Procedural fallback geometry (cross planes)
// ---------------------------------------------------------------------------
const PLANE_WIDTH = 0.7;
const PLANE_HEIGHT = 0.55;
let fallbackGrassGeometry = null;
let fallbackGrassMaterial = null;

const FALLBACK_GRASS_TEXTURE_URL = '/textures/terrain/grass.15f2422c.webp';
let fallbackGrassTexture = null;
let fallbackGrassTexturePromise = null;

function loadFallbackGrassTexture() {
  if (fallbackGrassTexture) return Promise.resolve(fallbackGrassTexture);
  if (fallbackGrassTexturePromise) return fallbackGrassTexturePromise;
  fallbackGrassTexturePromise = new Promise((resolve) => {
    new THREE.TextureLoader().load(
      FALLBACK_GRASS_TEXTURE_URL,
      (tex) => {
        if (tex.colorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
        fallbackGrassTexture = tex;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
  return fallbackGrassTexturePromise;
}

export function getFallbackGrassGeometry() {
  if (fallbackGrassGeometry) return fallbackGrassGeometry;
  const p1 = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT);
  const p2 = p1.clone();
  p2.rotateY(Math.PI / 2);
  fallbackGrassGeometry = mergeGeometries([p1, p2]);
  p1.dispose(); p2.dispose();
  fallbackGrassGeometry.computeBoundingBox();
  const box = fallbackGrassGeometry.boundingBox;
  fallbackGrassGeometry.translate(0, -box.min.y, 0);
  // Bake white vertex colors so instanceColor tinting works
  const vCount = fallbackGrassGeometry.attributes.position.count;
  const colors = new Float32Array(vCount * 3);
  colors.fill(1.0); // all white — instanceColor multiplies this
  fallbackGrassGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  fallbackGrassGeometry.computeBoundingBox();
  return fallbackGrassGeometry;
}

function getFallbackGrassMaterial(texture) {
  if (fallbackGrassMaterial) return fallbackGrassMaterial;
  fallbackGrassMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
    roughness: 0.9,
    metalness: 0,
  });
  return fallbackGrassMaterial;
}

// Textured grass material — uses grass.png billboard with alpha cutout
let _grassTex = null;
let _proceduralGrassMat = null;

// Grayscale fiber noise texture for world-space color modulation
let _fiberTex = null;
function getFiberTexture() {
  if (_fiberTex) return _fiberTex;
  _fiberTex = new THREE.TextureLoader().load('/textures/terrain/grass.15f2422c.jpg');
  _fiberTex.wrapS = THREE.RepeatWrapping;
  _fiberTex.wrapT = THREE.RepeatWrapping;
  _fiberTex.minFilter = THREE.LinearMipmapLinearFilter;
  _fiberTex.magFilter = THREE.LinearFilter;
  return _fiberTex;
}

// Wind time uniform — updated each frame from main.js
let _grassWindUniforms = null;

export function getProceduralGrassMaterial() {
  if (_proceduralGrassMat) return _proceduralGrassMat;
  if (!_grassTex) {
    _grassTex = new THREE.TextureLoader().load('/textures/vegetation/grass_blade.png');
    _grassTex.colorSpace = THREE.SRGBColorSpace;
    _grassTex.minFilter = THREE.LinearMipmapLinearFilter;
    _grassTex.magFilter = THREE.LinearFilter;
  }
  const fiberTex = getFiberTexture();
  _proceduralGrassMat = new THREE.MeshBasicMaterial({
    map: _grassTex,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
    vertexColors: true,
  });

  _proceduralGrassMat.onBeforeCompile = (shader) => {
    // --- Uniforms ---
    shader.uniforms.grassFiberTex = { value: fiberTex };
    shader.uniforms.fiberScale = { value: 0.15 };
    shader.uniforms.uTime = { value: 0.0 };
    shader.uniforms.uWindStrength = { value: 0.12 };
    // Expose uniforms for external time updates
    _grassWindUniforms = shader.uniforms;

    // --- Vertex shader: pass world position, blade height, proximity + wind ---
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying float vBladeHeight;
      varying vec2 vProximity;
      attribute vec2 aProximity;
      uniform float uTime;
      uniform float uWindStrength;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
      vBladeHeight = uv.y;
      vProximity = aProximity;

      // ── Wind animation: bend grass tips based on world position + time ──
      float bladeH = uv.y; // 0 at base, 1 at tip
      float windInfluence = bladeH * bladeH; // quadratic — tips move most
      // Multi-frequency wind: primary gust + secondary ripple
      float windPhase = vWorldPos.x * 0.08 + vWorldPos.z * 0.06 + uTime * 1.8;
      float windGust = sin(windPhase) * 0.6 + sin(windPhase * 2.3 + 1.4) * 0.3 + sin(windPhase * 0.4 - 0.7) * 0.1;
      // Lateral sway (perpendicular ripple)
      float swayPhase = vWorldPos.x * 0.12 - vWorldPos.z * 0.09 + uTime * 1.2;
      float windSway = sin(swayPhase) * 0.3;

      transformed.x += windGust * windInfluence * uWindStrength;
      transformed.z += windSway * windInfluence * uWindStrength * 0.6;
      // Slight vertical compression as blade bends
      transformed.y -= abs(windGust) * windInfluence * uWindStrength * 0.15;`
    );

    // --- Fragment shader: sample fiber texture and modulate color ---
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWorldPos;
      varying float vBladeHeight;
      varying vec2 vProximity;
      uniform sampler2D grassFiberTex;
      uniform float fiberScale;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>

      // Fiber texture modulation — world-space sampling for seamless tiling across instances
      vec2 fiberUV = vWorldPos.xz * fiberScale;
      float fiber = texture2D(grassFiberTex, fiberUV).r;
      diffuseColor.rgb *= 0.7 + fiber * 0.6;

      // Vertical brightness gradient — tips brighter than base
      diffuseColor.rgb *= 0.8 + vBladeHeight * 0.4;

      // Road influence: grass near roads becomes dry yellow
      vec3 dryColor = vec3(0.78, 0.72, 0.40);
      diffuseColor.rgb = mix(diffuseColor.rgb, dryColor, vProximity.x * 0.55);

      // Tree influence: grass near trees becomes darker green
      vec3 darkGreen = vec3(0.32, 0.42, 0.18);
      diffuseColor.rgb = mix(diffuseColor.rgb, darkGreen, vProximity.y * 0.3);`
    );
  };

  _proceduralGrassMat.customProgramCacheKey = () => 'grassFiberWindShader';

  return _proceduralGrassMat;
}

/**
 * Update grass wind animation time. Call once per frame from main render loop.
 * @param {number} timeSeconds - elapsed time in seconds
 */
export function updateGrassWind(timeSeconds) {
  if (_grassWindUniforms) {
    _grassWindUniforms.uTime.value = timeSeconds;
  }
}

// ---------------------------------------------------------------------------
// Delhi dry-grass tint palette (applied via instanceColor for fallback)
// ---------------------------------------------------------------------------
const GRASS_TINTS = [
  new THREE.Color(0.72, 0.70, 0.38), // dry golden
  new THREE.Color(0.60, 0.62, 0.30), // mid olive
  new THREE.Color(0.50, 0.55, 0.25), // deep green
  new THREE.Color(0.65, 0.68, 0.32), // warm sage
  new THREE.Color(0.45, 0.52, 0.22), // dark lush
  new THREE.Color(0.75, 0.72, 0.42), // sunlit straw
  new THREE.Color(0.55, 0.58, 0.28), // forest floor
];

// Dry/scrubby tints for roadside weed instances
const WEED_TINTS = [
  new THREE.Color(0.65, 0.60, 0.32), // dry olive
  new THREE.Color(0.58, 0.52, 0.28), // olive brown
  new THREE.Color(0.72, 0.66, 0.36), // dry golden
  new THREE.Color(0.50, 0.48, 0.25), // dark dry
  new THREE.Color(0.68, 0.58, 0.30), // warm scrub
];

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
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

function getBbox(polygon) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.y);
    maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.y);
  }
  return { minX, minZ, maxX, maxZ };
}

function distSqToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-12) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (ax + t * dx - px) ** 2 + (az + t * dz - pz) ** 2;
}

function minDistSqToRoads(roads, x, z) {
  let minSq = Infinity;
  for (const road of roads || []) {
    const pts = road.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distSqToSegment(x, z, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d < minSq) minSq = d;
    }
  }
  return minSq === Infinity ? 1e10 : minSq;
}


function noise2D(x, z, seed) {
  const n = Math.sin(x * 0.07 + seed) * Math.cos(z * 0.09 + seed * 0.5) + Math.sin((x + z) * 0.05) * 0.5;
  return (n + 1) * 0.5;
}

// --- Vegetation distribution noise (copied from terrainRenderer.js) ---
function hash2(ix, iz) {
  let n = ix * 374761393 + iz * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff * 2 - 1;
}
function smoothNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + sx * (b - a) + sz * (c - a) + sx * sz * (a - b - c + d);
}
function vegNoise(x, z, scale, seed) {
  const x1 = x * scale + seed, z1 = z * scale + seed * 0.7;
  return smoothNoise(x1, z1) * 0.7 + smoothNoise(x1 * 2.3, z1 * 2.3) * 0.3;
}

// Zone / density constants for vegetation distribution
const ROAD_EXCLUSION_DIST = 1.5;
const ROAD_SPARSE_DIST = 3.0;
const ROAD_SPARSE_KEEP_RATE = 0.25;
const BUSH_ZONE_MAX = 1.2;
const DENSE_GRASS_MAX = 3.5;
const SPARSE_GRASS_MAX = 5.0;
const SPARSE_GRASS_KEEP_RATE = 0.40;
const DENSITY_NOISE_THRESHOLD = -0.15;

// Roadside weed layer constants
const WEED_SPACING_MIN = 2.0;
const WEED_SPACING_MAX = 4.0;
const WEED_OFFSET_MIN = 1.5;
const WEED_OFFSET_MAX = 3.0;
const WEED_CAP_PER_TILE = 4000;

function getVegetationDensity(x, z, seed, treeDistSq) {
  // Macro noise (~30m patches) — 70% weight
  const macro = vegNoise(x, z, 0.03, seed) * 0.7;
  // Micro noise (~6m patches) — 30% weight
  const micro = vegNoise(x, z, 0.15, seed + 100) * 0.3;
  let density = macro + micro;
  // Tree proximity boost: +0.4 within 5m of a tree
  if (treeDistSq < 25) {
    const dist = Math.sqrt(treeDistSq);
    density += 0.4 * (1 - dist / 5);
  }
  // Biome modulation (~100m regions): remap to 0.3–1.0 multiplier
  const biome = vegNoise(x, z, 0.01, seed + 200);
  const biomeMultiplier = 0.3 + (biome + 1) * 0.5 * 0.7; // maps -1..1 to 0.3..1.0
  return density * biomeMultiplier;
}

function isInsideBuilding(buildings, x, z) {
  for (const b of buildings || []) {
    const fp = b.footprint || [];
    if (fp.length < 3) continue;
    if (pointInPolygon(x, z, fp)) return true;
  }
  return false;
}

function roadProximityWeight(distSq) {
  if (distSq <= ROADSIDE_DENSE_DIST_SQ) return 1.2;
  if (distSq <= ROADSIDE_FADE_DIST_SQ) return 0.85;
  return 0.5;
}

function scatterInPolygon(polygon, density, seed, maxCount, options = {}) {
  if (!polygon || polygon.length < 3) return [];
  const area = polygonAreaXZ(polygon);
  const targetCount = Math.min(Math.floor(area * density), maxCount);
  if (targetCount <= 0) return [];
  const { minX, minZ, maxX, maxZ } = getBbox(polygon);
  const roads = options.roads || [];

  if (roads.length > 0) {
    const poolSize = Math.min(targetCount * 4, 2500);
    const pool = [];
    let tries = poolSize * 30;
    while (pool.length < poolSize && tries-- > 0) {
      const x = minX + seeded(pool.length + seed, 1) * (maxX - minX);
      const z = minZ + seeded(pool.length + seed, 2) * (maxZ - minZ);
      if (!pointInPolygon(x, z, polygon)) continue;
      const distSq = minDistSqToRoads(roads, x, z);
      const noise = noise2D(x, z, seed);
      const weight = noise * roadProximityWeight(distSq);
      pool.push({ x, y: z, weight });
    }
    pool.sort((a, b) => b.weight - a.weight);
    return pool.slice(0, targetCount).map(({ x, y }) => ({ x, y }));
  }

  const out = [];
  let tries = targetCount * 40;
  while (out.length < targetCount && tries-- > 0) {
    const x = minX + seeded(out.length + seed, 1) * (maxX - minX);
    const z = minZ + seeded(out.length + seed, 2) * (maxZ - minZ);
    if (pointInPolygon(x, z, polygon)) {
      const n = noise2D(x, z, seed);
      if (seeded(out.length + seed, 9) < 0.4 + 0.5 * n) out.push({ x, y: z });
    }
  }
  return out;
}

function positionsAlongRoadEdges(roads, tileKey) {
  if (!ENABLE_ROADSIDE_GRASS) return [];
  const out = [];
  const eligible = roads.filter((r) => GRASS_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0));
  for (const road of eligible) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const spacing = ROADSIDE_SPACING_MIN + seeded(road.id + (tileKey || '').length, 0) * (ROADSIDE_SPACING_MAX - ROADSIDE_SPACING_MIN);
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      while (dist < len && out.length < ROADSIDE_GRASS_CAP_PER_TILE) {
        const t = dist / len;
        const x = a.x + dx * t, z = a.y + dz * t;
        const perpX = -dz / len, perpZ = dx / len;
        const offL = ROADSIDE_OFFSET_MIN + seeded(out.length + road.id * 7,     2) * (ROADSIDE_OFFSET_MAX - ROADSIDE_OFFSET_MIN);
        const offR = ROADSIDE_OFFSET_MIN + seeded(out.length + road.id * 7 + 1, 3) * (ROADSIDE_OFFSET_MAX - ROADSIDE_OFFSET_MIN);
        out.push({ x: x + perpX * offL, y: z + perpZ * offL });
        out.push({ x: x - perpX * offR, y: z - perpZ * offR });
        dist += spacing;
      }
      dist -= len;
    }
  }
  return out;
}

function collectGrassPositions(tileData, tileKey, vegMask, treePositions) {
  const positions = [];
  const buildings = tileData.buildings || [];
  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);

  // Budget allocation — grass near trees + roadsides only
  const ROADSIDE_BUDGET = Math.floor(MAX_GRASS_PER_TILE * 0.30); // 30%
  const TREE_BUDGET     = Math.floor(MAX_GRASS_PER_TILE * 0.55); // 55% — tree clusters get most
  const WEED_BUDGET     = Math.floor(MAX_GRASS_PER_TILE * 0.15); // 15%

  function isExcluded(x, z) {
    return !isVegetationAllowed(vegMask, x, z, 0.5) ||
           isInsideBuilding(buildings, x, z);
  }

  // 1. Roadside grass — zone-based density falloff from road edges
  const roads = tileData.roads || [];
  const roadside = positionsAlongRoadEdges(roads, tileKey);
  for (let ri = 0; ri < roadside.length; ri++) {
    const p = roadside[ri];
    if (isExcluded(p.x, p.y)) continue;
    const roadDistSq = minDistSqToRoads(roads, p.x, p.y);
    const roadDist = Math.sqrt(roadDistSq);
    // Hard exclusion zone: no grass within 1.5m of road
    if (roadDist < ROAD_EXCLUSION_DIST) continue;
    // Sparse zone 1.5–4m: 35% keep rate
    if (roadDist < ROAD_SPARSE_DIST) {
      if (seeded(ri + seed, 50) > ROAD_SPARSE_KEEP_RATE) continue;
    }
    // Noise density gate
    if (getVegetationDensity(p.x, p.y, seed, 1e10) < DENSITY_NOISE_THRESHOLD) continue;
    p._roadDist = roadDist;
    positions.push(p);
    if (positions.length >= ROADSIDE_BUDGET) break;
  }

  // 2. Dense cluster-based grass around each tree (4–6 clusters × 6–12 tufts)
  const treeBudgetLimit = ROADSIDE_BUDGET + TREE_BUDGET;
  const trees = treePositions || [];
  for (let ti = 0; ti < trees.length && positions.length < treeBudgetLimit; ti++) {
    const tp = trees[ti];
    const numClusters = 4 + Math.floor(seeded(ti + seed, 10) * 3); // 4–6 clusters
    for (let ci = 0; ci < numClusters && positions.length < treeBudgetLimit; ci++) {
      const clusterAngle = seeded(ci * 137 + ti, ci + 11) * Math.PI * 2;
      // Cluster center: 0.5–3.0m from trunk (sqrt for center-heavy falloff)
      const clusterR = 0.5 + Math.sqrt(seeded(ci * 251 + ti, ci + 12)) * 2.5;
      if (clusterR < BUSH_ZONE_MAX) continue;
      const cx = tp.x + Math.cos(clusterAngle) * clusterR;
      const cz = tp.y + Math.sin(clusterAngle) * clusterR;

      // Dense zone (1.2–3.5m): 8–12 tufts; Sparse zone (3.5–5.0m): 6–8 tufts
      const inDense = clusterR <= DENSE_GRASS_MAX;
      const tuftsInCluster = inDense
        ? 8 + Math.floor(seeded(ti * 17 + ci, 13) * 5)    // 8–12
        : 6 + Math.floor(seeded(ti * 17 + ci, 13) * 3);   // 6–8

      for (let j = 0; j < tuftsInCluster; j++) {
        // Sparse zone: 40% spawn probability
        if (!inDense && seeded(ti * 31 + ci * 7 + j, 14) > SPARSE_GRASS_KEEP_RATE) continue;
        // Offset within 0.3–0.5m of cluster center (sqrt distribution)
        const tuftAngle = seeded(j * 97 + ci * 13 + ti, j + 15) * Math.PI * 2;
        const spreadR = 0.3 + seeded(j * 41 + ci, j + 17) * 0.2; // 0.3–0.5m
        const tuftR = Math.sqrt(seeded(j * 83 + ci * 11 + ti, j + 16)) * spreadR;
        const gx = cx + Math.cos(tuftAngle) * tuftR;
        const gz = cz + Math.sin(tuftAngle) * tuftR;
        const trunkDistSq = (gx - tp.x) * (gx - tp.x) + (gz - tp.y) * (gz - tp.y);
        if (trunkDistSq < BUSH_ZONE_MAX * BUSH_ZONE_MAX) continue;
        if (getVegetationDensity(gx, gz, seed, trunkDistSq) < DENSITY_NOISE_THRESHOLD) continue;
        if (!isInsideBuilding(buildings, gx, gz)) {
          positions.push({ x: gx, y: gz, _treeDist: Math.sqrt(trunkDistSq) });
        }
        if (positions.length >= ROADSIDE_BUDGET + TREE_BUDGET) break;
      }
    }
  }

  // 3. Roadside weeds — scrubby vegetation along road edges (same InstancedMesh, different tint/scale)
  let weedCount = 0;
  for (const road of roads.filter(r => GRASS_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0))) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const spacing = WEED_SPACING_MIN + seeded(road.id + seed, 60) * (WEED_SPACING_MAX - WEED_SPACING_MIN);
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      while (dist < len && weedCount < WEED_CAP_PER_TILE) {
        const t = dist / len;
        const x = a.x + dx * t, z = a.y + dz * t;
        const perpX = -dz / len, perpZ = dx / len;
        const side = seeded(weedCount + seed, 61) < 0.5 ? 1 : -1;
        const off = WEED_OFFSET_MIN + seeded(weedCount + seed, 62) * (WEED_OFFSET_MAX - WEED_OFFSET_MIN);
        const wx = x + perpX * off * side;
        const wz = z + perpZ * off * side;
        if (!isExcluded(wx, wz)) {
          positions.push({ x: wx, y: wz, _isWeed: true, _roadDist: off });
          weedCount++;
        }
        dist += spacing;
      }
      dist -= len;
    }
    if (weedCount >= WEED_CAP_PER_TILE) break;
  }

  // Sort nearest-first from centroid so count-based LOD drops farthest grass first
  const final = positions.slice(0, MAX_GRASS_PER_TILE);
  if (final.length > 0) {
    let cx = 0, cz = 0;
    for (const p of final) { cx += p.x; cz += p.y; }
    cx /= final.length; cz /= final.length;
    final.sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.y - cz) ** 2;
      const db = (b.x - cx) ** 2 + (b.y - cz) ** 2;
      return da - db;
    });
  }
  return final;
}

// ---------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------

async function buildGrassMesh(geometry, material, positions, getElevationAt, useTint, getWorldElevation) {
  const count = positions.length;

  // Clone geometry so we can attach per-instance proximity attribute without
  // polluting the shared base geometry used by other tiles.
  const geo = geometry.clone();
  const proximityData = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const p = positions[i];
    // roadInfluence: 1 at road edge, fades to 0 at 8m
    proximityData[i * 2]     = p._roadDist != null ? Math.max(0, 1 - p._roadDist / 8) : 0;
    // treeInfluence: 1 at trunk, fades to 0 at 5m
    proximityData[i * 2 + 1] = p._treeDist != null ? Math.max(0, 1 - p._treeDist / 5) : 0;
  }
  geo.setAttribute('aProximity', new THREE.InstancedBufferAttribute(proximityData, 2));

  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.count = count;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.sharedGeometry = false; // cloned — dispose with mesh
  mesh.userData.sharedMaterial = true;

  if (useTint) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  }

  const vertExag =
    CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
      ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const TILT_RAD = (5 * Math.PI) / 180;
  const GRASS_BATCH = 500;

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const rnd = (s) => seeded(i, s);
    const rotY = rnd(3) * Math.PI * 2;
    const isWeed = !!p._isWeed;
    // Weeds: 0.4–1.0 scale; Regular grass: 0.3–1.1
    const scaleVar = isWeed
      ? 0.4 + rnd(4) * 0.6
      : 0.3 + rnd(4) * 0.8;
    const tiltX = (rnd(5) - 0.5) * 2 * TILT_RAD;
    const tiltZ = (rnd(6) - 0.5) * 2 * TILT_RAD;
    let y = getWorldElevation ? getWorldElevation(p.x, p.y) * vertExag
          : getElevationAt ? (getElevationAt(...Object.values(worldToLatLon(p.x, p.y))) ?? 0) * vertExag : 0;
    y += GRASS_OFFSET + (rnd(7) - 0.5) * GRASS_Y_OFFSET_RANGE;
    position.set(p.x, y, p.y);
    quat.setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ, 'XYZ'));
    scale.set(scaleVar, scaleVar, scaleVar);
    matrix.compose(position, quat, scale);
    mesh.setMatrixAt(i, matrix);
    if (useTint) {
      const palette = isWeed ? WEED_TINTS : GRASS_TINTS;
      const tintIndex = Math.floor(rnd(8) * palette.length) % palette.length;
      color.copy(palette[tintIndex]);
      mesh.setColorAt(i, color);
    }
    // Yield to main thread every batch so game loop stays responsive
    if ((i + 1) % GRASS_BATCH === 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (useTint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (useTint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render grass for a tile. Returns array of InstancedMesh (one per GLB variant) or single fallback mesh.
 * @param {object} tileData
 * @param {string} [tileKey]
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {Promise<THREE.InstancedMesh[]|THREE.InstancedMesh|null>}
 */
export async function renderGrass(tileData, tileKey, options, treePositions) {
  const positions = collectGrassPositions(tileData, tileKey, options?.vegetationMask || null, treePositions);
  if (positions.length === 0) return null;

  const getElevationAt = options?.getElevationAt;
  const getWorldElevation = options?.getWorldElevation || null;

  // Always use procedural cross-plane — no external assets needed
  const geometry = getFallbackGrassGeometry();
  const material = getProceduralGrassMaterial();
  return buildGrassMesh(geometry, material, positions, getElevationAt, true, getWorldElevation);
}

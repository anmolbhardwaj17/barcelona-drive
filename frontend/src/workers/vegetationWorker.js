/**
 * Vegetation instance matrix generator for Web Workers.
 *
 * Pure-math computation of tree/bush/grass instance matrices (Float32Array of
 * column-major 4x4 matrices) and per-instance colors. Returns raw typed arrays
 * suitable for Transferable postMessage.
 *
 * NO Three.js imports. NO DOM access.
 */

// ============================================================================
// Projection constants (mirrors projection.js)
// ============================================================================

const R = 6378137;
// MUST match frontend/src/projection.js ORIGIN_LAT/ORIGIN_LON
const ORIGIN_LAT = 41.350;
const ORIGIN_LON = 2.115;
// Unstretch-X (vertical-model-foundation-spec §3): world XZ = (mercator − origin) × cos(ORIGIN_LAT)
// so 1 world unit = 1 real metre. MUST match frontend/src/projection.js MERCATOR_UNSTRETCH.
const MERCATOR_UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);

let _originMercator = null;
import {
  classifySpecies as classifySpeciesShared,
  SPECIES_SETS,
  AVENUE_ROAD_TYPES,
  ROADSIDE_STRIDE,
  ROADSIDE_STRIDE_DEFAULT,
} from '../map/treeSpeciesSets.js';

export { SPECIES_SETS };

function getOriginMercator() {
  if (_originMercator) return _originMercator;
  _originMercator = latLonToMercator(ORIGIN_LAT, ORIGIN_LON);
  return _originMercator;
}

function latLonToMercator(lat, lon) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  return { x: R * lonRad, y: R * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) };
}

function mercatorToLatLon(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const latRad = 2 * Math.atan(Math.exp(y / R)) - Math.PI / 2;
  return { lat: latRad * (180 / Math.PI), lon };
}

function latLonToWorld(lat, lon) {
  const m = latLonToMercator(lat, lon);
  const o = getOriginMercator();
  return { x: (m.x - o.x) * MERCATOR_UNSTRETCH, z: (m.y - o.y) * MERCATOR_UNSTRETCH };
}

function worldToLatLon(wx, wz) {
  const o = getOriginMercator();
  return mercatorToLatLon(wx / MERCATOR_UNSTRETCH + o.x, wz / MERCATOR_UNSTRETCH + o.y);
}

// ============================================================================
// Tree variant definitions (foliage radii for shadow sizing)
// ============================================================================

const TREE_VARIANTS = [
  { // Variant 0: Umbrella tree (Neem / Peepal)
    foliage: [
      { radius: 2.6 }, { radius: 2.0 }, { radius: 1.8 },
      { radius: 1.5 }, { radius: 1.4 },
    ],
  },
  { // Variant 1: Spread tree (Gulmohar)
    foliage: [
      { radius: 2.2 }, { radius: 2.2 }, { radius: 1.8 }, { radius: 1.6 },
    ],
  },
  { // Variant 2: Column tree (Ashoka)
    foliage: [
      { radius: 1.3 }, { radius: 1.1 }, { radius: 0.9 },
    ],
  },
  { // Variant 3: Irregular tree (Banyan)
    foliage: [
      { radius: 2.3 }, { radius: 1.8 }, { radius: 1.6 },
      { radius: 1.4 }, { radius: 1.2 },
    ],
  },
];
// How many tree variants the RENDERER has geometry for — 6 card species or 4 legacy blob variants,
// per CONFIG.TREE_CARDS. It arrives with the config rather than being a constant here because the
// worker cannot see the geometry it is bucketing for, and getting it wrong is silent: meshMaterializer
// filters out any variantIndex past the end of the geometry list, so an over-count deletes trees
// without a warning. Set once per call in processVegetationInWorker; the legacy table length is the
// fallback for callers that pass no config (tests).
let NUM_TREE_VARIANTS = TREE_VARIANTS.length;

// ============================================================================
// Constants
// ============================================================================

// Road widths mirror roadRenderer WIDTH_BY_TYPE
const ROAD_RENDER_WIDTH = {
  motorway: 30, trunk: 26, primary: 20, secondary: 16, tertiary: 13,
  motorway_link: 15, trunk_link: 13, primary_link: 11, secondary_link: 10,
  tertiary_link: 9, residential: 10, service: 7, unclassified: 10,
  living_street: 8, track: 5, path: 2, footway: 2, cycleway: 2,
};

const ROAD_WIDTH_BY_TYPE = ROAD_RENDER_WIDTH; // alias

const TREE_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified',
]);

const GRASS_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified', 'service',
]);

const GRASS_AREA_TYPES = new Set([
  'park', 'grass', 'generic_green', 'scrub', 'playground', 'garden',
  'meadow', 'village_green', 'recreation_ground', 'forest', 'wood',
]);

// Vegetation mask constants
const VEG_MASK_RESOLUTION = 0.5;
const VEG_MASK_PAD = 20;
const ROAD_INFLATE = 3.0;
const BRIDGE_INFLATE = 18.0;  // wide margin to prevent tree canopies clipping through flyovers
const JUNCTION_CLUSTER_DIST_SQ = 25;
const JUNCTION_RADIUS_MULT = 2.0;
const SINGLE_ENDPOINT_EXTRA = 5.0;

// Tree placement
const DENSITY_WOOD = 1 / 15;
const DENSITY_PARK = 1 / 30;
const DENSITY_GRASS_AREA = 1 / 55;
const ENABLE_ROADSIDE_TREES = true;
// v3 P3-10(b) — roadside stride. Was a single 2-5 m for every road in the city: shorter than a
// plane tree's canopy is wide (~12 m), so crowns overlapped ~80% and every street read as one
// continuous hedge. It is now PER CONTEXT (see ROADSIDE_STRIDE in map/treeSpeciesSets.js) because
// an avenue and a narrow side street should not plant at the same interval. These constants remain
// only as the floor/ceiling for code paths that have no road context.
const ROADSIDE_SPACING_MIN = ROADSIDE_STRIDE_DEFAULT[0];
const ROADSIDE_SPACING_MAX = ROADSIDE_STRIDE_DEFAULT[1];
const ROADSIDE_OFFSET_MIN = 3;
const ROADSIDE_OFFSET_MAX = 7;
const ROADSIDE_TREE_CAP = 4000;

// Ground road grid
const GRID_RES = 0.5;
const GRID_PAD = 5;

// Bush constants
const BUSH_TINTS = [
  [0x3D / 255, 0x6B / 255, 0x30 / 255],
  [0x4A / 255, 0x70 / 255, 0x38 / 255],
  [0x55 / 255, 0x6B / 255, 0x2F / 255],
  [0x3E / 255, 0x59 / 255, 0x26 / 255],
  [0x4F / 255, 0x6D / 255, 0x3A / 255],
  [0x3A / 255, 0x5C / 255, 0x2C / 255],
];
const BUSH_CAP = 3000;
const BUSH_ROAD_SPACING_MIN = 4;
const BUSH_ROAD_SPACING_MAX = 8;
const BUSH_ROAD_OFFSET_MIN = 3;
const BUSH_ROAD_OFFSET_MAX = 7;
const BUSH_BARRIER_SPACING = 4;
const BUSH_BARRIER_OFFSET = 1.2;

// Grass constants
const DENSITY_GRASS = 1 / 3;
const GRASS_ROAD_MARGIN = 4;
const ROADSIDE_GRASS_SPACING_MIN = 0.3;
const ROADSIDE_GRASS_SPACING_MAX = 0.8;
const ROADSIDE_GRASS_OFFSET_MIN = 1.5;
const ROADSIDE_GRASS_OFFSET_MAX = 4.0;
const ROADSIDE_GRASS_CAP_PER_TILE = 15000;
const ROADSIDE_DENSE_DIST_SQ = 25;
const ROADSIDE_FADE_DIST_SQ = 400;
const GRASS_Y_OFFSET_RANGE = 0.04;
const GRASS_OFFSET = 0.12;
const ROAD_EXCLUSION_DIST = 1.5;
const ROAD_SPARSE_DIST = 3.0;
const ROAD_SPARSE_KEEP_RATE = 0.25;
const BUSH_ZONE_MAX = 1.2;
const DENSE_GRASS_MAX = 3.5;
const SPARSE_GRASS_MAX = 5.0;
const SPARSE_GRASS_KEEP_RATE = 0.40;
const DENSITY_NOISE_THRESHOLD = -0.15;
const WEED_SPACING_MIN = 2.0;
const WEED_SPACING_MAX = 4.0;
const WEED_OFFSET_MIN = 1.5;
const WEED_OFFSET_MAX = 3.0;
const WEED_CAP_PER_TILE = 4000;

const GRASS_TINTS = [
  [0.72, 0.70, 0.38],
  [0.60, 0.62, 0.30],
  [0.50, 0.55, 0.25],
  [0.65, 0.68, 0.32],
  [0.45, 0.52, 0.22],
  [0.75, 0.72, 0.42],
  [0.55, 0.58, 0.28],
];
const WEED_TINTS = [
  [0.65, 0.60, 0.32],
  [0.58, 0.52, 0.28],
  [0.72, 0.66, 0.36],
  [0.50, 0.48, 0.25],
  [0.68, 0.58, 0.30],
];

// Shadow
const SHADOW_Y_OFFSET = 0.02;

// Zone vegetation
const MAX_ZONE_TREES_PER_TILE = 800;
const MAX_ZONE_BUSHES_PER_TILE = 600;

/**
 * Which species set a greens polygon plants, by its OSM type.
 *
 * A park and a forest are not the same planting. Once relation-mapped woodland started reaching the
 * tiles, Collserola's forest polygons were being planted from the 'park' set — 20% jacaranda — and
 * the hillside came out dotted with flowering ornamentals. Wild greens plant the wild set; only
 * actual parks and gardens get the ornamentals.
 */
const ZONE_TREE_CTX = {
  forest: 'hill', scrub: 'hill', grass: 'hill', meadow: 'hill', grassland: 'hill',
  park: 'park', garden: 'park', playground: 'plaza',
};

const ZONE_RULES = {
  forest: {
    treeDensity: 1 / 25, treeCap: 600, bushDensity: 0, bushCap: 200,
    clearings: true, clearingAreaFrac: [0.10, 0.15], clearingRadius: [6, 15],
    clearingBushDensity: 1 / 8, treeScaleRange: [0.7, 1.3],
  },
  park: {
    treeDensity: 1 / 500, treeCap: 250, bushDensity: 1 / 200, bushCap: 250,
    bushClusterSize: [3, 5], boundaryTrees: true, boundarySpacing: [6, 10],
    boundaryInset: [2, 3], treeScaleRange: [0.8, 1.2],
  },
  garden: {
    treeDensity: 1 / 500, treeCap: 200, bushDensity: 1 / 200, bushCap: 200,
    bushClusterSize: [3, 5], boundaryTrees: true, boundarySpacing: [6, 10],
    boundaryInset: [2, 3], treeScaleRange: [0.7, 1.1],
  },
  grass: {
    treeDensity: 1 / 800, treeCap: 200, bushDensity: 1 / 150, bushCap: 400,
    bushClusterSize: [2, 4], treeScaleRange: [0.6, 1.0],
  },
  scrub: {
    treeDensity: 1 / 400, treeCap: 200, bushDensity: 1 / 50, bushCap: 400,
    treeScaleRange: [0.4, 0.8],
  },
};
const DEFAULT_ZONE_RULE = {
  treeDensity: 1 / 600, treeCap: 150, bushDensity: 1 / 200, bushCap: 200,
  treeScaleRange: [0.6, 1.0],
};

// ============================================================================
// Deterministic PRNG
// ============================================================================

function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ============================================================================
// Geometry helpers
// ============================================================================

function pointInPolygon(x, z, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].y;
    const xj = polygon[j].x, zj = polygon[j].y;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)
      inside = !inside;
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
    if (p.x < minX) minX = p.x;
    if (p.y < minZ) minZ = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxZ) maxZ = p.y;
  }
  return { minX, minZ, maxX, maxZ };
}

function distSqToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-12) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx - px;
  const cz = az + t * dz - pz;
  return cx * cx + cz * cz;
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

function toXYPolygon(coords) {
  if (!coords || coords.length < 3) return null;
  if (typeof coords[0].x === 'number') return coords;
  return coords.map((c) => ({ x: c[0], y: c[1] }));
}

// ============================================================================
// Noise helpers (matches vegetationRenderer/grassRenderer)
// ============================================================================

function noise2D(x, z, seed) {
  const n =
    Math.sin(x * 0.07 + seed) * Math.cos(z * 0.09 + seed * 0.5) +
    Math.sin((x + z) * 0.05) * 0.5;
  return (n + 1) * 0.5;
}

function hash2(ix, iz) {
  let n = ix * 374761393 + iz * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return (((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
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

function getVegetationDensity(x, z, seed, treeDistSq) {
  const macro = vegNoise(x, z, 0.03, seed) * 0.7;
  const micro = vegNoise(x, z, 0.15, seed + 100) * 0.3;
  let density = macro + micro;
  if (treeDistSq < 25) {
    const dist = Math.sqrt(treeDistSq);
    density += 0.4 * (1 - dist / 5);
  }
  const biome = vegNoise(x, z, 0.01, seed + 200);
  const biomeMultiplier = 0.3 + ((biome + 1) * 0.5) * 0.7;
  return density * biomeMultiplier;
}

function roadProximityWeight(distSq) {
  if (distSq <= ROADSIDE_DENSE_DIST_SQ) return 1.2;
  if (distSq <= ROADSIDE_FADE_DIST_SQ) return 0.85;
  return 0.5;
}

// ============================================================================
// Road occupancy grid (from roadOccupancyGrid.js)
// ============================================================================

function rasterizeSegment(grid, gridW, gridH, minX, minZ, res, ax, az, bx, bz, halfWidth) {
  const halfSq = halfWidth * halfWidth;
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - halfWidth - minX) / res));
  const gx1 = Math.min(gridW - 1, Math.ceil((Math.max(ax, bx) + halfWidth - minX) / res));
  const gz0 = Math.max(0, Math.floor((Math.min(az, bz) - halfWidth - minZ) / res));
  const gz1 = Math.min(gridH - 1, Math.ceil((Math.max(az, bz) + halfWidth - minZ) / res));

  for (let gz = gz0; gz <= gz1; gz++) {
    const wz = minZ + gz * res + res * 0.5;
    const row = gz * gridW;
    for (let gx = gx0; gx <= gx1; gx++) {
      if (grid[row + gx]) continue;
      const wx = minX + gx * res + res * 0.5;
      let distSq;
      if (lenSq < 1e-12) {
        distSq = (wx - ax) * (wx - ax) + (wz - az) * (wz - az);
      } else {
        let t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = ax + t * dx, pz = az + t * dz;
        distSq = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
      }
      if (distSq <= halfSq) grid[row + gx] = 1;
    }
  }
}

function rasterizeDisc(grid, gridW, gridH, minX, minZ, res, cx, cz, radius) {
  const rSq = radius * radius;
  const gx0 = Math.max(0, Math.floor((cx - radius - minX) / res));
  const gx1 = Math.min(gridW - 1, Math.ceil((cx + radius - minX) / res));
  const gz0 = Math.max(0, Math.floor((cz - radius - minZ) / res));
  const gz1 = Math.min(gridH - 1, Math.ceil((cz + radius - minZ) / res));

  for (let gz = gz0; gz <= gz1; gz++) {
    const wz = minZ + gz * res + res * 0.5;
    const row = gz * gridW;
    for (let gx = gx0; gx <= gx1; gx++) {
      if (grid[row + gx]) continue;
      const wx = minX + gx * res + res * 0.5;
      if ((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz) <= rSq) grid[row + gx] = 1;
    }
  }
}

// ============================================================================
// Vegetation mask (from vegetationMask.js)
// ============================================================================

function rasterizePolygon(grid, gridW, gridH, minX, minZ, res, polygon) {
  if (!polygon || polygon.length < 3) return;
  let polyMinZ = Infinity, polyMaxZ = -Infinity;
  for (const p of polygon) {
    const pz = p.y !== undefined ? p.y : p[1];
    if (pz < polyMinZ) polyMinZ = pz;
    if (pz > polyMaxZ) polyMaxZ = pz;
  }
  const gz0 = Math.max(0, Math.floor((polyMinZ - minZ) / res));
  const gz1 = Math.min(gridH - 1, Math.ceil((polyMaxZ - minZ) / res));

  for (let gz = gz0; gz <= gz1; gz++) {
    const scanZ = minZ + gz * res + res * 0.5;
    const intersections = [];
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x !== undefined ? polygon[i].x : polygon[i][0];
      const zi = polygon[i].y !== undefined ? polygon[i].y : polygon[i][1];
      const xj = polygon[j].x !== undefined ? polygon[j].x : polygon[j][0];
      const zj = polygon[j].y !== undefined ? polygon[j].y : polygon[j][1];
      if ((zi <= scanZ && zj > scanZ) || (zj <= scanZ && zi > scanZ)) {
        const t = (scanZ - zi) / (zj - zi);
        intersections.push(xi + t * (xj - xi));
      }
    }
    if (intersections.length < 2) continue;
    intersections.sort((a, b) => a - b);
    const row = gz * gridW;
    for (let k = 0; k < intersections.length - 1; k += 2) {
      const gx0i = Math.max(0, Math.floor((intersections[k] - minX) / res));
      const gx1i = Math.min(gridW - 1, Math.ceil((intersections[k + 1] - minX) / res));
      for (let gx = gx0i; gx <= gx1i; gx++) grid[row + gx] = 0;
    }
  }
}

function buildVegetationMask(roads, buildings, waterAreas, tileBounds, neighborRoads) {
  if (!tileBounds) return null;
  neighborRoads = neighborRoads || [];

  const sw = latLonToWorld(tileBounds.south, tileBounds.west);
  const ne = latLonToWorld(tileBounds.north, tileBounds.east);
  const minX = Math.min(sw.x, ne.x) - VEG_MASK_PAD;
  const maxX = Math.max(sw.x, ne.x) + VEG_MASK_PAD;
  const minZ = Math.min(sw.z, ne.z) - VEG_MASK_PAD;
  const maxZ = Math.max(sw.z, ne.z) + VEG_MASK_PAD;

  const gridW = Math.ceil((maxX - minX) / VEG_MASK_RESOLUTION);
  const gridH = Math.ceil((maxZ - minZ) / VEG_MASK_RESOLUTION);
  const grid = new Uint8Array(gridW * gridH);
  grid.fill(1);
  const blocked = new Uint8Array(gridW * gridH);

  if (roads && roads.length > 0) {
    const endpoints = [];
    for (const road of roads) {
      if (road.tunnel) continue;
      const layer = road.layer ?? 0;
      if (layer < 0) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = ROAD_RENDER_WIDTH[road.highwayType] ?? 6;
      const w = Math.max(dataW, typeW);
      const half = w / 2 + ROAD_INFLATE;
      for (let i = 0; i < pts.length - 1; i++) {
        rasterizeSegment(blocked, gridW, gridH, minX, minZ, VEG_MASK_RESOLUTION,
          pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
      }
      endpoints.push({ x: pts[0].x, z: pts[0].y, w });
      endpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
    }
    for (const road of neighborRoads) {
      if (road.tunnel) continue;
      const layer = road.layer ?? 0;
      if (layer < 0) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = ROAD_RENDER_WIDTH[road.highwayType] ?? 6;
      const w = Math.max(dataW, typeW);
      endpoints.push({ x: pts[0].x, z: pts[0].y, w });
      endpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
    }

    const usedEP = new Uint8Array(endpoints.length);
    for (let i = 0; i < endpoints.length; i++) {
      if (usedEP[i]) continue;
      usedEP[i] = 1;
      let cx = endpoints[i].x, cz = endpoints[i].z;
      let maxW = endpoints[i].w;
      let count = 1;
      for (let j = i + 1; j < endpoints.length; j++) {
        if (usedEP[j]) continue;
        const dx = endpoints[j].x - cx, dz = endpoints[j].z - cz;
        if (dx * dx + dz * dz < JUNCTION_CLUSTER_DIST_SQ) {
          usedEP[j] = 1;
          cx = (cx * count + endpoints[j].x) / (count + 1);
          cz = (cz * count + endpoints[j].z) / (count + 1);
          maxW = Math.max(maxW, endpoints[j].w);
          count++;
        }
      }
      if (count >= 2) {
        const junctionRadius = (maxW * JUNCTION_RADIUS_MULT) / 2 + ROAD_INFLATE;
        rasterizeDisc(blocked, gridW, gridH, minX, minZ, VEG_MASK_RESOLUTION, cx, cz, junctionRadius);
      } else {
        const endRadius = maxW / 2 + SINGLE_ENDPOINT_EXTRA;
        rasterizeDisc(blocked, gridW, gridH, minX, minZ, VEG_MASK_RESOLUTION, cx, cz, endRadius);
      }
    }

    for (const road of roads) {
      if (!road.bridge && (road.layer == null || road.layer <= 0)) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width))
        ? Math.max(6, Math.min(30, Number(road.width))) : 0;
      const typeW = ROAD_RENDER_WIDTH[road.highwayType] ?? 12;
      const w = Math.max(dataW, typeW);
      const half = w / 2 + BRIDGE_INFLATE;
      for (let i = 0; i < pts.length - 1; i++) {
        rasterizeSegment(blocked, gridW, gridH, minX, minZ, VEG_MASK_RESOLUTION,
          pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
      }
    }
  }

  for (let i = 0; i < grid.length; i++) {
    if (blocked[i]) grid[i] = 0;
  }
  for (const area of waterAreas || []) {
    const poly = area.polygon || [];
    if (poly.length >= 3) {
      rasterizePolygon(grid, gridW, gridH, minX, minZ, VEG_MASK_RESOLUTION, poly);
    }
  }

  return { grid, gridW, gridH, minX, minZ, resolution: VEG_MASK_RESOLUTION };
}

function isVegetationAllowed(mask, x, z, margin) {
  if (!mask) return true;
  margin = margin || 0;
  const { grid, gridW, gridH, minX, minZ, resolution } = mask;
  const gx = Math.floor((x - minX) / resolution);
  const gz = Math.floor((z - minZ) / resolution);

  if (margin <= 0) {
    if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) return true;
    return grid[gz * gridW + gx] !== 0;
  }

  const m = Math.ceil(margin / resolution);
  const gx0 = Math.max(0, gx - m);
  const gx1 = Math.min(gridW - 1, gx + m);
  const gz0 = Math.max(0, gz - m);
  const gz1 = Math.min(gridH - 1, gz + m);

  for (let cz = gz0; cz <= gz1; cz++) {
    const row = cz * gridW;
    for (let cx = gx0; cx <= gx1; cx++) {
      if (grid[row + cx] === 0) return false;
    }
  }
  return true;
}

function isInsideOrNearBuilding(x, z, buildings, margin) {
  margin = margin !== undefined ? margin : 2;
  for (const b of buildings || []) {
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (const p of fp) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
    }
    if (x < mnX - margin || x > mxX + margin || z < mnZ - margin || z > mxZ + margin) continue;
    if (pointInPolygon(x, z, fp)) return true;
    if (margin > 0) {
      const marginSq = margin * margin;
      for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
        if (distSqToSegment(x, z, fp[i].x, fp[i].y, fp[j].x, fp[j].y) < marginSq) return true;
      }
    }
  }
  return false;
}

function isInsideBuilding(buildings, x, z) {
  for (const b of buildings || []) {
    const fp = b.footprint || [];
    if (fp.length < 3) continue;
    if (pointInPolygon(x, z, fp)) return true;
  }
  return false;
}

function isNearUrbanFeature(x, y, exclusionZones) {
  for (const z of exclusionZones) {
    if ((x - z.x) * (x - z.x) + (y - z.y) * (y - z.y) < z.r * z.r) return true;
  }
  return false;
}

// ============================================================================
// Fast elevation (from fastElevation.js, adapted for worker)
// ============================================================================

function createFastElevation(elevation, offset) {
  if (!elevation || !elevation.elevations || (!Array.isArray(elevation.elevations) && !ArrayBuffer.isView(elevation.elevations))) {
    return () => 0;
  }

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  const o = getOriginMercator();

  const southRad = (south * Math.PI) / 180;
  const northRad = (north * Math.PI) / 180;
  const mySouth = R * Math.log(Math.tan(Math.PI / 4 + southRad / 2));
  const myNorth = R * Math.log(Math.tan(Math.PI / 4 + northRad / 2));
  const mxWest = R * ((west * Math.PI) / 180);
  const mxEast = R * ((east * Math.PI) / 180);

  const wSouth = (mySouth - o.y) * MERCATOR_UNSTRETCH;
  const wNorth = (myNorth - o.y) * MERCATOR_UNSTRETCH;
  const wWest = (mxWest - o.x) * MERCATOR_UNSTRETCH;
  const wEast = (mxEast - o.x) * MERCATOR_UNSTRETCH;

  const rowSpan = wNorth - wSouth;
  const colSpan = wEast - wWest;
  const rowScale = rowSpan > 1e-10 ? (gridRows - 1) / rowSpan : 0;
  const colScale = colSpan > 1e-10 ? (gridCols - 1) / colSpan : 0;
  const rowOff = -wSouth * rowScale;
  const colOff = -wWest * colScale;
  const maxRow = gridRows - 1;
  const maxCol = gridCols - 1;

  const OOB = 3; // cells of tolerance outside the tile DEM footprint before culling
  return function fastElevationAt(wx, wz) {
    let rowF = wz * rowScale + rowOff;
    let colF = wx * colScale + colOff;
    // Outside the tile's DEM footprint → no valid floor here. Return NaN so callers CULL the
    // vegetation (was: clamped to the high edge elevation → floating trees/stones on neighbour-tile
    // overhangs). Legit edge veg within ~OOB cells still samples via the clamp below.
    if (rowF < -OOB || rowF > maxRow + OOB || colF < -OOB || colF > maxCol + OOB) return NaN;
    if (rowF < 0) rowF = 0; else if (rowF > maxRow) rowF = maxRow;
    if (colF < 0) colF = 0; else if (colF > maxCol) colF = maxCol;
    const r0 = rowF | 0;
    const c0 = colF | 0;
    const r1 = r0 < maxRow ? r0 + 1 : r0;
    const c1 = c0 < maxCol ? c0 + 1 : c0;
    const tr = rowF - r0;
    const tc = colF - c0;
    const v00 = elevations[r0 * gridCols + c0];
    const v10 = elevations[r1 * gridCols + c0];
    const v01 = elevations[r0 * gridCols + c1];
    const v11 = elevations[r1 * gridCols + c1];
    const raw = (1 - tr) * ((1 - tc) * v00 + tc * v01) + tr * ((1 - tc) * v10 + tc * v11);
    return raw - offset;
  };
}

// ============================================================================
// Ground road grid (from vegetationRenderer.js)
// ============================================================================

function buildGroundRoadGrid(roads) {
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
  const grid = new Uint8Array(gridW * gridH);

  for (const road of roads) {
    if (road.tunnel || road.bridge || (road.layer ?? 0) !== 0) continue;
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
    const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
    const rawHalf = Math.max(dataW, typeW) / 2;
    const inset = rawHalf >= 10 ? 5.0 : 3.0;
    const half = rawHalf - inset;
    if (half <= 0) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(grid, gridW, gridH, minX, minZ, GRID_RES,
        pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
    }
  }
  return { grid, gridW, gridH, minX, minZ };
}

function isOnGroundRoad(grdGrid, x, z) {
  if (!grdGrid) return false;
  const gx = Math.floor((x - grdGrid.minX) / GRID_RES);
  const gz = Math.floor((z - grdGrid.minZ) / GRID_RES);
  if (gx < 0 || gx >= grdGrid.gridW || gz < 0 || gz >= grdGrid.gridH) return false;
  return grdGrid.grid[gz * grdGrid.gridW + gx] === 1;
}

// ============================================================================
// Column-major 4x4 matrix composition (replaces THREE.Matrix4.compose)
// ============================================================================

/**
 * Write a column-major 4x4 matrix into `out` at `offset`.
 * Composes translation (px,py,pz) + Euler XYZ rotation (rx,ry,rz) + scale (sx,sy,sz).
 * Column-major layout for Three.js:
 *   [m00, m10, m20, m30,  m01, m11, m21, m31,  m02, m12, m22, m32,  m03, m13, m23, m33]
 *    col0                  col1                  col2                  col3
 */
function composeMatrix(out, offset, px, py, pz, rx, ry, rz, sx, sy, sz) {
  const cx = Math.cos(rx), srx = Math.sin(rx);
  const cy = Math.cos(ry), sry = Math.sin(ry);
  const cz = Math.cos(rz), srz = Math.sin(rz);

  // Rotation matrix R = Rz * Ry * Rx (Euler XYZ order, intrinsic)
  // Three.js Euler 'XYZ' applies X first, then Y, then Z.
  // The combined rotation matrix M = Rz * Ry * Rx:
  const r00 = cy * cz;
  const r01 = -cy * srz;
  const r02 = sry;
  const r10 = srx * sry * cz + cx * srz;
  const r11 = -srx * sry * srz + cx * cz;
  const r12 = -srx * cy;
  const r20 = -cx * sry * cz + srx * srz;
  const r21 = cx * sry * srz + srx * cz;
  const r22 = cx * cy;

  // Column-major: column 0 = rows of first column
  out[offset + 0]  = r00 * sx;
  out[offset + 1]  = r10 * sx;
  out[offset + 2]  = r20 * sx;
  out[offset + 3]  = 0;
  // Column 1
  out[offset + 4]  = r01 * sy;
  out[offset + 5]  = r11 * sy;
  out[offset + 6]  = r21 * sy;
  out[offset + 7]  = 0;
  // Column 2
  out[offset + 8]  = r02 * sz;
  out[offset + 9]  = r12 * sz;
  out[offset + 10] = r22 * sz;
  out[offset + 11] = 0;
  // Column 3 (translation)
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/**
 * Write a column-major 4x4 matrix for Y-axis rotation only + scale + translation.
 * Faster than full Euler for bushes/shadows that only rotate around Y.
 */
function composeMatrixYRot(out, offset, px, py, pz, rotY, sx, sy, sz) {
  const cy = Math.cos(rotY), sry = Math.sin(rotY);
  out[offset + 0]  = cy * sx;
  out[offset + 1]  = 0;
  out[offset + 2]  = -sry * sx;
  out[offset + 3]  = 0;
  out[offset + 4]  = 0;
  out[offset + 5]  = sy;
  out[offset + 6]  = 0;
  out[offset + 7]  = 0;
  out[offset + 8]  = sry * sz;
  out[offset + 9]  = 0;
  out[offset + 10] = cy * sz;
  out[offset + 11] = 0;
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/**
 * Write an identity-rotation matrix (just scale + translation) for flat shadows.
 */
function composeMatrixFlat(out, offset, px, py, pz, sx, sy, sz) {
  out[offset + 0]  = sx;
  out[offset + 1]  = 0;
  out[offset + 2]  = 0;
  out[offset + 3]  = 0;
  out[offset + 4]  = 0;
  out[offset + 5]  = sy;
  out[offset + 6]  = 0;
  out[offset + 7]  = 0;
  out[offset + 8]  = 0;
  out[offset + 9]  = 0;
  out[offset + 10] = sz;
  out[offset + 11] = 0;
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

// ============================================================================
// HSL to RGB conversion (replaces THREE.Color.setHSL)
// ============================================================================

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r, g, b];
}

function hexToRgb(hex) {
  return [
    ((hex >> 16) & 0xFF) / 255,
    ((hex >> 8) & 0xFF) / 255,
    (hex & 0xFF) / 255,
  ];
}

// ============================================================================
// Tree position collection (from vegetationRenderer.js)
// ============================================================================

function scatterTreesInPolygon(polygon, density, seed, maxPoints) {
  maxPoints = maxPoints || 2000;
  if (!polygon || polygon.length < 3) return [];
  const area = polygonAreaXZ(polygon);
  const count = Math.min(Math.floor(area * density), maxPoints);
  if (count <= 0) return [];
  const { minX, minZ, maxX, maxZ } = getBbox(polygon);
  const out = [];
  let tries = count * 50;
  while (out.length < count && tries-- > 0) {
    const x = minX + seeded(out.length + seed, 1) * (maxX - minX);
    const z = minZ + seeded(out.length + seed, 2) * (maxZ - minZ);
    if (pointInPolygon(x, z, polygon)) out.push({ x, y: z });
  }
  return out;
}

function getRoadsideTreePositions(tileData, tileKey, neighborRoads) {
  if (!ENABLE_ROADSIDE_TREES) return [];
  neighborRoads = neighborRoads || [];
  const roads = tileData.roads || [];
  const eligible = roads.filter(
    (r) => TREE_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && !r.isRamp && (r.layer == null || r.layer === 0)
  );
  const positions = [];
  let stepIdx = 0;

  const LINK_SKIP_DIST = 17;
  const JUNCTION_TREE_CLEARANCE = 10;
  const JUNCTION_CLUSTER_DIST = 5;

  // Build junction set
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
        const clearance = Math.min(JUNCTION_TREE_CLEARANCE + maxW * 0.3, 18);
        junctions.push({ x: cx, z: cz, rSq: clearance * clearance });
      }
    }

    // T-junction detection
    const T_JUNCTION_DIST_SQ = 64;
    for (const ep of allEndpoints) {
      for (const road of allRoadSources) {
        if (road.tunnel) continue;
        const pts = road.points || [];
        if (pts.length < 2) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          const d2 = distSqToSegment(ep.x, ep.z, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
          if (d2 < T_JUNCTION_DIST_SQ && d2 > 0.5) {
            const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
            const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
            const w = Math.max(dataW, typeW, ep.w);
            const clearance = Math.min(JUNCTION_TREE_CLEARANCE + w * 0.3, 18);
            junctions.push({ x: ep.x, z: ep.z, rSq: clearance * clearance });
            break;
          }
        }
        if (junctions.length > 500) break;
      }
    }
  }

  function isNearJunction(x, z) {
    for (const j of junctions) {
      if ((x - j.x) * (x - j.x) + (z - j.z) * (z - j.z) < j.rSq) return true;
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
        // Stride follows the road's own context — boulevards get room between crowns, side
        // streets sit tighter. Same ctx string that picks the species, so the two cannot disagree.
        const strideCtx = AVENUE_ROAD_TYPES.has(road.highwayType) ? 'avenue' : 'street';
        const [strideLo, strideHi] = ROADSIDE_STRIDE[strideCtx] || ROADSIDE_STRIDE_DEFAULT;
        const stepSpacing = strideLo + seeded(s, 0) * (strideHi - strideLo);
        if (isLink) {
          const cumFromStart = segStarts[i] + dist;
          if (cumFromStart < LINK_SKIP_DIST || cumFromStart > totalLen - LINK_SKIP_DIST) {
            dist += stepSpacing;
            stepIdx++;
            continue;
          }
        }
        const skipLeft = seeded(s, 8) < 0.15;
        const skipRight = seeded(s, 9) < 0.15;
        const longJitter = (seeded(s, 10) - 0.5) * 3.0;
        const tBase = (dist + longJitter) / segLen;
        const tc = Math.max(0, Math.min(1, tBase));
        const cx = a.x + dx * tc, cz = a.y + dz * tc;
        const oMin = isLink ? -0.3 : 0.1;
        const oMax = isLink ? 0.2 : 0.5;
        const offL = halfW + oMin + seeded(s, 2) * (oMax - oMin) + (seeded(s, 11) - 0.5) * (isLink ? 0.4 : 0.5);
        const offR = halfW + oMin + seeded(s, 3) * (oMax - oMin) + (seeded(s, 12) - 0.5) * (isLink ? 0.4 : 0.5);

        if (isNearJunction(cx, cz)) {
          dist += stepSpacing;
          stepIdx++;
          continue;
        }
        // ctx drives the species classifier — an avenue plants planes, a side street plants celtis.
        const ctx = AVENUE_ROAD_TYPES.has(road.highwayType) ? 'avenue' : 'street';
        if (!skipLeft) positions.push({ x: cx + perpX * offL, y: cz + perpZ * offL, ctx });
        if (!skipRight) positions.push({ x: cx - perpX * offR, y: cz - perpZ * offR, ctx });
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
        const off = PERIM_OFFSET_MIN + seeded(d + (building.id || 0), 5) * (PERIM_OFFSET_MAX - PERIM_OFFSET_MIN);
        const tx = wx + nx * off, tz = wz + nz * off;
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

function collectAllPositions(tileData, tileKey, vegMask, neighborRoads, exclusionZones, config) {
  const cap = Math.max(1, config.MAX_TREES_PER_TILE || 6000);
  const positions = [];
  const roads = tileData.roads || [];
  const buildings = tileData.buildings || [];
  const veg = tileData.vegetation || {};
  const hasUF = exclusionZones && exclusionZones.length > 0;

  function isExcluded(x, z, roadMargin) {
    roadMargin = roadMargin !== undefined ? roadMargin : 3;
    return !isVegetationAllowed(vegMask, x, z, roadMargin) ||
           isInsideOrNearBuilding(x, z, buildings) ||
           (hasUF && isNearUrbanFeature(x, z, exclusionZones));
  }

  // Ground-road occupancy grid — built before any tree placement so ALL trees
  // (including OSM-tagged ones) get rejected if they land on a road surface.
  const groundGrid = buildGroundRoadGrid(roads);

  // Is this tile coastal? Palms belong on the Passeig Marítim and the Barceloneta front, and
  // nowhere inland. Tile-level rather than per-tree: a tile either meets the sea or it does not,
  // and a per-tree distance test would need the coastline geometry the worker does not carry.
  const coastal = (tileData.greens || []).some((g) => g.type === 'beach' || g.type === 'sand') ||
                  (tileData.water || []).some((w) => w.isCoast || w.type === 'sea' || w.type === 'ocean');

  // OSM trees — also reject if on ground road.
  // These are real tagged trees but their SPECIES string does not reach the worker (see the
  // classifier note), so they are classified by context like everything else.
  for (const p of veg.trees || []) {
    if (isOnGroundRoad(groundGrid, p.x, p.y)) continue;
    if (!isExcluded(p.x, p.y, 3)) {
      positions.push({ x: p.x, y: p.y, ctx: coastal ? 'coast' : 'street' });
    }
  }
  if (positions.length >= cap) return positions.slice(0, cap);

  // Roadside trees
  const roadside = getRoadsideTreePositions(tileData, tileKey, neighborRoads);
  for (const p of roadside) {
    if (isOnGroundRoad(groundGrid, p.x, p.y)) continue;
    if (!isInsideOrNearBuilding(p.x, p.y, buildings) &&
        !(hasUF && isNearUrbanFeature(p.x, p.y, exclusionZones))) {
      positions.push({ x: p.x, y: p.y, ctx: coastal ? 'coast' : p.ctx });
    }
    if (positions.length >= cap) break;
  }

  if (positions.length < cap) {
    const perim = getBuildingPerimeterTreePositions(tileData, vegMask);
    for (const p of perim) {
      if (!isExcluded(p.x, p.y, 2)) {
        p.ctx = 'plaza';        // building forecourts and plaça edges — the bitter orange's home
        positions.push(p);
      }
      if (positions.length >= cap) break;
    }
  }

  // Courtyard gardens — plant trees inside building INNER RINGS (the Eixample patios de manzana). The
  // rings are already baked into the tile data (multipolygon holes, verified ~58/tile in the Eixample);
  // green cores are what make the blocks read open from the air, like every real aerial of Barcelona.
  // NOTE: deliberately NOT filtered by isInsideOrNearBuilding — a courtyard is by definition inside one.
  if (positions.length < cap && tileData.buildings) {
    for (const b of tileData.buildings) {
      if (!b.innerRings || b.innerRings.length === 0) continue;
      for (const ring of b.innerRings) {
        const pts = scatterTreesInPolygon(ring, 0.02, ((b.id | 0) % 977 + 977) % 977, 8);
        for (const p of pts) {
          positions.push({ x: p.x, y: p.y, ctx: 'plaza' });   // patis de manzana: small ornamentals
          if (positions.length >= cap) break;
        }
        if (positions.length >= cap) break;
      }
      if (positions.length >= cap) break;
    }
  }

  return positions.slice(0, cap);
}

// v3 P3-10(a) species-by-context classifier — the table lives in map/treeSpeciesSets.js so the
// background/hillside clusters (environmentClusterRenderer) select from exactly the same sets.
// See that file for why. Local wrapper only binds the module-level variant count.
export function classifySpecies(pos, i, seed, fallbackIndex) {
  return classifySpeciesShared(pos && pos.ctx, i, seed, NUM_TREE_VARIANTS, fallbackIndex);
}

/** Test seam: the classifier reads the module-level variant count, which normally arrives with the
 *  per-tile config. Tests need to pin it to exercise both the card and blob branches. */
export function _setTreeVariantCountForTest(n) { NUM_TREE_VARIANTS = n; }

function bucketPositionsByType(positions, tileKey) {
  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const buckets = Array.from({ length: NUM_TREE_VARIANTS }, () => []);
  for (let i = 0; i < positions.length; i++) {
    const t = Math.floor(seeded(i, seed) * NUM_TREE_VARIANTS) % NUM_TREE_VARIANTS;
    buckets[t].push(positions[i]);
  }
  return buckets;
}

function sortPositionsByDistance(positions, cx, cz) {
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    p._distSq = (p.x - cx) * (p.x - cx) + (p.y - cz) * (p.y - cz);
  }
  positions.sort((a, b) => a._distSq - b._distSq);
}

// ============================================================================
// Bush position collection (from vegetationRenderer.js)
// ============================================================================

/**
 * Roadside and tree-base bush tufts.
 *
 * BUSHES WERE OFF BECAUSE OF THIS FUNCTION, not because of how they looked: `ENABLE_BUSHES` was
 * disabled with the note "they scattered clumps over streets and crosswalks". Every push site was
 * already guarded by isVegetationAllowed(margin 3), but that mask is a road-EDGE test — it does not
 * know about the road SURFACE the way trees do. Trees gained `isOnGroundRoad` for exactly this and
 * bushes never did, which is why a bush could sit on a crosswalk while a tree could not.
 */
function collectBushPositions(treePositions, tileData, tileKey, vegMask) {
  const bushGroundGrid = buildGroundRoadGrid(tileData.roads || []);
  const roads = tileData.roads || [];
  const buildings = tileData.buildings || [];
  const bushes = [];

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 3) &&
           !isOnGroundRoad(bushGroundGrid, x, z) &&   // the check trees had and bushes did not
           !isInsideOrNearBuilding(x, z, buildings);
  }

  // 1. Tree base clusters
  for (let i = 0; i < treePositions.length && bushes.length < BUSH_CAP; i++) {
    const tp = treePositions[i];
    const numClusters = 2 + Math.floor(seeded(i, 20) * 2);
    for (let ci = 0; ci < numClusters; ci++) {
      const cAngle = seeded(i * 7 + ci, 21) * Math.PI * 2;
      const cDist = 0.4 + Math.sqrt(seeded(i * 7 + ci, 22)) * 1.6;
      const cx = tp.x + Math.cos(cAngle) * cDist;
      const cz = tp.y + Math.sin(cAngle) * cDist;
      const bushesInCluster = 2 + Math.floor(seeded(i * 11 + ci, 23) * 3);
      for (let j = 0; j < bushesInCluster; j++) {
        const bAngle = seeded(j * 97 + ci * 13 + i, j + 24) * Math.PI * 2;
        const bOff = Math.sqrt(seeded(j * 83 + ci * 11 + i, j + 25)) * 0.6;
        const bx = cx + Math.cos(bAngle) * bOff;
        const bz = cz + Math.sin(bAngle) * bOff;
        if (isValid(bx, bz)) bushes.push({ x: bx, y: bz });
        if (bushes.length >= BUSH_CAP) break;
      }
      if (bushes.length >= BUSH_CAP) break;
    }
  }

  // 2. Road edge bushes
  const eligible = roads.filter(
    (r) => TREE_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0)
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
        for (const side of [1, -1]) {
          if (seeded(s + side, 31) < 0.25) continue;
          const off = BUSH_ROAD_OFFSET_MIN + seeded(s + side * 3, 32) * (BUSH_ROAD_OFFSET_MAX - BUSH_ROAD_OFFSET_MIN);
          const bx = cx + perpX * off * side;
          const bz = cz + perpZ * off * side;
          if (isValid(bx, bz)) {
            bushes.push({ x: bx, y: bz });
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

  // 3. Barrier-edge bushes
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
        for (const side of [1, -1]) {
          const off = BUSH_BARRIER_OFFSET + seeded(s, 40 + side) * 0.8;
          const bxp = cx + perpX * off * side;
          const bzp = cz + perpZ * off * side;
          if (isValid(bxp, bzp)) bushes.push({ x: bxp, y: bzp });
        }
        dist += BUSH_BARRIER_SPACING + seeded(s, 42) * 3;
      }
      dist -= segLen;
    }
  }

  return bushes.slice(0, BUSH_CAP);
}

// ============================================================================
// Zone vegetation position collection (from zoneVegetationRenderer.js)
// ============================================================================

function polygonBBox(poly) {
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const p of poly) {
    if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
    if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
  }
  return { mnX, mxX, mnZ, mxZ };
}

function zoneScatterInPolygon(poly, density, seed, maxPoints, bbox) {
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
    if ((x - c.cx) * (x - c.cx) + (z - c.cz) * (z - c.cz) < c.rSq) return true;
  }
  return false;
}

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
    const size = clusterSize[0] + Math.floor(seeded(idx + seed, 402) * (clusterSize[1] - clusterSize[0] + 1));
    for (let j = 0; j < size && positions.length < clusterCount; j++) {
      const bx = cx + (seeded(idx * 7 + j, 403) - 0.5) * 3;
      const bz = cz + (seeded(idx * 7 + j, 404) - 0.5) * 3;
      if (pointInPolygon(bx, bz, poly)) positions.push({ x: bx, y: bz });
    }
  }
  return positions;
}

function collectZoneVegetation(tileData, tileKey, vegMask) {
  const greens = tileData.greens || [];
  const buildings = tileData.buildings || [];
  const allTreePositions = [];
  const allTreeScales = [];
  const allBushPositions = [];
  let globalSeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) + 7777;

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 2) &&
           !isInsideOrNearBuilding(x, z, buildings);
  }

  for (const green of greens) {
    const poly = toXYPolygon(green.polygon);
    if (!poly || poly.length < 3) continue;
    const rule = ZONE_RULES[green.type] || DEFAULT_ZONE_RULE;
    const zoneSeed = globalSeed++;
    const bbox = polygonBBox(poly);

    // Trees
    const remaining = MAX_ZONE_TREES_PER_TILE - allTreePositions.length;
    if (remaining > 0) {
      const cap = Math.min(rule.treeCap, remaining);
      const [sLo, sHi] = rule.treeScaleRange;
      const clearings = generateClearings(poly, rule, zoneSeed);
      const scattered = zoneScatterInPolygon(poly, rule.treeDensity, zoneSeed, cap * 2, bbox);
      for (const p of scattered) {
        if (allTreePositions.length >= MAX_ZONE_TREES_PER_TILE) break;
        if (clearings.length > 0 && isInClearing(p.x, p.y, clearings)) continue;
        if (isValid(p.x, p.y)) {
          p.ctx = ZONE_TREE_CTX[green.type] || 'park';   // see ZONE_TREE_CTX
          allTreePositions.push(p);
          allTreeScales.push(sLo + seeded(allTreePositions.length, zoneSeed + 51) * (sHi - sLo));
        }
      }

      // Forest clearing bushes
      if (clearings.length > 0 && rule.clearingBushDensity) {
        for (const c of clearings) {
          if (allBushPositions.length >= MAX_ZONE_BUSHES_PER_TILE) break;
          const clearArea = Math.PI * c.r * c.r;
          const bushCount = Math.min(Math.floor(clearArea * rule.clearingBushDensity), 30);
          for (let bi = 0; bi < bushCount; bi++) {
            const angle = seeded(bi + zoneSeed, 500) * Math.PI * 2;
            const dist = c.r * Math.sqrt(seeded(bi + zoneSeed, 501));
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

    // Zone bushes (non-forest)
    if (rule.bushDensity > 0 && allBushPositions.length < MAX_ZONE_BUSHES_PER_TILE) {
      const bushes = scatterBushClusters(poly, rule, zoneSeed + 600, bbox);
      for (const p of bushes) {
        if (allBushPositions.length >= MAX_ZONE_BUSHES_PER_TILE) break;
        if (isValid(p.x, p.y)) allBushPositions.push(p);
      }
    }
  }

  return { allTreePositions, allTreeScales, allBushPositions };
}

// ============================================================================
// Grass position collection (from grassRenderer.js)
// ============================================================================

function grassScatterInPolygon(polygon, density, seed, maxCount, roads) {
  if (!polygon || polygon.length < 3) return [];
  const area = polygonAreaXZ(polygon);
  const targetCount = Math.min(Math.floor(area * density), maxCount);
  if (targetCount <= 0) return [];
  const { minX, minZ, maxX, maxZ } = getBbox(polygon);

  if (roads && roads.length > 0) {
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
  const out = [];
  const eligible = roads.filter(
    (r) => GRASS_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0)
  );
  for (const road of eligible) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const spacing = ROADSIDE_GRASS_SPACING_MIN + seeded(road.id + (tileKey || '').length, 0) * (ROADSIDE_GRASS_SPACING_MAX - ROADSIDE_GRASS_SPACING_MIN);
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
        const offL = ROADSIDE_GRASS_OFFSET_MIN + seeded(out.length + road.id * 7, 2) * (ROADSIDE_GRASS_OFFSET_MAX - ROADSIDE_GRASS_OFFSET_MIN);
        const offR = ROADSIDE_GRASS_OFFSET_MIN + seeded(out.length + road.id * 7 + 1, 3) * (ROADSIDE_GRASS_OFFSET_MAX - ROADSIDE_GRASS_OFFSET_MIN);
        out.push({ x: x + perpX * offL, y: z + perpZ * offL });
        out.push({ x: x - perpX * offR, y: z - perpZ * offR });
        dist += spacing;
      }
      dist -= len;
    }
  }
  return out;
}

function collectGrassPositions(tileData, tileKey, vegMask, treePositions, config) {
  // ?? not || — MAX_GRASS_PER_TILE:0 must mean ZERO grass, but `0 || 50000` gave the *max* (falsy-zero bug).
  const MAX_GRASS = config.MAX_GRASS_PER_TILE ?? 50000;
  if (MAX_GRASS <= 0) return [];
  const positions = [];
  const buildings = tileData.buildings || [];
  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);

  // Budget allocation — reserve space for terrain fill (biggest visual impact)
  const ROADSIDE_BUDGET = Math.floor(MAX_GRASS * 0.30);
  const TREE_BUDGET_LIM = Math.floor(MAX_GRASS * 0.55);
  const WEED_BUDGET     = Math.floor(MAX_GRASS * 0.15);

  function isExcluded(x, z) {
    return !isVegetationAllowed(vegMask, x, z, 0.5) ||
           isInsideBuilding(buildings, x, z);
  }

  // 1. Roadside grass
  const roads = tileData.roads || [];
  const roadside = positionsAlongRoadEdges(roads, tileKey);
  for (let ri = 0; ri < roadside.length; ri++) {
    const p = roadside[ri];
    if (isExcluded(p.x, p.y)) continue;
    const roadDistSq = minDistSqToRoads(roads, p.x, p.y);
    const roadDist = Math.sqrt(roadDistSq);
    if (roadDist < ROAD_EXCLUSION_DIST) continue;
    if (roadDist < ROAD_SPARSE_DIST) {
      if (seeded(ri + seed, 50) > ROAD_SPARSE_KEEP_RATE) continue;
    }
    if (getVegetationDensity(p.x, p.y, seed, 1e10) < DENSITY_NOISE_THRESHOLD) continue;
    p._roadDist = roadDist;
    positions.push(p);
    if (positions.length >= ROADSIDE_BUDGET) break;
  }

  // 2. Dense cluster-based grass around trees
  const treeBudgetLim = ROADSIDE_BUDGET + TREE_BUDGET_LIM;
  const trees = treePositions || [];
  for (let ti = 0; ti < trees.length && positions.length < treeBudgetLim; ti++) {
    const tp = trees[ti];
    const numClusters = 4 + Math.floor(seeded(ti + seed, 10) * 3);
    for (let ci = 0; ci < numClusters && positions.length < treeBudgetLim; ci++) {
      const clusterAngle = seeded(ci * 137 + ti, ci + 11) * Math.PI * 2;
      const clusterR = 0.5 + Math.sqrt(seeded(ci * 251 + ti, ci + 12)) * 2.5;
      if (clusterR < BUSH_ZONE_MAX) continue;
      const cx = tp.x + Math.cos(clusterAngle) * clusterR;
      const cz = tp.y + Math.sin(clusterAngle) * clusterR;
      const inDense = clusterR <= DENSE_GRASS_MAX;
      const tuftsInCluster = inDense
        ? 8 + Math.floor(seeded(ti * 17 + ci, 13) * 5)
        : 6 + Math.floor(seeded(ti * 17 + ci, 13) * 3);

      for (let j = 0; j < tuftsInCluster; j++) {
        if (!inDense && seeded(ti * 31 + ci * 7 + j, 14) > SPARSE_GRASS_KEEP_RATE) continue;
        const tuftAngle = seeded(j * 97 + ci * 13 + ti, j + 15) * Math.PI * 2;
        const spreadR = 0.3 + seeded(j * 41 + ci, j + 17) * 0.2;
        const tuftR = Math.sqrt(seeded(j * 83 + ci * 11 + ti, j + 16)) * spreadR;
        const gx = cx + Math.cos(tuftAngle) * tuftR;
        const gz = cz + Math.sin(tuftAngle) * tuftR;
        const trunkDistSq = (gx - tp.x) * (gx - tp.x) + (gz - tp.y) * (gz - tp.y);
        if (trunkDistSq < BUSH_ZONE_MAX * BUSH_ZONE_MAX) continue;
        if (getVegetationDensity(gx, gz, seed, trunkDistSq) < DENSITY_NOISE_THRESHOLD) continue;
        if (!isInsideBuilding(buildings, gx, gz)) {
          positions.push({ x: gx, y: gz, _treeDist: Math.sqrt(trunkDistSq) });
        }
        if (positions.length >= treeBudgetLim) break;
      }
    }
  }

  // 3. Roadside weeds
  let weedCount = 0;
  for (const road of roads.filter(
    (r) => GRASS_ROAD_TYPES.has(r.highwayType) && !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0)
  )) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const spacing = WEED_SPACING_MIN + seeded(road.id + seed, 60) * (WEED_SPACING_MAX - WEED_SPACING_MIN);
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      while (dist < len && weedCount < WEED_BUDGET) {
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
    if (weedCount >= WEED_BUDGET) break;
  }

  // Sort nearest-first from centroid so count-based LOD drops farthest grass first
  const final = positions.slice(0, MAX_GRASS);
  if (final.length > 1) {
    let cx = 0, cz = 0;
    for (const p of final) { cx += p.x; cz += p.y; }
    cx /= final.length; cz /= final.length;
    final.sort((a, b) => ((a.x - cx) ** 2 + (a.y - cz) ** 2) - ((b.x - cx) ** 2 + (b.y - cz) ** 2));
  }
  return final;
}

// ============================================================================
// Instance matrix builders
// ============================================================================

/**
 * Build tree instance matrices + colors for one variant bucket.
 * Returns { matrices: Float32Array, colors: Float32Array, count }.
 */
function buildTreeVariantInstances(positions, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const LEAN_MAX = (4 * Math.PI) / 180;
  const tintPalette = [
    // Varied greens (the bulk) — light/medium/dark + yellow-green — so the canopy reads lively, not flat.
    hexToRgb(0x7C9B4E), hexToRgb(0x88A557), hexToRgb(0x95A862), hexToRgb(0xA3AC72),
    hexToRgb(0x6E9440), hexToRgb(0x5F8A3C), hexToRgb(0x9CB84E), hexToRgb(0x72A85A),
    hexToRgb(0x84A94A), hexToRgb(0x678F3E),
    // Warm autumn accents — a MINORITY (~2 of 12) so a few trees pop golden/amber (the art-of-rally
    // colour variety) without turning urban Barcelona into a full autumn forest.
    hexToRgb(0xC7A23E), hexToRgb(0xC17A34),
  ];

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const r = seeded(i, 1);
    const scaleVar = 0.55 + r * r * 0.9;
    const rotY = seeded(i, 2) * Math.PI * 2;
    const tiltX = (seeded(i, 5) - 0.5) * 2 * LEAN_MAX;
    const tiltZ = (seeded(i, 6) - 0.5) * 2 * LEAN_MAX;
    let y = getElev(p.x, p.y) * vertExag;
    let sc = scaleVar;
    if (!Number.isFinite(y)) { y = 0; sc = 0; } // out-of-tile → cull (zero-scale, invisible)

    composeMatrix(matrices, i * 16, p.x, y, p.y, tiltX, rotY, tiltZ, sc, sc, sc);

    // Per-instance color tint
    const pickIdx = Math.floor(seeded(i, 7) * tintPalette.length) % tintPalette.length;
    const tint = tintPalette[pickIdx];
    const brightShift = 0.82 + seeded(i, 8) * 0.36;
    // Less white-wash (0.6->0.46) + a touch more gain so the palette hues (incl. warm accents) read.
    colors[i * 3]     = 0.46 + tint[0] * brightShift * 0.95;
    colors[i * 3 + 1] = 0.46 + tint[1] * brightShift * 0.95;
    colors[i * 3 + 2] = 0.46 + tint[2] * brightShift * 0.95;
  }

  return { matrices, colors, count };
}

/**
 * Build shadow instance matrices for all tree positions.
 */
function buildShadowInstances(positions, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const r = seeded(i, 1);
    const treeScale = 0.55 + r * r * 0.9;
    let shadowSize = 5.0 * treeScale + 2.0;
    let y = getElev(p.x, p.y) * vertExag + SHADOW_Y_OFFSET;
    if (!Number.isFinite(y)) { y = 0; shadowSize = 0; } // out-of-tile → cull
    composeMatrixFlat(matrices, i * 16, p.x, y, p.y, shadowSize, shadowSize === 0 ? 0 : 1, shadowSize);
  }

  return { matrices, count };
}

/**
 * Build bush instance matrices + colors.
 */
function buildBushInstances(positions, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    let y = getElev(p.x, p.y) * vertExag;
    let s = 0.6 + seeded(i, 40) * 0.9;
    if (!Number.isFinite(y)) { y = 0; s = 0; } // out-of-tile → cull
    const rotY = seeded(i, 41) * Math.PI * 2;
    const sy = 0.7 + seeded(i, 42) * 0.5;
    const sx = 0.85 + seeded(i, 44) * 0.3;

    composeMatrixYRot(matrices, i * 16, p.x, y, p.y, rotY, s * sx, s * sy, s);

    // Per-instance color
    const tintIdx = Math.floor(seeded(i, 43) * BUSH_TINTS.length) % BUSH_TINTS.length;
    const tint = BUSH_TINTS[tintIdx];
    const bright = 0.80 + seeded(i, 45) * 0.30;
    colors[i * 3]     = tint[0] * bright;
    colors[i * 3 + 1] = tint[1] * bright;
    colors[i * 3 + 2] = tint[2] * bright;
  }

  return { matrices, colors, count };
}

/**
 * Build zone tree instance matrices + colors for one variant bucket.
 */
function buildZoneTreeVariantInstances(positions, scales, keySeed, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const LEAN_MAX = (4 * Math.PI) / 180;

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const scaleVar = scales[i];
    const rotY = seeded(i, keySeed + 2) * Math.PI * 2;
    const tiltX = (seeded(i, keySeed + 5) - 0.5) * 2 * LEAN_MAX;
    const tiltZ = (seeded(i, keySeed + 6) - 0.5) * 2 * LEAN_MAX;
    let y = getElev(p.x, p.y) * vertExag;
    let sv = scaleVar;
    if (!Number.isFinite(y)) { y = 0; sv = 0; } // out-of-tile → cull

    composeMatrix(matrices, i * 16, p.x, y, p.y, tiltX, rotY, tiltZ, sv, sv, sv);

    // Per-instance HSL tint (matches zoneVegetationRenderer)
    const hueShift = (seeded(i, keySeed + 7) - 0.5) * 0.08;
    const brightShift = 0.88 + seeded(i, keySeed + 8) * 0.24;
    const [hr, hg, hb] = hslToRgb(0.3 + hueShift, 0.45, 0.42 * brightShift);
    colors[i * 3]     = 0.7 + hr * 0.6;
    colors[i * 3 + 1] = 0.7 + hg * 0.6;
    colors[i * 3 + 2] = 0.7 + hb * 0.6;
  }

  return { matrices, colors, count };
}

/**
 * Build zone shadow instance matrices.
 */
function buildZoneShadowInstances(positions, scales, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const treeScale = scales[i];
    let shadowSize = 5.0 * treeScale + 2.0;
    let y = getElev(p.x, p.y) * vertExag + SHADOW_Y_OFFSET;
    if (!Number.isFinite(y)) { y = 0; shadowSize = 0; } // out-of-tile → cull
    composeMatrixFlat(matrices, i * 16, p.x, y, p.y, shadowSize, shadowSize === 0 ? 0 : 1, shadowSize);
  }

  return { matrices, count };
}

/**
 * Build zone bush instance matrices + colors.
 */
function buildZoneBushInstances(positions, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const baseCol = hexToRgb(0x6E9A4C); // lightened from 0x4F7D42 — airier street-tree canopy

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    let y = getElev(p.x, p.y) * vertExag;
    let s = 0.6 + seeded(i, 440) * 0.8;
    if (!Number.isFinite(y)) { y = 0; s = 0; } // out-of-tile → cull
    const rotY = seeded(i, 441) * Math.PI * 2;
    const sy = 0.8 + seeded(i, 442) * 0.4;

    composeMatrixYRot(matrices, i * 16, p.x, y, p.y, rotY, s, s * sy, s);

    const bright = 0.82 + seeded(i, 443) * 0.26;
    colors[i * 3]     = baseCol[0] * bright;
    colors[i * 3 + 1] = baseCol[1] * bright;
    colors[i * 3 + 2] = baseCol[2] * bright;
  }

  return { matrices, colors, count };
}

/**
 * Build grass instance matrices + colors.
 */
function buildGrassInstances(positions, getElev, vertExag) {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const TILT_RAD = (5 * Math.PI) / 180;

  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const rnd = (s) => seeded(i, s);
    const rotY = rnd(3) * Math.PI * 2;
    const isWeed = !!p._isWeed;
    const scaleVar = isWeed ? 0.5 + rnd(4) * 0.9 : 0.3 + rnd(4) * 1.3;
    const tiltX = (rnd(5) - 0.5) * 2 * TILT_RAD;
    const tiltZ = (rnd(6) - 0.5) * 2 * TILT_RAD;
    let y = getElev(p.x, p.y) * vertExag;
    let sv = scaleVar;
    if (!Number.isFinite(y)) { y = 0; sv = 0; } // out-of-tile → cull
    else y += GRASS_OFFSET + (rnd(7) - 0.5) * GRASS_Y_OFFSET_RANGE;

    composeMatrix(matrices, i * 16, p.x, y, p.y, tiltX, rotY, tiltZ, sv, sv, sv);

    // Per-instance tint
    const palette = isWeed ? WEED_TINTS : GRASS_TINTS;
    const tintIndex = Math.floor(rnd(8) * palette.length) % palette.length;
    const tint = palette[tintIndex];
    colors[i * 3]     = tint[0];
    colors[i * 3 + 1] = tint[1];
    colors[i * 3 + 2] = tint[2];
  }

  return { matrices, colors, count };
}

// ============================================================================
// Main entry points
// ============================================================================

/**
 * Process all vegetation (trees, bushes, shadows) for a tile.
 *
 * @param {object} data - Input data:
 *   data.tileData     - tile payload { roads, buildings, vegetation, greens, barriers, water, elevation }
 *   data.tileKey      - tile key string
 *   data.neighborRoads - neighbor road arrays for cross-tile junctions
 *   data.exclusionZones - pre-computed [{x, y, r}] urban feature exclusion zones
 *   data.tileBounds   - { south, west, north, east } for vegetation mask
 *   data.elevationOffset - elevation offset for fast elevation
 *   data.sortCenter   - { x, z } for LOD sorting
 * @param {object} config - Configuration overrides
 * @returns {object} Result with typed arrays
 */
export function processVegetationInWorker(data, config) {
  config = config || {};
  const {
    tileData, tileKey, elevation, neighborRoads, exclusionZones,
    tileBounds, elevationOffset, sortCenter,
  } = data;

  NUM_TREE_VARIANTS = Number.isInteger(config.NUM_TREE_VARIANTS) && config.NUM_TREE_VARIANTS > 0
    ? config.NUM_TREE_VARIANTS : TREE_VARIANTS.length;

  const vertExag = config.ELEVATION_VERTICAL_EXAGGERATION != null &&
    Number.isFinite(config.ELEVATION_VERTICAL_EXAGGERATION)
    ? config.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // Build fast elevation sampler (elevation comes as separate field from workerPool)
  const getElev = createFastElevation(
    elevation || tileData.elevation, elevationOffset || 0
  );

  const cx = sortCenter ? sortCenter.x : 0;
  const cz = sortCenter ? sortCenter.z : 0;

  // ── Check for pre-baked vegetation positions ──────────────────────────
  const baked = tileData.bakedVegetation;

  let positions;
  let treePositionsFlat;
  let bakedVariantIndices = null;
  let bushPositions;
  let zoneTreePosArr;
  let zoneTreeScalesArr;
  let zoneTreeVariantIndices = null;
  let zoneBushPosArr;

  if (baked && baked.treePositions && baked.treeCount > 0) {
    // ── Use pre-baked positions (skip expensive placement computation) ──
    positions = [];
    treePositionsFlat = baked.treePositions;
    for (let i = 0; i < baked.treeCount; i++) {
      positions.push({ x: baked.treePositions[i * 2], y: baked.treePositions[i * 2 + 1] });
    }
    bakedVariantIndices = baked.treeVariants || null;

    // Bush positions from baked data
    bushPositions = [];
    if (baked.bushPositions && baked.bushCount > 0) {
      for (let i = 0; i < baked.bushCount; i++) {
        bushPositions.push({ x: baked.bushPositions[i * 2], y: baked.bushPositions[i * 2 + 1] });
      }
    }

    // Zone tree positions from baked data
    zoneTreePosArr = [];
    zoneTreeScalesArr = [];
    zoneTreeVariantIndices = null;
    if (baked.zoneTreePositions && baked.zoneTreeCount > 0) {
      for (let i = 0; i < baked.zoneTreeCount; i++) {
        zoneTreePosArr.push({ x: baked.zoneTreePositions[i * 2], y: baked.zoneTreePositions[i * 2 + 1] });
      }
      if (baked.zoneTreeScales) {
        for (let i = 0; i < baked.zoneTreeCount; i++) {
          zoneTreeScalesArr.push(baked.zoneTreeScales[i]);
        }
      }
      zoneTreeVariantIndices = baked.zoneTreeVariants || null;
    }

    // Zone bush positions from baked data
    zoneBushPosArr = [];
    if (baked.zoneBushPositions && baked.zoneBushCount > 0) {
      for (let i = 0; i < baked.zoneBushCount; i++) {
        zoneBushPosArr.push({ x: baked.zoneBushPositions[i * 2], y: baked.zoneBushPositions[i * 2 + 1] });
      }
    }
  } else {
    // ── Original computation path (no baked data) ──────────────────────
    // Build vegetation mask
    const vegMask = buildVegetationMask(
      tileData.roads, tileData.buildings,
      tileData.water || [], tileBounds, neighborRoads
    );

    positions = collectAllPositions(
      tileData, tileKey, vegMask, neighborRoads || [], exclusionZones || [], config
    );

    if (positions.length > 0) {
      sortPositionsByDistance(positions, cx, cz);
    }

    treePositionsFlat = new Float32Array(positions.length * 2);
    for (let i = 0; i < positions.length; i++) {
      treePositionsFlat[i * 2] = positions[i].x;
      treePositionsFlat[i * 2 + 1] = positions[i].y;
    }

    bushPositions = collectBushPositions(positions, tileData, tileKey, vegMask);

    // Zone vegetation
    const zoneResult = collectZoneVegetation(tileData, tileKey, vegMask);
    zoneTreePosArr = zoneResult.allTreePositions;
    zoneTreeScalesArr = zoneResult.allTreeScales;
    zoneBushPosArr = zoneResult.allBushPositions;
  }

  // ── Build instance matrices from positions (shared by both paths) ────

  // Bucket main trees by variant
  const treeVariants = [];
  if (bakedVariantIndices) {
    // Use pre-baked variant indices
    // v3 P3-10(a): species by CONTEXT, not by `bakedVariantIndices[i] % N`. The baked index is kept
    // as the fallback so the blob path (4 variants) is untouched — see classifySpecies().
    const clsSeed = (tileKey || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const variantBuckets = Array.from({ length: NUM_TREE_VARIANTS }, () => []);
    for (let i = 0; i < positions.length; i++) {
      const vi = classifySpecies(positions[i], i, clsSeed, bakedVariantIndices[i]);
      variantBuckets[vi].push(positions[i]);
    }
    for (let vi = 0; vi < NUM_TREE_VARIANTS; vi++) {
      const bucket = variantBuckets[vi];
      if (bucket.length === 0) {
        treeVariants.push({ variantIndex: vi, matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 });
        continue;
      }
      sortPositionsByDistance(bucket, cx, cz);
      const inst = buildTreeVariantInstances(bucket, getElev, vertExag);
      treeVariants.push({ variantIndex: vi, matrices: inst.matrices, colors: inst.colors, count: inst.count });
    }
  } else {
    const buckets = bucketPositionsByType(positions, tileKey);
    for (let vi = 0; vi < NUM_TREE_VARIANTS; vi++) {
      const bucket = buckets[vi];
      if (bucket.length === 0) {
        treeVariants.push({ variantIndex: vi, matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 });
        continue;
      }
      sortPositionsByDistance(bucket, cx, cz);
      const inst = buildTreeVariantInstances(bucket, getElev, vertExag);
      treeVariants.push({ variantIndex: vi, matrices: inst.matrices, colors: inst.colors, count: inst.count });
    }
  }

  // Shadow instances for all trees
  const shadowInstances = positions.length > 0
    ? buildShadowInstances(positions, getElev, vertExag)
    : { matrices: new Float32Array(0), count: 0 };

  // Bush instances
  const bushInstances = bushPositions.length > 0
    ? buildBushInstances(bushPositions, getElev, vertExag)
    : { matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 };

  // Zone tree variants
  const zoneTreeVariants = [];

  if (zoneTreePosArr.length > 0) {
    const keySeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    const zoneBuckets = Array.from({ length: NUM_TREE_VARIANTS }, () => ({ pos: [], scales: [] }));

    // Zone trees carry the context of the greens polygon they were scattered into (ZONE_TREE_CTX):
    // a forest or scrub plants the wild set, a park or garden the ornamental one. Same classifier,
    // same fallback: on the blob path classifySpecies returns the legacy modulo untouched.
    if (zoneTreeVariantIndices) {
      for (let i = 0; i < zoneTreePosArr.length; i++) {
        const vi = classifySpecies(zoneTreePosArr[i], i, keySeed, zoneTreeVariantIndices[i] || 0);
        zoneBuckets[vi].pos.push(zoneTreePosArr[i]);
        zoneBuckets[vi].scales.push(zoneTreeScalesArr[i] || 1.0);
      }
    } else {
      for (let i = 0; i < zoneTreePosArr.length; i++) {
        const vi = classifySpecies(
          zoneTreePosArr[i], i, keySeed + 9999,
          Math.floor(seeded(i, keySeed + 9999) * NUM_TREE_VARIANTS));
        zoneBuckets[vi].pos.push(zoneTreePosArr[i]);
        zoneBuckets[vi].scales.push(zoneTreeScalesArr[i] || 1.0);
      }
    }

    for (let vi = 0; vi < NUM_TREE_VARIANTS; vi++) {
      const { pos, scales } = zoneBuckets[vi];
      if (pos.length === 0) {
        zoneTreeVariants.push({ variantIndex: vi, matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 });
        continue;
      }
      const inst = buildZoneTreeVariantInstances(pos, scales, keySeed, getElev, vertExag);
      zoneTreeVariants.push({ variantIndex: vi, matrices: inst.matrices, colors: inst.colors, count: inst.count });
    }
  } else {
    for (let vi = 0; vi < NUM_TREE_VARIANTS; vi++) {
      zoneTreeVariants.push({ variantIndex: vi, matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 });
    }
  }

  // Zone shadows
  const zoneShadowInstances = zoneTreePosArr.length > 0
    ? buildZoneShadowInstances(zoneTreePosArr, zoneTreeScalesArr, getElev, vertExag)
    : { matrices: new Float32Array(0), count: 0 };

  // Zone bushes
  const zoneBushInstances = zoneBushPosArr.length > 0
    ? buildZoneBushInstances(zoneBushPosArr, getElev, vertExag)
    : { matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 };

  return {
    treeVariants,
    shadowInstances,
    bushInstances,
    treePositions: treePositionsFlat,
    zoneTreeVariants,
    zoneShadowInstances,
    zoneBushInstances,
  };
}

/**
 * Process grass instances for a tile.
 *
 * @param {object} data - Input data:
 *   data.tileData       - tile payload { roads, buildings, water, elevation }
 *   data.tileKey        - tile key string
 *   data.treePositions  - flat Float32Array [x,z,x,z,...] from processVegetationInWorker
 *   data.tileBounds     - { south, west, north, east } for vegetation mask
 *   data.neighborRoads  - for vegetation mask
 *   data.elevationOffset - for fast elevation
 * @param {object} config - Configuration overrides
 * @returns {object} Result with typed arrays
 */
export function processGrassInWorker(data, config) {
  config = config || {};
  const {
    tileData, tileKey, elevation, treePositions: treePositionsFlat,
    tileBounds, neighborRoads, elevationOffset,
  } = data;

  const vertExag = config.ELEVATION_VERTICAL_EXAGGERATION != null &&
    Number.isFinite(config.ELEVATION_VERTICAL_EXAGGERATION)
    ? config.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const getElev = createFastElevation(
    elevation || tileData.elevation, elevationOffset || 0
  );

  // Rebuild vegetation mask (or receive it serialized — rebuild is simpler)
  const vegMask = buildVegetationMask(
    tileData.roads, tileData.buildings,
    tileData.water || [], tileBounds, neighborRoads || []
  );

  // Convert flat treePositions to [{x, y}] format for grass exclusion
  const treePosArray = [];
  if (treePositionsFlat && treePositionsFlat.length > 0) {
    for (let i = 0; i < treePositionsFlat.length; i += 2) {
      treePosArray.push({ x: treePositionsFlat[i], y: treePositionsFlat[i + 1] });
    }
  }

  const positions = collectGrassPositions(tileData, tileKey, vegMask, treePosArray, config);

  if (positions.length === 0) {
    return {
      grassInstances: { matrices: new Float32Array(0), colors: new Float32Array(0), count: 0 },
    };
  }

  const inst = buildGrassInstances(positions, getElev, vertExag);

  return {
    grassInstances: {
      matrices: inst.matrices,
      colors: inst.colors,
      count: inst.count,
    },
  };
}

// Note: No standalone message handler here — tileWorker.js is the entry point
// and imports these functions. This module is purely a library.

/**
 * vegetationBaker.js
 *
 * Pre-bakes vegetation (tree and bush) positions at tile build time.
 * Ported from frontend vegetationWorker.js — same PRNG, same constants,
 * same placement algorithms. Produces (x, z) positions + variant indices
 * only; the frontend still computes Y from elevation and builds meshes.
 *
 * No Three.js dependencies. Pure math.
 */
import { latLonToMercator, mercatorToWorld, worldToMercator, getOriginMercator } from '../projection.js';

// ============================================================================
// Coordinate helpers
// ============================================================================

const R = 6378137;

function latLonToWorld(lat, lon) {
  const m = latLonToMercator(lat, lon);
  return mercatorToWorld(m.x, m.y);
}

// ============================================================================
// Constants (must match frontend vegetationWorker.js exactly)
// ============================================================================

const NUM_TREE_VARIANTS = 4;

const ROAD_RENDER_WIDTH = {
  motorway: 30, trunk: 26, primary: 20, secondary: 16, tertiary: 13,
  motorway_link: 15, trunk_link: 13, primary_link: 11, secondary_link: 10,
  tertiary_link: 9, residential: 10, service: 7, unclassified: 10,
  living_street: 8, track: 5, path: 2, footway: 2, cycleway: 2,
};
const ROAD_WIDTH_BY_TYPE = ROAD_RENDER_WIDTH;

const TREE_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified',
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
const ENABLE_ROADSIDE_TREES = true;
const ROADSIDE_SPACING_MIN = 2;
const ROADSIDE_SPACING_MAX = 5;
const ROADSIDE_TREE_CAP = 4000;

// Ground road grid
const GRID_RES = 0.5;
const GRID_PAD = 5;

// Bush constants
const BUSH_CAP = 3000;
const BUSH_ROAD_SPACING_MIN = 4;
const BUSH_ROAD_SPACING_MAX = 8;
const BUSH_ROAD_OFFSET_MIN = 3;
const BUSH_ROAD_OFFSET_MAX = 7;
const BUSH_BARRIER_SPACING = 4;
const BUSH_BARRIER_OFFSET = 1.2;

// Zone vegetation
// Raised from 800 (VEG-FIX-2). Not a performance limit — a flat Eixample tile already bakes and
// renders 3,812 trees from OSM street-tree nodes, so 800 for a whole wooded hillside was arbitrary.
const MAX_ZONE_TREES_PER_TILE = 3000;
const MAX_ZONE_BUSHES_PER_TILE = 600;

const ZONE_RULES = {
  forest: {
    treeDensity: 1 / 25, treeCap: 600, bushDensity: 0, bushCap: 200,
    clearings: true, clearingAreaFrac: [0.10, 0.15], clearingRadius: [6, 15],
    clearingBushDensity: 1 / 8, treeScaleRange: [0.7, 1.3],
  },
  park: {
    treeDensity: 1 / 500, treeCap: 1800, bushDensity: 1 / 200, bushCap: 250,
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
/**
 * VEG-FIX-2 — WOODEDNESS BY AREA. User-reported: hills read as bare.
 *
 * Measured on the Montjuïc tile: its greens are 236,238 m2 of `park` against just 16,372 m2 of
 * `forest`, and `park` density is 1/500 m2 — one tree per 22 m of spacing. That rule describes a
 * formal city square, and OSM uses `leisure=park` for BOTH a 20x20 m plaza garden AND an entire
 * wooded hill. The baker treated them identically, so the hill got 332 trees while a flat Eixample
 * tile got 3,812 from real street-tree nodes. The hill was 11x sparser than the city.
 *
 * Area is the signal that separates them, and it needs no new data: a park of a few thousand square
 * metres is landscaped and sparse; one of tens of hectares is woodland with paths through it.
 * Below ONE hectare nothing changes. Above TEN, density reaches the wooded target. In between it
 * interpolates on log(area), because the perceptual step from 1 to 10 ha is not linear.
 *
 * Applied to park/grass/scrub only. `garden` is formal by definition and `forest` is already dense.
 */
const WOODED_MIN_AREA = 10_000;      // 1 ha — below this, the authored density stands
const WOODED_FULL_AREA = 100_000;    // 10 ha — at or above this, full wooded density
const WOODED_DENSITY = { park: 1 / 60, grass: 1 / 120, scrub: 1 / 90 };

function woodedDensity(type, baseDensity, areaM2) {
    const target = WOODED_DENSITY[type];
    if (!target || !(areaM2 > WOODED_MIN_AREA)) return baseDensity;
    if (areaM2 >= WOODED_FULL_AREA) return target;
    const t = Math.log(areaM2 / WOODED_MIN_AREA) / Math.log(WOODED_FULL_AREA / WOODED_MIN_AREA);
    return baseDensity + (target - baseDensity) * t;
}

const DEFAULT_ZONE_RULE = {
  treeDensity: 1 / 600, treeCap: 150, bushDensity: 1 / 200, bushCap: 200,
  treeScaleRange: [0.6, 1.0],
};

// ============================================================================
// Deterministic PRNG (MUST be identical to frontend)
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

function toXYPolygon(coords) {
  if (!coords || coords.length < 3) return null;
  if (typeof coords[0].x === 'number') return coords;
  return coords.map((c) => ({ x: c[0], y: c[1] }));
}

// ============================================================================
// Rasterization helpers (vegetation mask + road grid)
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

// ============================================================================
// Vegetation mask
// ============================================================================

function buildVegetationMask(roads, buildings, waterAreas, tileBounds) {
  if (!tileBounds) return null;

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
      // Block EVERY road footprint, including tunnel/below-grade (was: skipped → trees landed on
      // daylighted trench corridors and multi-level roads = "trees on the road where one is above").
      // Minor cost: a thin no-tree strip over deep sealed tunnels; big win: no trees in open cuts.
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

// ============================================================================
// Ground road grid
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
// Tree position collection
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

function getRoadsideTreePositions(tileData, tileKey) {
  if (!ENABLE_ROADSIDE_TREES) return [];
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
    const allRoadSources = [...roads];
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
        const stepSpacing = ROADSIDE_SPACING_MIN + seeded(s, 0) * (ROADSIDE_SPACING_MAX - ROADSIDE_SPACING_MIN);
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
        if (!skipLeft) positions.push({ x: cx + perpX * offL, y: cz + perpZ * offL });
        if (!skipRight) positions.push({ x: cx - perpX * offR, y: cz - perpZ * offR });
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

function collectAllPositions(tileData, tileKey, vegMask, config) {
  const cap = Math.max(1, config.MAX_TREES_PER_TILE || 6000);
  const positions = [];
  const buildings = tileData.buildings || [];
  const roads = tileData.roads || [];

  function isExcluded(x, z, roadMargin) {
    roadMargin = roadMargin !== undefined ? roadMargin : 3;
    return !isVegetationAllowed(vegMask, x, z, roadMargin) ||
           isInsideOrNearBuilding(x, z, buildings);
  }

  const groundGrid = buildGroundRoadGrid(roads);

  // Roadside trees
  const roadside = getRoadsideTreePositions(tileData, tileKey);
  for (const p of roadside) {
    if (isOnGroundRoad(groundGrid, p.x, p.y)) { REJECTS.roadOnRoad++; continue; }
    if (!isInsideOrNearBuilding(p.x, p.y, buildings)) {
      positions.push({ x: p.x, y: p.y });
    } else REJECTS.roadInBuilding++;
    if (positions.length >= cap) break;
  }

  if (positions.length < cap) {
    const perim = getBuildingPerimeterTreePositions(tileData, vegMask);
    for (const p of perim) {
      if (!isExcluded(p.x, p.y, 2)) {
        positions.push(p);
      } else REJECTS.perimExcluded++;
      if (positions.length >= cap) break;
    }
  }

  return positions.slice(0, cap);
}

function sortPositionsByDistance(positions, cx, cz) {
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    p._distSq = (p.x - cx) * (p.x - cx) + (p.y - cz) * (p.y - cz);
  }
  positions.sort((a, b) => a._distSq - b._distSq);
}

function bucketPositionsByType(positions, tileKey) {
  const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const variants = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    variants[i] = Math.floor(seeded(i, seed) * NUM_TREE_VARIANTS) % NUM_TREE_VARIANTS;
  }
  return variants;
}

// ============================================================================
// Bush position collection
// ============================================================================

function collectBushPositions(treePositions, tileData, tileKey, vegMask) {
  const roads = tileData.roads || [];
  const buildings = tileData.buildings || [];
  const bushes = [];

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 3) &&
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
// Zone vegetation
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
      const density = woodedDensity(green.type, rule.treeDensity, polygonAreaXZ(poly));
      const scattered = zoneScatterInPolygon(poly, density, zoneSeed, cap * 2, bbox);
      for (const p of scattered) {
        if (allTreePositions.length >= MAX_ZONE_TREES_PER_TILE) break;
        if (clearings.length > 0 && isInClearing(p.x, p.y, clearings)) continue;
        if (isValid(p.x, p.y)) {
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
// Convert tile data to {x, y} point format for vegetation algorithms
// ============================================================================

/**
 * Convert the tile road data from [[x, yUp, z], ...] to [{x, y}, ...] format
 * matching the frontend's convention where y = world Z.
 */
/**
 * ── N-25: THE COORDINATE SPACE, WHICH WAS NEVER ONE SPACE ──────────────────────────────────────
 *
 * This baker mixes two coordinate spaces and always has:
 *   • `road.points`        ABSOLUTE MERCATOR  (~245,000 / 5,071,000)
 *   • `building.footprint` real-metre WORLD   (~7,000 / 5,600)
 *   • `greens`, `water`    real-metre WORLD
 *   • `tileBounds`         used via latLonToWorld → the mask grid is in WORLD
 *
 * Nothing errors when those meet. Measured in the shipped tiles before this fix
 * (`backend/tools/vegSpaceAudit.mjs`):
 *
 *   • ALL 135,228 zone trees and ALL 54,886 zone bushes were emitted in WORLD, and
 *     `readBakedVegetation` converts every entry as if it were Mercator — so a park tree at
 *     (7172.9, 5514.5) landed at (-171358, -3797422). **Every tree and bush in every park in
 *     Barcelona was 3,800 km outside the map.** 316,063 positions in total.
 *   • The vegetation MASK rasterised Mercator roads into a WORLD-bounded grid, so its road
 *     component blocked nothing, ever — N-7's "a mask that blocks nothing is indistinguishable
 *     from a mask with generous margins", still true.
 *   • `sortPositionsByDistance` ranked Mercator positions by distance to a WORLD centre.
 *
 * The fix is to pick ONE space inside the baker, and the only choice that does not move the output
 * contract is WORLD: the mask bounds, the buildings, the greens and both distance sorts are already
 * world, so converting the roads makes four separate things correct at once. The emitted arrays are
 * converted back to Mercator at the end, because that is what the reader expects and 97% of what
 * shipped was already that.
 *
 * ⚠ Do not "simplify" this by converting buildings to Mercator instead. That would leave the mask
 * grid and both sorts in world, i.e. it would fix the arithmetic and keep the bug.
 */

/** Order-of-magnitude space check. Mercator eastings are ~235-250 k; Barcelona world is 0-20 km. */
function looksMercator(x) { return Math.abs(x) > 100000; }

/**
 * ── D-23: A COUNTER AT THE POINT OF DECISION ──────────────────────────────────────────────────
 *
 * The previous N-25 attempt deleted 99,715 trees and left the offender count at exactly 4,029 — the
 * identical absolute number. Nobody could tell whether the guard was firing and missing, or not
 * firing at all, because nothing counted. It was not firing: the grid was 240 km from the trees.
 *
 * These counters make that impossible to repeat. `buildRegion` prints them at the end of a bake; a
 * guard that rejects ZERO across a whole region is a guard that is not wired to anything, whatever
 * the tree count did.
 */
export const REJECTS = { roadOnRoad: 0, roadInBuilding: 0, perimExcluded: 0, zoneExcluded: 0 };
/** How many space assertions actually EVALUATED — see the note at the call site. */
export const VEG_SPACE_CHECKS = { ran: 0, tiles: 0 };
export function resetVegRejects() {
  REJECTS.roadOnRoad = 0; REJECTS.roadInBuilding = 0; REJECTS.perimExcluded = 0; REJECTS.zoneExcluded = 0;
}

function assertVegSpace(label, sample, wantMercator) {
  if (sample === undefined || sample === null || !Number.isFinite(sample)) return;
  const is = looksMercator(sample);
  if (is !== wantMercator) {
    throw new Error(
      `vegetationBaker: ${label} is in ${is ? 'MERCATOR' : 'WORLD'} space but ${wantMercator ? 'MERCATOR' : 'WORLD'} was expected `
      + `(sample x=${sample}). This is N-25: mixing the two silently throws vegetation thousands of km `
      + `out of the map. Fix the producer, do not relax this check.`);
  }
}

/**
 * Road points → {x, y} in WORLD metres.
 *
 * ⚠ The name is N-7's and the conversion is the one N-7 was reverted before shipping. Everything
 * downstream in this file — the mask, the ground-road grid, the junction clearance, both distance
 * sorts — assumes world, and got Mercator.
 */
function convertRoadsForVeg(roads) {
  if (!roads || roads.length === 0) return [];
  let checked = false;
  return roads.map(r => ({
    ...r,
    points: (r.points || []).map(p => {
      const mx = Array.isArray(p) ? p[0] : p.x;
      const my = Array.isArray(p) ? p[2] : p.y;
      if (!checked && Number.isFinite(mx)) { assertVegSpace('road.points', mx, true); checked = true; }
      const w = mercatorToWorld(mx, my);
      return { x: w.x, y: w.z };
    }),
  }));
}

/**
 * Convert buildings footprint from [[x, z], ...] to [{x, y}, ...] format.
 */
function convertBuildingsForVeg(buildings) {
  if (!buildings || buildings.length === 0) return [];
  return buildings.map(b => ({
    ...b,
    footprint: (b.footprint || []).map(p => {
      if (Array.isArray(p)) return { x: p[0], y: p[1] };
      return p;
    }),
  }));
}

/**
 * Convert green polygons from [[x, z], ...] to [{x, y}, ...] format.
 */
function convertGreensForVeg(greens) {
  if (!greens || greens.length === 0) return [];
  return greens.map(g => ({
    ...g,
    polygon: (g.polygon || []).map(p => {
      if (Array.isArray(p)) return { x: p[0], y: p[1] };
      return p;
    }),
  }));
}

/**
 * Convert water polygons for vegetation mask (just needs polygon array).
 */
/**
 * Water polygons → {x, y} in WORLD metres.
 *
 * ⚠ THE THIRD SPACE IN THIS FILE. Water is stored and carried as ABSOLUTE MERCATOR (verified in the
 * shipped tiles: 238013.0, 5072888.0), while greens and buildings are WORLD. It is handed straight
 * to `buildVegetationMask`, whose grid is bounded by `latLonToWorld(tileBounds)` — so the mask's
 * WATER component has never blocked anything either, for the same reason its road component never
 * did. Found only because the space assertion added for roads was about to throw on it.
 */
function convertWaterForVeg(water) {
  if (!water || water.length === 0) return [];
  let checked = false;
  return water.map(w => ({
    ...w,
    polygon: (w.polygon || []).map(p => {
      const mx = Array.isArray(p) ? p[0] : p.x;
      const my = Array.isArray(p) ? p[1] : p.y;
      if (!checked && Number.isFinite(mx)) { assertVegSpace('water.polygon', mx, true); checked = true; }
      const c = mercatorToWorld(mx, my);
      return { x: c.x, y: c.z };
    }),
  }));
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Pre-bake vegetation positions for a tile.
 *
 * @param {object} tileData - { roads, buildings, greens, water, barriers }
 *   Roads have points as [[x, yUp, z], ...], buildings have footprint as [[x, z], ...]
 * @param {object} elevation - { south, west, north, east, ... }
 * @param {object} tileBounds - { south, west, north, east }
 * @returns {{ treePositions: Float32Array, treeVariants: Uint8Array, treeCount: number,
 *             bushPositions: Float32Array, bushCount: number }}
 */
export function bakeVegetation(tileData, elevation, tileBounds) {
  // Convert data formats to match frontend worker expectations
  const vegRoads = convertRoadsForVeg(tileData.roads);
  const vegBuildings = convertBuildingsForVeg(tileData.buildings);
  const vegGreens = convertGreensForVeg(tileData.greens);
  const vegWater = convertWaterForVeg(tileData.water);

  // The other three producers are already world; assert rather than assume, so a future change to
  // any of them fails the bake instead of silently relocating a park.
  //
  // ⚠ `assertVegSpace` returns quietly on a non-finite sample, which makes a wrong ACCESSOR PATH
  // indistinguishable from a clean bake — the same shape of hole D-23 is about. So each sample is
  // taken from the first entry that actually has geometry, and `vegSampled` records which checks
  // really ran. A check that never evaluates is worse than no check: it reads as reassurance.
  const firstX = (arr, key) => {
    for (const e of arr || []) {
      const pts = key ? e?.[key] : e;
      if (Array.isArray(pts) && pts.length && Number.isFinite(pts[0]?.x)) return pts[0].x;
    }
    return undefined;
  };
  const vegSampled = [];
  for (const [label, sample] of [
    ['building.footprint', firstX(vegBuildings, 'footprint')],
    ['greens.polygon',     firstX(vegGreens, 'polygon')],
    ['water.polygon',      firstX(vegWater, 'polygon')],
  ]) {
    if (sample === undefined) continue;      // this tile genuinely has none of that feature
    assertVegSpace(label, sample, false);
    vegSampled.push(label);
  }
  VEG_SPACE_CHECKS.ran += vegSampled.length;
  VEG_SPACE_CHECKS.tiles++;

  const vegTileData = {
    roads: vegRoads,
    buildings: vegBuildings,
    greens: vegGreens,
    water: vegWater,
    barriers: tileData.barriers || [],
  };

  const tileKey = tileData.tileId || '';

  // Build vegetation mask
  const vegMask = buildVegetationMask(
    vegRoads, vegBuildings, vegWater, tileBounds
  );

  // Default config matching frontend defaults
  const config = { MAX_TREES_PER_TILE: 6000 };

  // Collect main tree positions (roadside + building perimeter)
  let positions = collectAllPositions(vegTileData, tileKey, vegMask, config);

  // Sort by distance from tile center (matches frontend behavior with center=(0,0))
  if (positions.length > 0) {
    // Compute tile center in world coords
    const sw = latLonToWorld(tileBounds.south, tileBounds.west);
    const ne = latLonToWorld(tileBounds.north, tileBounds.east);
    const cx = (sw.x + ne.x) / 2;
    const cz = (sw.z + ne.z) / 2;
    sortPositionsByDistance(positions, cx, cz);
  }

  // Assign variants
  const treeVariantIndices = bucketPositionsByType(positions, tileKey);

  // ── OUTPUT CONTRACT: MERCATOR ──────────────────────────────────────────────────────────────
  // `tileParserWorker.readBakedVegetation` converts every baked position with
  // `(v - origin) * cos(lat)`, i.e. it reads Mercator. Everything above this line is WORLD. One
  // helper, used for all four arrays, so no array can be forgotten the way zone trees and zone
  // bushes were — they were emitted in world and every one of them left the map.
  const flatMerc = (arr) => {
    const out = new Float32Array(arr.length * 2);
    for (let i = 0; i < arr.length; i++) {
      const m = worldToMercator(arr[i].x, arr[i].y);
      out[i * 2] = m.x; out[i * 2 + 1] = m.y;
    }
    return out;
  };

  const treePositions = flatMerc(positions);
  const treeVariants = treeVariantIndices;

  // Collect bush positions
  const bushPosArr = collectBushPositions(positions, vegTileData, tileKey, vegMask);

  // Bushes are re-ordered below (nearest-first) before being flattened — see the sort block.
  let bushPositions = null;

  // Collect zone vegetation
  const zoneResult = collectZoneVegetation(vegTileData, tileKey, vegMask);

  // ⚠ EVERY ARRAY THE RENDERER FADES MUST BE SORTED NEAREST-FIRST.
  //
  // The LOD shows the FIRST N instances of a tile's handle and treats that order as nearest-first.
  // Only the main tree array (~:1121) actually earned the name. Zone trees, zone bushes and the
  // main bush array all came out in POLYGON order, so "show 56%" meant "show the first few
  // polygons" — whole clumps appearing and vanishing as the fraction moved, instead of the canopy
  // thinning evenly. User-reported on the hills.
  //
  // It stayed invisible because street trees WERE sorted and hills had ~0 zone trees until VEG-FIX-2
  // gave them 1,077 each. Bushes fade over 45–90 m, so their clumping is close-range and was read
  // as ordinary pop-in.
  {
    const swz = latLonToWorld(tileBounds.south, tileBounds.west);
    const nez = latLonToWorld(tileBounds.north, tileBounds.east);
    const zcx = (swz.x + nez.x) / 2, zcz = (swz.z + nez.z) / 2;
    // Returns the permutation rather than sorting in place, because positions and scales are
    // PARALLEL arrays — sorting one alone silently swaps every tree's size.
    const nearestFirst = (arr) => arr
      .map((pt, i) => ({ i, d: (pt.x - zcx) ** 2 + (pt.y - zcz) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .map((o) => o.i);

    if (zoneResult.allTreePositions.length > 0) {
      const order = nearestFirst(zoneResult.allTreePositions);
      zoneResult.allTreePositions = order.map((i) => zoneResult.allTreePositions[i]);
      zoneResult.allTreeScales = order.map((i) => zoneResult.allTreeScales[i]);
    }
    if (zoneResult.allBushPositions.length > 0) {
      const order = nearestFirst(zoneResult.allBushPositions);
      zoneResult.allBushPositions = order.map((i) => zoneResult.allBushPositions[i]);
    }
    if (bushPosArr.length > 0) {
      const order = nearestFirst(bushPosArr);
      bushPositions = flatMerc(order.map((i) => bushPosArr[i]));
    }
  }
  if (!bushPositions) bushPositions = new Float32Array(0);

  // Zone tree positions — WORLD until here, Mercator on disk. Emitting these in world is the bug
  // that put every park tree in Barcelona 3,800 km off the map.
  const zoneTreePositions = flatMerc(zoneResult.allTreePositions);

  // Zone tree variants
  const keySeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const zoneTreeVariants = new Uint8Array(zoneResult.allTreePositions.length);
  for (let i = 0; i < zoneResult.allTreePositions.length; i++) {
    zoneTreeVariants[i] = Math.floor(seeded(i, keySeed + 9999) * NUM_TREE_VARIANTS) % NUM_TREE_VARIANTS;
  }

  // Zone tree scales
  const zoneTreeScales = new Float32Array(zoneResult.allTreeScales);

  // Zone bush positions
  const zoneBushPositions = flatMerc(zoneResult.allBushPositions);

  return {
    treePositions,
    treeVariants,
    treeCount: positions.length,
    bushPositions,
    bushCount: bushPosArr.length,
    zoneTreePositions,
    zoneTreeVariants,
    zoneTreeScales,
    zoneTreeCount: zoneResult.allTreePositions.length,
    zoneBushPositions,
    zoneBushCount: zoneResult.allBushPositions.length,
  };
}

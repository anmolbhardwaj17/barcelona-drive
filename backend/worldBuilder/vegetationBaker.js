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
import { latLonToMercator, mercatorToWorld, getOriginMercator } from '../projection.js';

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

// N-13: was 10, giving discs of 10-18 m — up to a third of an Eixample block cleared at every
// corner. 5 (=> 5-9 m with the width term) is what the offline replay measured at 31.0%.
const JUNCTION_TREE_CLEARANCE = 5;
/** cos of the angle below which two ways count as the same street continuing (~25 deg). */
const T_COLLINEAR_COS = 0.9;

const TREE_ROAD_TYPES = new Set([
  'primary', 'secondary', 'tertiary',
  'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'living_street', 'unclassified',
]);

// Vegetation mask constants
const VEG_MASK_RESOLUTION = 0.5;
const VEG_MASK_PAD = 20;
// N-7c: a KERB ALLOWANCE, nothing more. The arithmetic that killed Gran Via's street trees:
//   blocked = kerbToKerb/2 + ROAD_INFLATE, and a perimeter tree adds its own margin on top.
// At ROAD_INFLATE 3.0 (and an oversized legacy width table) that was kerb + 5 m; at 1.0 it was
// still kerb + 3 m once the tree's own margin of 2 was added. A Barcelona pavement is 3-4 m wide,
// so the plantable band was squeezed to nothing and `isInsideOrNearBuilding` rejected whatever was
// left. The city's most characteristic object cannot fit in the space its own road model leaves it.
// 0.3 m = the kerb. A tree may stand ON the pavement; it may not stand on the asphalt.
const ROAD_INFLATE = 0.3;

/** N-10 proof-of-work (D-23): vegetation dropped for being planted outside its own tile. */
const _vegClipStats = { trees: 0, treesKept: 0 };
export function getVegClipStats() { return _vegClipStats; }
const BRIDGE_INFLATE = 18.0;  // wide margin to prevent tree canopies clipping through flyovers
const JUNCTION_CLUSTER_DIST_SQ = 25;
const JUNCTION_RADIUS_MULT = 2.0;
const SINGLE_ENDPOINT_EXTRA = 5.0;

// Tree placement
const ENABLE_ROADSIDE_TREES = true;
const ROADSIDE_SPACING_MIN = 2;
const ROADSIDE_SPACING_MAX = 4;   // N-20: was 5. Measured 9.7 m/side against a real ~8 m.
const ROADSIDE_TREE_CAP = 4000;
// Kerb width, mirroring BCN_DIMS.CURB_WIDTH (frontend/src/map/barcelona-constants.js). A street
// tree is planted BEYOND the kerb, so this is part of the offset, not a rounding allowance.
const CURB_WIDTH = 0.3;

// Ground road grid
const GRID_RES = 0.5;
const GRID_PAD = 5;

// Bush constants
const BUSH_CAP = 3000;
const BUSH_ROAD_SPACING_MIN = 4;
const BUSH_ROAD_SPACING_MAX = 8;
// P4-17b: superseded by BUSH_KERB_CLEAR_* — these were CENTRELINE offsets and R-W1 moved the
// kerb out from under them. Kept only so the diff reads: they are no longer referenced.
const BUSH_KERB_CLEAR_MIN = 0.8;   // metres BEYOND the kerb
const BUSH_KERB_CLEAR_MAX = 3.5;
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
      // N-7b: trust R-W1's BAKED paved width. `ROAD_RENDER_WIDTH` is an 11th width table (primary
      // 20 m, motorway 30 m) that predates the width model and is far wider than the real thing;
      // `max()` with it plus a 3 m inflate blocked ~13 m either side of Gran Via's centreline,
      // which is past the building line. That never showed while the mask was in the wrong
      // coordinate space and blocked nothing (N-7) — the moment the mask started working it ate
      // the avenue's street trees. Use the drawn kerb-to-kerb width and a margin that only keeps
      // vegetation off the kerb itself; the legacy table survives as a fallback for a road with
      // no baked section.
      const bakedW = Number(road.kerbToKerbW ?? road.width);
      const w = Number.isFinite(bakedW) && bakedW > 0
        ? bakedW
        : (ROAD_RENDER_WIDTH[road.highwayType] ?? 6);
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

/**
 * N-11 — the ROAD CORRIDOR as a grid: kerb-to-kerb plus both pavements, plus a margin.
 *
 * `buildGroundRoadGrid` above deliberately INSETS by 3-5 m, so it only catches something well
 * inside the carriageway. That is right for "is this tree in the road" and useless for "is this
 * bush on the pavement" — which is why source 2 below planted a bush every 4-8 m along both kerbs
 * of every street and nothing stopped it. Measured: bushes outnumbered surviving street trees
 * almost 1:1, which is the reported "mostly bushes and rocks" along the road.
 *
 * The user's ruling: bushes and stones near roads are not wanted at all, because open ground still
 * carries them. So this grid is the whole right-of-way, and the bush test is a rejection.
 */
function buildCorridorGrid(roads) {
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
    // R-W1: read the baked corridor, never re-derive it. Fall back to kerb-to-kerb plus a nominal
    // pair of pavements only for a road the width model never classified.
    const corridor = Number.isFinite(Number(road.corridorW))
      ? Number(road.corridorW)
      : (Math.max(Number(road.kerbToKerbW ?? road.width) || 0, ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6)
         + 2 * (Number(road.sidewalkW) || 0));
    const half = corridor / 2 + 1.0;   // + a bush's own footprint, so none can overhang the kerb
    if (half <= 0) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(grid, gridW, gridH, minX, minZ, GRID_RES,
        pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
    }
  }
  return { grid, gridW, gridH, minX, minZ };
}

/**
 * N-20 — the DRIVABLE SURFACE as a grid: kerb to kerb, with no inset.
 *
 * `buildGroundRoadGrid` above deliberately INSETS by 3-5 m, so it marks only the middle of the
 * road. That is defensible for an OSM-tagged tree in a median; it is wrong as the only guard on a
 * PROCEDURAL roadside tree, because it accepts anything between the kerb and 5 m inside the
 * asphalt. On Gran Via (kerbToKerb 15 m, rawHalf 7.5, inset 5) it marks the middle 5 m of a 15 m
 * road and passes every tree standing in the outer 5 m of each carriageway — trunks in the driving
 * lane, which is what the user photographed.
 *
 * It became visible now rather than earlier because N-13 grew the tree count 53%, so the absolute
 * number of trees standing in a road grew 53% with it. The rate was always ~4% (ticket N-7b).
 */
function buildPavedGrid(roads) {
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
    // R-W1: kerb-to-kerb is the DRAWN asphalt, parking bays included. Plus a trunk's own radius,
    // so a tree cannot overhang the kerb it was planted behind.
    const paved = Number.isFinite(Number(road.kerbToKerbW))
      ? Number(road.kerbToKerbW)
      : Math.max(Number(road.width) || 0, ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const half = paved / 2 + 0.6;
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

/**
 * N-13 — is this endpoint-meets-segment a way CONTINUATION rather than a real T-junction?
 *
 * Under `noClipTileStrategy` one street is several way records, so a record's endpoint lies exactly
 * on the next record of the same street. Booking those as junctions cleared 45% of the tile's
 * roadside tree slots. A continuation runs straight on; a real T meets at an angle.
 *
 * @param {number} edx @param {number} edz  unit terminal direction of the ending way
 * @param {number} sx  @param {number} sz   the candidate segment's vector (need not be unit)
 * @returns {boolean} true if collinear within ~25 deg (either sense), i.e. NOT a junction
 */
export function isWayContinuation(edx, edz, sx, sz) {
  const sl = Math.hypot(sx, sz);
  if (sl < 1e-9) return false;
  return Math.abs((edx * sx + edz * sz) / sl) > T_COLLINEAR_COS;
}

/** Radius of a no-tree disc at a junction, from the widest road meeting there. */
export function junctionTreeClearance(widestRoadW) {
  return Math.min(JUNCTION_TREE_CLEARANCE + widestRoadW * 0.2, 9);
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

  const JUNCTION_CLUSTER_DIST = 5;

  // Build junction set
  const junctions = [];
  {
    const allEndpoints = [];
    const allRoadSources = [...roads];
    for (let ri = 0; ri < allRoadSources.length; ri++) {
      const road = allRoadSources[ri];
      if (road.tunnel) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
      const w = Math.max(dataW, typeW);
      // N-13: carry the source road and the TERMINAL DIRECTION. Both are needed to tell a real
      // T-junction from a way that simply continues into the next record — see below.
      const n = pts.length;
      const l0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const l1 = Math.hypot(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y) || 1;
      allEndpoints.push({ x: pts[0].x, z: pts[0].y, w, ri,
        dx: (pts[1].x - pts[0].x) / l0, dz: (pts[1].y - pts[0].y) / l0 });
      allEndpoints.push({ x: pts[n - 1].x, z: pts[n - 1].y, w, ri,
        dx: (pts[n - 1].x - pts[n - 2].x) / l1, dz: (pts[n - 1].y - pts[n - 2].y) / l1 });
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
        const clearance = junctionTreeClearance(maxW);
        junctions.push({ x: cx, z: cz, rSq: clearance * clearance });
      }
    }

    // T-junction detection
    // ── N-13 · A WAY ENDING IS NOT A JUNCTION ────────────────────────────────────────────────
    //
    // This fired for EVERY endpoint lying within 8 m of ANY road segment. Under
    // `noClipTileStrategy` a single street is several way RECORDS, so each record's endpoint sits
    // exactly on its own continuation — and every one of them was booked as a T-junction with a
    // 10-18 m no-tree disc. Measured on the spawn tile (16_33161_24477): 353 of 501 discs were
    // these phantoms, the 500-disc cap was HIT, and **45.0% of every roadside tree slot in the
    // tile was rejected as "near a junction"**. That is the missing avenue.
    //
    // Two tests separate a real T from a continuation:
    //   · it is not the endpoint's OWN way, and
    //   · the ways are not COLLINEAR — a continuation runs straight on (cos > 0.9, ~25 deg),
    //     a genuine T meets at an angle.
    // With both, the same tile rejects 31.0% — and that residue is real: an Eixample corner every
    // 113 m legitimately clears its chamfer. The disc also shrinks to 5-9 m; 10-18 m was up to a
    // third of a block, and Barcelona plants right up to the chamfer.
    const T_JUNCTION_DIST_SQ = 64;
    for (const ep of allEndpoints) {
      for (let rj = 0; rj < allRoadSources.length; rj++) {
        const road = allRoadSources[rj];
        if (road.tunnel) continue;
        if (rj === ep.ri) continue;                 // its own way is not a junction with itself
        const pts = road.points || [];
        if (pts.length < 2) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          const d2 = distSqToSegment(ep.x, ep.z, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
          if (d2 < T_JUNCTION_DIST_SQ && d2 > 0.5) {
            if (isWayContinuation(ep.dx, ep.dz,
                  pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)) continue;
            const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
            const typeW = ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6;
            const w = Math.max(dataW, typeW, ep.w);
            const clearance = junctionTreeClearance(w);
            junctions.push({ x: ep.x, z: ep.z, rSq: clearance * clearance });
            break;
          }
        }
        if (junctions.length > 4000) break;   // N-13: was 500, and the phantoms alone filled it
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
    // ── N-20 · PLANT AGAINST THE BAKED KERB, NOT AN 11TH WIDTH TABLE ──────────────────────────
    //
    // This was `Math.max(dataW3, typeW3)` — the wider of the baked width and `ROAD_RENDER_WIDTH`.
    // That table is systematically WIDER than what the bake actually produces:
    //
    //     type          table   baked kerbToKerbW
    //     primary        20          15
    //     secondary      16          10
    //     tertiary       13           7
    //     residential    10           5
    //
    // Taking the max therefore pushed every tree metres past the real kerb. On a residential
    // street the pit landed ~6.8 m from the centreline while the building line sits at ~5.5 m, so
    // the tree was placed inside the building and then thrown away by `isInsideOrNearBuilding` —
    // measured at **18.2% of surviving roadside trees rejected near a building**. That is the
    // "there are very few trees" report: they were generated, misplaced, and discarded.
    //
    // R-W1 already says the answer: `width` is an alias of the baked `kerbToKerbW`. Use it, and
    // fall back to the table only for a road the width model never classified. Line 346 in this
    // same file was fixed for exactly this reason (N-7b) and this call site was missed — the
    // copy-pair hazard again (H10).
    const bakedW = Number.isFinite(Number(road.kerbToKerbW)) ? Number(road.kerbToKerbW)
      : (Number.isFinite(Number(road.width)) ? Number(road.width) : 0);
    const roadWidth = bakedW > 0 ? bakedW : (ROAD_WIDTH_BY_TYPE[road.highwayType] ?? 6);
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
        // N-20: 0.15 -> 0.08. The gaps read as missing trees, not as natural variation.
        const skipLeft = seeded(s, 8) < 0.08;
        const skipRight = seeded(s, 9) < 0.08;
        const longJitter = (seeded(s, 10) - 0.5) * 3.0;
        const tBase = (dist + longJitter) / segLen;
        const tc = Math.max(0, Math.min(1, tBase));
        const cx = a.x + dx * tc, cz = a.y + dz * tc;
        // ── P4-17b · PLANT THE TREE IN THE PAVEMENT, NOT ON THE KERB LINE ──────────────────────
        //
        // This was `halfW + 0.1..0.5 +/- 0.25`, i.e. the tree pit sat ON the kerb with the jitter
        // straddling it. That was fine when a residential road was 4 m wide (halfW 2 m, tree at
        // ~2.3 m, safely in the verge). R-W1 made the same road 10.4 m — halfW 5.2 — so the offset
        // landed the tree exactly on the carriageway edge and the jitter pushed half of them in.
        // Measured on the shipped tiles: **27.79% of baked tree positions were inside a drivable
        // carriageway, 5.88% well inside it.** That is the user report "trees in the middle of the
        // road", and it is R-W1 fallout: the widths moved, this offset did not follow.
        //
        // A Barcelona plane tree stands in the MIDDLE of the pavement, roughly 1.5 m back from the
        // kerb, so the pit clears both the kerb and the building line. Derive it from the road's own
        // baked `sidewalkW` (R-W1) rather than a constant — a 3 m pavement and a 4 m one want
        // different setbacks, and a road with no pavement wants a verge offset instead.
        const swW = Number.isFinite(Number(road.sidewalkW)) ? Number(road.sidewalkW) : 0;
        const setback = swW > 0.8
          ? Math.min(1.6, Math.max(0.9, swW * 0.45))   // mid-pavement, clamped either side
          : 1.2;                                        // no pavement: sit it in the verge
        const treeBase = halfW + CURB_WIDTH + setback;
        // Jitter is kept — a perfectly ruled line of trees reads as fake — but it may no longer
        // reach back across the kerb. Clamp the whole offset to stay outside the carriageway.
        const minOff = halfW + CURB_WIDTH + 0.4;
        const jitL = (seeded(s, 11) - 0.5) * (isLink ? 0.4 : 0.5);
        const jitR = (seeded(s, 12) - 0.5) * (isLink ? 0.4 : 0.5);
        const offL = Math.max(minOff, treeBase + jitL);
        const offR = Math.max(minOff, treeBase + jitR);

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
  const pavedGrid = buildPavedGrid(roads);   // N-20: the inset grid is not a carriageway test

  // Roadside trees
  const roadside = getRoadsideTreePositions(tileData, tileKey);
  for (const p of roadside) {
    if (isOnGroundRoad(pavedGrid, p.x, p.y)) continue;
    // N-13: 0.6 m, not the default 2 m. The setback above deliberately puts the pit in the MIDDLE
    // of the pavement, and an Eixample pavement is 3-4 m — so a 2 m building margin rejected the
    // tree for standing where Barcelona actually plants it. Measured on the spawn tile: 12.3% of
    // surviving roadside trees were lost here. `pointInPolygon` still rejects anything genuinely
    // inside a footprint, so this cannot put a tree in a building.
    if (!isInsideOrNearBuilding(p.x, p.y, buildings, 0.6)) {
      positions.push({ x: p.x, y: p.y });
    }
    if (positions.length >= cap) break;
  }

  if (positions.length < cap) {
    const perim = getBuildingPerimeterTreePositions(tileData, vegMask);
    for (const p of perim) {
      // N-7c: 0.5 m, not 2. This margin STACKS on the mask's own inflate, and 2 m of it put the
      // tree pit behind the pavement and into the building-proximity test. See ROAD_INFLATE.
      if (!isExcluded(p.x, p.y, 0.5)) {
        positions.push(p);
      }
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

  // N-11: the mask alone was never a road test — it returns TRUE outside its own grid, and its
  // ROAD_INFLATE is 0.3 m. Both bush sources below are anchored to roads (source 1 clusters around
  // street trees, which stand ON the pavement; source 2 plants along the kerb by construction), so
  // without a geometric corridor test practically every bush produced here was a street bush.
  const corridorGrid = buildCorridorGrid(roads);

  function isValid(x, z) {
    return isVegetationAllowed(vegMask, x, z, 3) &&
           !isOnGroundRoad(corridorGrid, x, z) &&
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
      // P4-17b: measured from the KERB, not the centreline — same R-W1 fallout as the roadside
      // trees. `BUSH_ROAD_OFFSET_MIN/MAX` (3..7 m) were centreline offsets tuned when a residential
      // road was 4 m wide, so they cleared its 2 m half by 1-5 m. R-W1 made that road 10.4 m and
      // every bush from 3 m to 5.2 m landed INSIDE the carriageway. Measured before this change:
      // **5.15% of all procedural bushes sat in a drivable carriageway, 3.13% well inside it** —
      // 18,162 of them across 120 tiles, which is the bush the user found growing out of Gran Via.
      const bHalfW = Math.max(3, Number(road.kerbToKerbW ?? road.width) || 6) / 2;
      const bBase = bHalfW + CURB_WIDTH;
      while (dist < segLen && bushes.length < BUSH_CAP) {
        const s = stepIdx++;
        const spacing = BUSH_ROAD_SPACING_MIN + seeded(s, 30) * (BUSH_ROAD_SPACING_MAX - BUSH_ROAD_SPACING_MIN);
        const t = Math.max(0, Math.min(1, dist / segLen));
        const cx = a.x + dx * t, cz = a.y + dz * t;
        for (const side of [1, -1]) {
          if (seeded(s + side, 31) < 0.25) continue;
          // Beyond the kerb by the clearance the old constants MEANT (1-5 m over a 4 m road).
          const off = bBase + BUSH_KERB_CLEAR_MIN
            + seeded(s + side * 3, 32) * (BUSH_KERB_CLEAR_MAX - BUSH_KERB_CLEAR_MIN);
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
 * N-7 · Road points arrive in MERCATOR and everything else here is WORLD. Convert.
 *
 * This read `{ x: p[0], y: p[2] }` — the raw payload point, which is Mercator. Probed:
 *
 *     road pt (240672.7, 5069787.3)   |   mask SW world (3661.3, 3903.0)
 *
 * ~240 km apart. Three things followed, none of them visible as an error:
 *   1. `buildVegetationMask` rasterised every road outside its own grid, where
 *      `isVegetationAllowed` returns TRUE unconditionally — so the ROAD MASK BLOCKED NOTHING.
 *      Every "vegetation avoids roads" guarantee in this file was fiction.
 *   2. `getRoadsideTreePositions` and the road-edge bush loop derived their output FROM these
 *      points, so they emitted Mercator positions that were then dropped as out-of-tile. Those
 *      two paths produced nothing at all; the trees on screen are building-perimeter and zone
 *      trees plus OSM nodes.
 *   3. It is silent. Buildings (`buildingNormalize`) and greens are already world, so only the
 *      road half was wrong, and a road mask that blocks nothing looks exactly like a road mask
 *      whose margins are slightly generous.
 *
 * ⚠ Fixing this CHANGES VEGETATION EVERYWHERE — the mask starts rejecting, and the two dead
 * placement paths start producing. Expect a different city, and re-measure rather than assume.
 */
function convertRoadsForVeg(roads) {
  if (!roads || roads.length === 0) return [];
  return roads.map(r => ({
    ...r,
    points: (r.points || []).map(p => {
      if (Array.isArray(p)) {
        const w = mercatorToWorld(p[0], p[2]);
        return { x: w.x, y: w.z };
      }
      return p; // already in object form
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
function convertWaterForVeg(water) {
  if (!water || water.length === 0) return [];
  return water.map(w => ({
    ...w,
    polygon: (w.polygon || []).map(p => {
      if (Array.isArray(p)) return { x: p[0], y: p[1] };
      return p;
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
  if (process.env.VEG_PROBE && vegRoads[0]?.points?.[0]) {
    const p0 = vegRoads[0].points[0];
    const swp = latLonToWorld(tileBounds.south, tileBounds.west);
    console.log(`[VEG_PROBE] road pt (${p0.x.toFixed(1)}, ${p0.y.toFixed(1)}) | mask SW world (${swp.x.toFixed(1)}, ${swp.z.toFixed(1)})`);
  }
  const vegBuildings = convertBuildingsForVeg(tileData.buildings);
  const vegGreens = convertGreensForVeg(tileData.greens);
  const vegWater = convertWaterForVeg(tileData.water);

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

  // ── N-10: A TILE MAY ONLY PLANT INSIDE ITS OWN BOUNDS ──────────────────────────────────────────
  //
  // `noClipTileStrategy` gives every tile the FULL geometry of every way that touches it, so
  // `getRoadsideTreePositions` walks those ways far past the tile edge and plants along all of it.
  // Measured on the Gran Via tile: **1,278 tree positions of which only 590 (46.2%) were inside the
  // tile**, and 3,000 bushes of which 503 (16.8%) were.
  //
  // That is not merely duplicated work. The runtime derives each tree's ground height from the
  // tile's own elevation grid, and outside the grid that sampling clamps to the edge or returns
  // nothing — so a tree planted in the neighbour's ground is buried or dropped. It is the same
  // reasoning `environmentClusterRenderer` already applies to its own items ("the neighbour tile
  // owns that ground and places its own vegetation there"); the baker simply never did.
  //
  // The neighbour plants that ground itself, from its own roads, so nothing is lost by clipping.
  const _swB = latLonToWorld(tileBounds.south, tileBounds.west);
  const _neB = latLonToWorld(tileBounds.north, tileBounds.east);
  const _bMinX = Math.min(_swB.x, _neB.x), _bMaxX = Math.max(_swB.x, _neB.x);
  const _bMinZ = Math.min(_swB.z, _neB.z), _bMaxZ = Math.max(_swB.z, _neB.z);
  const _inTile = (q) => q.x >= _bMinX && q.x <= _bMaxX && q.y >= _bMinZ && q.y <= _bMaxZ;
  const _before = positions.length;
  positions = positions.filter(_inTile);
  _vegClipStats.trees += _before - positions.length;
  _vegClipStats.treesKept += positions.length;

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

  // Build flat tree positions
  const treePositions = new Float32Array(positions.length * 2);
  for (let i = 0; i < positions.length; i++) {
    treePositions[i * 2] = positions[i].x;
    treePositions[i * 2 + 1] = positions[i].y;
  }
  const treeVariants = treeVariantIndices;

  // Collect bush positions
  const bushPosArr = collectBushPositions(positions, vegTileData, tileKey, vegMask).filter(_inTile);

  // Build flat bush positions
  const bushPositions = new Float32Array(bushPosArr.length * 2);
  for (let i = 0; i < bushPosArr.length; i++) {
    bushPositions[i * 2] = bushPosArr[i].x;
    bushPositions[i * 2 + 1] = bushPosArr[i].y;
  }

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
      const sorted = order.map((i) => bushPosArr[i]);
      for (let i = 0; i < sorted.length; i++) {
        bushPositions[i * 2] = sorted[i].x;
        bushPositions[i * 2 + 1] = sorted[i].y;
      }
    }
  }

  // Zone tree positions
  const zoneTreePositions = new Float32Array(zoneResult.allTreePositions.length * 2);
  for (let i = 0; i < zoneResult.allTreePositions.length; i++) {
    zoneTreePositions[i * 2] = zoneResult.allTreePositions[i].x;
    zoneTreePositions[i * 2 + 1] = zoneResult.allTreePositions[i].y;
  }

  // Zone tree variants
  const keySeed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const zoneTreeVariants = new Uint8Array(zoneResult.allTreePositions.length);
  for (let i = 0; i < zoneResult.allTreePositions.length; i++) {
    zoneTreeVariants[i] = Math.floor(seeded(i, keySeed + 9999) * NUM_TREE_VARIANTS) % NUM_TREE_VARIANTS;
  }

  // Zone tree scales
  const zoneTreeScales = new Float32Array(zoneResult.allTreeScales);

  // Zone bush positions
  const zoneBushPositions = new Float32Array(zoneResult.allBushPositions.length * 2);
  for (let i = 0; i < zoneResult.allBushPositions.length; i++) {
    zoneBushPositions[i * 2] = zoneResult.allBushPositions[i].x;
    zoneBushPositions[i * 2 + 1] = zoneResult.allBushPositions[i].y;
  }

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


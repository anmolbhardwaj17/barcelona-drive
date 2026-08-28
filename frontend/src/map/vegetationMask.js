/**
 * Vegetation inclusion mask: a 0.5m-resolution binary grid where 1 = vegetation
 * allowed, 0 = blocked. Stamps roads, junctions, bridges, and water as blocked.
 * Replaces scattered exclusion checks across 7 renderers with a single O(1) query.
 *
 * Buildings are NOT stamped — building perimeter trees are intentionally placed
 * near buildings (2-4m from edge). Building exclusion stays per-renderer via
 * the shared isInsideOrNearBuilding helper.
 */
import { latLonToWorld } from '../projection.js';
import { pavedWidth, corridorWidth } from './roadWidths.js';   // R-W1: never re-derive a width
/** m — kerb allowance, so nothing sits half on the asphalt. */
const KERB_CLEAR = 0.3;
import { rasterizeSegment, rasterizeDisc } from './roadOccupancyGrid.js';

// R-W1: the "mirror of roadRenderer WIDTH_BY_TYPE" table that used to live here is gone. It was one
// of THREE files carrying that comment, none of which actually matched roadRenderer — and it was a
// third scale again (residential 10 m against a road drawn at 4 m), which is why the city had a ring
// of cleared-but-unpaved ground around every street. Clearing vegetation wants the CORRIDOR, which
// the bake now states outright: kerb-to-kerb plus both sidewalks.

const RESOLUTION = 0.5;
const PAD = 20;
const ROAD_INFLATE = 3.0;          // metres added to each side beyond road surface — keeps clusters out of gaps between parallel roads
const BRIDGE_INFLATE = 10.0;       // wider margin under bridges/flyovers (canopies at 6-8m height clip through deck)
const JUNCTION_CLUSTER_DIST_SQ = 5 * 5;
const JUNCTION_RADIUS_MULT = 2.0;  // junction disc radius = max(width) * this / 2 + inflate
const SINGLE_ENDPOINT_EXTRA = 5.0; // extra margin for road terminators

// ---------------------------------------------------------------------------
// Scanline polygon rasterization for water areas
// ---------------------------------------------------------------------------

function rasterizePolygon(grid, gridW, gridH, minX, minZ, res, polygon) {
  if (!polygon || polygon.length < 3) return;

  // Compute grid-space AABB
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
    // Find all X intersections of the scan line with polygon edges
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

    // Fill spans between pairs of intersections
    const row = gz * gridW;
    for (let k = 0; k < intersections.length - 1; k += 2) {
      const gx0 = Math.max(0, Math.floor((intersections[k] - minX) / res));
      const gx1 = Math.min(gridW - 1, Math.ceil((intersections[k + 1] - minX) / res));
      for (let gx = gx0; gx <= gx1; gx++) {
        grid[row + gx] = 0; // mark as blocked
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build vegetation mask
// ---------------------------------------------------------------------------

/**
 * Build a vegetation inclusion mask for a tile.
 * @param {object[]} roads - tile road data
 * @param {object[]} buildings - tile building data (unused in mask, kept for API consistency)
 * @param {object[]} waterAreas - tile water polygon data
 * @param {{ south: number, west: number, north: number, east: number }} tileBounds
 * @returns {{ grid: Uint8Array, gridW: number, gridH: number, minX: number, minZ: number, resolution: number } | null}
 */
export function buildVegetationMask(roads, buildings, waterAreas, tileBounds, neighborRoads = []) {
  if (!tileBounds) return null;

  const sw = latLonToWorld(tileBounds.south, tileBounds.west);
  const ne = latLonToWorld(tileBounds.north, tileBounds.east);
  const minX = Math.min(sw.x, ne.x) - PAD;
  const maxX = Math.max(sw.x, ne.x) + PAD;
  const minZ = Math.min(sw.z, ne.z) - PAD;
  const maxZ = Math.max(sw.z, ne.z) + PAD;

  const gridW = Math.ceil((maxX - minX) / RESOLUTION);
  const gridH = Math.ceil((maxZ - minZ) / RESOLUTION);
  const grid = new Uint8Array(gridW * gridH);
  grid.fill(1); // all valid initially

  // We rasterize blocked areas by setting cells to 0. Since rasterizeSegment/
  // rasterizeDisc set cells to 1, we use a temporary grid then invert.
  // Actually, let's create a "blocked" grid, stamp into it, then produce the
  // inclusion mask by inverting. This reuses the existing rasterize functions.
  const blocked = new Uint8Array(gridW * gridH); // 0 = not blocked

  if (roads && roads.length > 0) {
    const endpoints = [];

    // --- Phase 1: Stamp ALL road segments (incl. tunnel/below-grade) ---
    // Was: skipped tunnel/layer<0 → procedural clusters/bushes spawned IN daylighted trenches and
    // on multi-level roads. Block every footprint (matches vegetationBaker).
    for (const road of roads) {
      const pts = road.points || [];
      if (pts.length < 2) continue;

      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = corridorWidth(road);
      const w = Math.max(dataW, typeW);
      const half = w / 2 + ROAD_INFLATE;

      for (let i = 0; i < pts.length - 1; i++) {
        rasterizeSegment(blocked, gridW, gridH, minX, minZ, RESOLUTION,
          pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
      }

      endpoints.push({ x: pts[0].x, z: pts[0].y, w });
      endpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
    }

    // --- Phase 1b: Collect endpoints from neighbor tiles for cross-tile junction detection ---
    for (const road of neighborRoads) {
      if (road.tunnel) continue;
      const layer = road.layer ?? 0;
      if (layer < 0) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;
      const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
      const typeW = corridorWidth(road);
      const w = Math.max(dataW, typeW);
      endpoints.push({ x: pts[0].x, z: pts[0].y, w });
      endpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
    }

    // --- Phase 2: Junction widening ---
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
        const junctionRadius = maxW * JUNCTION_RADIUS_MULT / 2 + ROAD_INFLATE;
        rasterizeDisc(blocked, gridW, gridH, minX, minZ, RESOLUTION, cx, cz, junctionRadius);
      } else {
        const endRadius = maxW / 2 + SINGLE_ENDPOINT_EXTRA;
        rasterizeDisc(blocked, gridW, gridH, minX, minZ, RESOLUTION, cx, cz, endRadius);
      }
    }

    // --- Phase 3: Bridge / elevated road stamp (wider margin) ---
    for (const road of roads) {
      if (!road.bridge && (road.layer == null || road.layer <= 0)) continue;
      const pts = road.points || [];
      if (pts.length < 2) continue;

      // R-W1: was `max(dataW, typeW)`. The corridor is by definition >= the paved width, so taking
      // the larger of a raw `road.width` and a type guess only re-introduced a second reading.
      const w = corridorWidth(road);
      const half = w / 2 + BRIDGE_INFLATE;

      for (let i = 0; i < pts.length - 1; i++) {
        rasterizeSegment(blocked, gridW, gridH, minX, minZ, RESOLUTION,
          pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
      }
    }
  }

  // --- Phase 4: Water polygon stamp ---
  for (const area of waterAreas || []) {
    const poly = area.polygon || [];
    if (poly.length >= 3) {
      // rasterizePolygon sets grid cells to 0 directly, but we need to
      // mark in the blocked grid. We'll handle it by stamping directly
      // into the inclusion grid after we build it.
    }
  }

  // Convert blocked grid to inclusion mask: blocked[i]=1 → grid[i]=0
  for (let i = 0; i < grid.length; i++) {
    if (blocked[i]) grid[i] = 0;
  }

  // Now stamp water polygons (sets cells to 0 = blocked)
  for (const area of waterAreas || []) {
    const poly = area.polygon || [];
    if (poly.length >= 3) {
      rasterizePolygon(grid, gridW, gridH, minX, minZ, RESOLUTION, poly);
    }
  }

  return { grid, gridW, gridH, minX, minZ, resolution: RESOLUTION };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Check if vegetation is allowed at (x, z) with optional margin.
 * Returns true if the cell (and all cells within margin) are valid (1).
 * O(1) for margin=0, O(m²) for margin>0 where m = ceil(margin/resolution).
 *
 * @param {object|null} mask - from buildVegetationMask
 * @param {number} x - world X
 * @param {number} z - world Z
 * @param {number} [margin=0] - additional clearance in metres
 * @returns {boolean}
 */
export function isVegetationAllowed(mask, x, z, margin = 0) {
  if (!mask) return true; // no mask = allow everything (fallback)
  const { grid, gridW, gridH, minX, minZ, resolution } = mask;
  const gx = Math.floor((x - minX) / resolution);
  const gz = Math.floor((z - minZ) / resolution);

  if (margin <= 0) {
    if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) return true;
    return grid[gz * gridW + gx] !== 0;
  }

  // Check square of cells within margin — return false if ANY is blocked
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

// ---------------------------------------------------------------------------
// Shared building exclusion helper
// ---------------------------------------------------------------------------

function distSqToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-12) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return (ax + t * dx - px) ** 2 + (az + t * dz - pz) ** 2;
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

/**
 * Returns true if (x, z) is inside or within `margin` metres of any building footprint.
 * Uses footprint AABB for fast rejection, then point-in-polygon + edge distance.
 *
 * @param {number} x - world X
 * @param {number} z - world Z
 * @param {object[]} buildings - building data with .footprint arrays
 * @param {number} [margin=2] - clearance from building edges in metres
 * @returns {boolean}
 */
export function isInsideOrNearBuilding(x, z, buildings, margin = 2) {
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

/**
 * N-9 · Is this point on a drivable carriageway? Tested against the road GEOMETRY itself.
 *
 * ONE copy, shared by every placer. Today produced four separate cases of the same logic living in
 * two files and silently diverging (H10, H12, the carriageway clip, the width tables R-W1 killed),
 * so this does not get copied — it gets imported.
 *
 * The vegetation mask is a grid over the tile plus a pad, and `isVegetationAllowed` treats
 * everything OUTSIDE that grid as allowed — which is correct for "we do not know", and wrong as
 * the last word before placing a rock. Clusters near a tile edge scatter items past the grid and
 * were then placed unconditionally. This is O(items x segments) on a per-tile road list, which is
 * small, and it only runs for items the mask already accepted.
 */
/**
 * N-9 counters. A guard that silently does nothing looks exactly like a guard that works, and this
 * one was written twice before it was verified. `window._ddClusterRejects` says which.
 */
const _clusterRejects = { mask: 0, road: 0, kept: 0 };
if (typeof window !== 'undefined') window._ddClusterRejects = _clusterRejects;

const _CLUSTER_ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
export function isOnAnyRoad(tileData, x, z) {
  const roads = tileData?.roads;
  if (!roads?.length) return false;
  for (const r of roads) {
    if (!_CLUSTER_ROAD_TYPES.has(r.highwayType) || r.tunnel || (r.layer || 0) !== 0) continue;
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    // ⚠ PAVED width (kerb to kerb), NOT corridorWidth.
    //
    // This used `corridorWidth`, which is kerb-to-kerb PLUS both pavements — and a STREET TREE
    // LIVES ON THE PAVEMENT. Guarding at corridor width therefore deleted every plane tree on
    // Gran Via along with the rocks: the avenue came back bare. The thing that must be kept clear
    // is the ASPHALT. Anything outside the kerb is legitimate ground for a tree, a bush or a rock,
    // and whether a ROCK belongs on a pavement is an art question, not a correctness one.
    const half = pavedWidth(r) / 2 + KERB_CLEAR;
    const halfSq = half * half;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y, bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const L = dx * dx + dz * dz;
      let t = L > 0 ? ((x - ax) * dx + (z - az) * dz) / L : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = ax + t * dx, qz = az + t * dz;
      const ddx = x - qx, ddz = z - qz;
      if (ddx * ddx + ddz * ddz < halfSq) return true;
    }
  }
  return false;
}

export const __test__ = { isOnAnyRoad };

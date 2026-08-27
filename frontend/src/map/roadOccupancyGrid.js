/**
 * Road occupancy grid: a 0.5m-resolution binary bitmap marking which cells
 * are covered by road surfaces. Built once per tile after road rendering,
 * then used by all vegetation renderers for O(1) "is this on a road?" checks.
 *
 * Uses the road renderer's actual WIDTH_BY_TYPE values, inflated by a safety
 * buffer, so the grid slightly overestimates the rendered road surface.
 * Segments are rasterized as capsule shapes (rect + circular endcaps).
 * Junctions where multiple roads meet get additional widening.
 */
import { latLonToWorld } from '../projection.js';
import { corridorWidth } from './roadWidths.js';   // R-W1

// R-W1: the "mirror of roadRenderer WIDTH_BY_TYPE" table that used to live here is gone. It was one
// of THREE files carrying that comment, none of which actually matched roadRenderer — and it was a
// third scale again (residential 10 m against a road drawn at 4 m), which is why the city had a ring
// of cleared-but-unpaved ground around every street. Clearing vegetation wants the CORRIDOR, which
// the bake now states outright: kerb-to-kerb plus both sidewalks.

const RESOLUTION = 0.5; // metres per grid cell (was 1m, now 0.5m for less aliasing)
const PAD = 20;          // metres padding around tile bounds
const WIDTH_INFLATE = 2.0; // metres added to each side — covers road + shoulder area
const JUNCTION_CLUSTER_DIST_SQ = 5 * 5; // metres² — endpoints within this are a junction
const JUNCTION_RADIUS_MULT = 1.4; // junction disc radius = max(widthA,widthB) * this

/**
 * Rasterize a capsule (segment with circular endcaps) into the grid.
 * Every cell whose centre is within halfWidth of the segment line is marked.
 * Because t is clamped to [0,1], the endcaps are naturally circular — this
 * is the standard capsule / Minkowski-sum shape.
 */
export function rasterizeSegment(grid, gridW, gridH, minX, minZ, res, ax, az, bx, bz, halfWidth) {
  const halfSq = halfWidth * halfWidth;
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;

  // AABB of segment expanded by halfWidth
  const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - halfWidth - minX) / res));
  const gx1 = Math.min(gridW - 1, Math.ceil((Math.max(ax, bx) + halfWidth - minX) / res));
  const gz0 = Math.max(0, Math.floor((Math.min(az, bz) - halfWidth - minZ) / res));
  const gz1 = Math.min(gridH - 1, Math.ceil((Math.max(az, bz) + halfWidth - minZ) / res));

  for (let gz = gz0; gz <= gz1; gz++) {
    const wz = minZ + gz * res + res * 0.5;
    const row = gz * gridW;
    for (let gx = gx0; gx <= gx1; gx++) {
      if (grid[row + gx]) continue; // already marked
      const wx = minX + gx * res + res * 0.5;
      // Point-to-segment distance squared (capsule shape: t clamped to [0,1])
      let distSq;
      if (lenSq < 1e-12) {
        distSq = (wx - ax) * (wx - ax) + (wz - az) * (wz - az);
      } else {
        const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / lenSq));
        const px = ax + t * dx, pz = az + t * dz;
        distSq = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
      }
      if (distSq <= halfSq) {
        grid[row + gx] = 1;
      }
    }
  }
}

/**
 * Rasterize a filled circle (junction disc) into the grid.
 */
export function rasterizeDisc(grid, gridW, gridH, minX, minZ, res, cx, cz, radius) {
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
      if ((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz) <= rSq) {
        grid[row + gx] = 1;
      }
    }
  }
}

/**
 * Build a road occupancy grid for a tile.
 * @param {object[]} roads - tile road data
 * @param {{ south: number, west: number, north: number, east: number }} tileBounds - lat/lon bounds
 * @returns {{ grid: Uint8Array, gridW: number, gridH: number, minX: number, minZ: number, resolution: number }}
 */
export function buildRoadOccupancyGrid(roads, tileBounds) {
  if (!roads || roads.length === 0 || !tileBounds) return null;

  const sw = latLonToWorld(tileBounds.south, tileBounds.west);
  const ne = latLonToWorld(tileBounds.north, tileBounds.east);
  const minX = Math.min(sw.x, ne.x) - PAD;
  const maxX = Math.max(sw.x, ne.x) + PAD;
  const minZ = Math.min(sw.z, ne.z) - PAD;
  const maxZ = Math.max(sw.z, ne.z) + PAD;

  const gridW = Math.ceil((maxX - minX) / RESOLUTION);
  const gridH = Math.ceil((maxZ - minZ) / RESOLUTION);
  const grid = new Uint8Array(gridW * gridH);

  // --- Phase 1: Rasterize road segments as inflated capsules ---
  // Collect endpoints with their effective widths for junction detection
  const endpoints = [];

  for (const road of roads) {
    if (road.tunnel) continue;
    const layer = road.layer ?? 0;
    if (layer < 0) continue;
    const pts = road.points || [];
    if (pts.length < 2) continue;

    // Use the larger of tile-data width and type-based render width
    const dataW = Number.isFinite(Number(road.width)) ? Number(road.width) : 0;
    const typeW = corridorWidth(road);
    const w = Math.max(dataW, typeW);
    const half = w / 2 + WIDTH_INFLATE; // inflate by safety buffer

    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(grid, gridW, gridH, minX, minZ, RESOLUTION,
                       pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, half);
    }

    // Record endpoints for junction widening
    endpoints.push({ x: pts[0].x, z: pts[0].y, w });
    endpoints.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, w });
  }

  // --- Phase 2: Junction widening — stamp discs where multiple roads meet ---
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
      // Multi-road junction: large disc
      const junctionRadius = maxW * JUNCTION_RADIUS_MULT / 2 + WIDTH_INFLATE;
      rasterizeDisc(grid, gridW, gridH, minX, minZ, RESOLUTION, cx, cz, junctionRadius);
    } else {
      // Single endpoint: small disc to cover road termination/merge area
      const endRadius = maxW / 2 + WIDTH_INFLATE + 1;
      rasterizeDisc(grid, gridW, gridH, minX, minZ, RESOLUTION, cx, cz, endRadius);
    }
  }

  return { grid, gridW, gridH, minX, minZ, resolution: RESOLUTION };
}

/**
 * Check if (x, z) is on or within `margin` metres of a road surface.
 * @param {object} occupancy - grid from buildRoadOccupancyGrid
 * @param {number} x - world X
 * @param {number} z - world Z
 * @param {number} [margin=0] - additional clearance in metres beyond the road surface
 * @returns {boolean}
 */
export function isOnRoadGrid(occupancy, x, z, margin = 0) {
  if (!occupancy) return false;
  const { grid, gridW, gridH, minX, minZ, resolution } = occupancy;
  const gx = Math.floor((x - minX) / resolution);
  const gz = Math.floor((z - minZ) / resolution);

  if (margin <= 0) {
    // O(1) exact check
    if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) return false;
    return grid[gz * gridW + gx] !== 0;
  }

  // Check square of cells within margin
  const m = Math.ceil(margin / resolution);
  const gx0 = Math.max(0, gx - m);
  const gx1 = Math.min(gridW - 1, gx + m);
  const gz0 = Math.max(0, gz - m);
  const gz1 = Math.min(gridH - 1, gz + m);

  for (let cz = gz0; cz <= gz1; cz++) {
    const row = cz * gridW;
    for (let cx = gx0; cx <= gx1; cx++) {
      if (grid[row + cx]) return true;
    }
  }
  return false;
}

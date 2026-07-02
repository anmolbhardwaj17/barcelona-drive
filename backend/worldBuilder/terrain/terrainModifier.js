/**
 * TerrainModifier: per-tile modification of elevation grid before write.
 * - Flatten terrain under roads (layer 0 and bridges): blend grid height toward road/bridge deck
 *   height within influence radius (smooth falloff). Prevents terrain overlapping bridge deck.
 * - Tunnel carving: lower terrain above tunnel paths with smooth falloff (cavity effect).
 *
 * Geometry: grid cell (r,c) -> lat/lon -> mercator (mx, mz). Road points use (p[0], p[2]) = mercator.
 * Falloff uses smoothstep so no hard edges. Only cells inside the tile are modified.
 */
import { latLonToMercator } from '../../projection.js';

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Distance from point (mx, mz) to segment p0-p1, and closest point on segment (for interpolation).
 * Returns { distance, t } where t in [0,1] is parameter along segment; caller can lerp road y.
 */
function distanceToSegment(mx, mz, p0, p1) {
  const ax = p0[0];
  const az = p0[2];
  const bx = p1[0];
  const bz = p1[2];
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-20) {
    const d = Math.hypot(mx - ax, mz - az);
    return { distance: d, t: 0 };
  }
  let t = ((mx - ax) * dx + (mz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const pz = az + t * dz;
  const distance = Math.hypot(mx - px, mz - pz);
  return { distance, t };
}

/**
 * For polyline points, find minimum distance from (mx, mz) to any segment and return
 * { distance, roadY } where roadY is interpolated elevation at nearest point.
 */
function distanceToPolyline(mx, mz, points) {
  let bestDist = Infinity;
  let bestT = 0;
  let bestSeg = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const { distance, t } = distanceToSegment(mx, mz, points[i], points[i + 1]);
    if (distance < bestDist) {
      bestDist = distance;
      bestT = t;
      bestSeg = i;
    }
  }
  const p0 = points[bestSeg];
  const p1 = points[bestSeg + 1];
  const roadY = p0[1] + bestT * (p1[1] - p0[1]);
  return { distance: bestDist, roadY };
}

/**
 * Axis-aligned bbox of points (mercator x,z).
 */
function segmentBbox(points, margin) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]);
    maxZ = Math.max(maxZ, p[2]);
  }
  return {
    minX: minX - margin,
    maxX: maxX + margin,
    minZ: minZ - margin,
    maxZ: maxZ + margin,
  };
}

/**
 * Modify tile elevation grid: flatten under layer-0 roads, carve tunnels.
 * Grid is row-major, row 0 = south, col 0 = west. Grid size gridRows x gridCols (e.g. 128x128).
 * Bbox: { south, west, north, east } in degrees.
 * Segments: array of { points: [[x,yUp,z,?],...], width, bridge, tunnel, layer }.
 * Returns modified grid (same dimensions); does not mutate input.
 */
const MAX_ADJACENT_DELTA = 2;

export function modifyTileTerrain(bbox, grid, gridRows, gridCols, segments, config) {
  const blendRadius = config.roadBlendRadius ?? 10;
  const flattenStrength = config.roadFlattenStrength ?? 0.6;
  const tunnelCarveWidth = config.tunnelCarveWidth ?? 12;
  const tunnelCarveFalloff = config.tunnelCarveFalloff ?? 8;
  const tunnelClearance = 0.5;

  const data = grid.slice();
  const south = bbox.south;
  const west = bbox.west;
  const north = bbox.north;
  const east = bbox.east;

  const latForRow = (r) => (gridRows <= 1 ? south : south + (north - south) * (r / (gridRows - 1)));
  const lonForCol = (c) => (gridCols <= 1 ? west : west + (east - west) * (c / (gridCols - 1)));

  // Flatten under all roads and bridges (not tunnels). Bridge deck Y prevents terrain overlap.
  const flattenSegments = segments.filter((s) => !s.tunnel);
  const tunnelSegments = segments.filter((s) => s.tunnel);

  let cellsModified = 0;
  let maxHeightDelta = 0;

  for (const seg of flattenSegments) {
    const pts = seg.points;
    if (!pts || pts.length < 2) continue;
    const bboxSeg = segmentBbox(pts, blendRadius);
    for (let r = 0; r < gridRows; r++) {
      const lat = latForRow(r);
      const { x: mx, y: mz } = latLonToMercator(lat, west);
      if (mz < bboxSeg.minZ - 1 || mz > bboxSeg.maxZ + 1) continue;
      for (let c = 0; c < gridCols; c++) {
        const lon = lonForCol(c);
        const merc = latLonToMercator(lat, lon);
        const mxx = merc.x;
        const mzz = merc.y;
        if (mxx < bboxSeg.minX || mxx > bboxSeg.maxX || mzz < bboxSeg.minZ || mzz > bboxSeg.maxZ) continue;
        const { distance, roadY } = distanceToPolyline(mxx, mzz, pts);
        if (distance >= blendRadius) continue;
        const falloff = 1 - smoothstep(distance / blendRadius);
        const blendAmount = falloff * flattenStrength;
        const idx = r * gridCols + c;
        const current = data[idx];
        const newVal = current + blendAmount * (roadY - current);
        const delta = Math.abs(newVal - current);
        if (delta > 0) {
          cellsModified++;
          maxHeightDelta = Math.max(maxHeightDelta, delta);
        }
        data[idx] = newVal;
      }
    }
  }

  // Tunnel carve: lower terrain above tunnel path; smoothstep falloff avoids hard cuts.
  for (const seg of tunnelSegments) {
    const pts = seg.points;
    if (!pts || pts.length < 2) continue;
    const tunnelMargin = tunnelCarveWidth + tunnelCarveFalloff;
    const bboxSeg = segmentBbox(pts, tunnelMargin);
    for (let r = 0; r < gridRows; r++) {
      const lat = latForRow(r);
      const mercR = latLonToMercator(lat, west);
      if (mercR.y < bboxSeg.minZ - 1 || mercR.y > bboxSeg.maxZ + 1) continue;
      for (let c = 0; c < gridCols; c++) {
        const lon = lonForCol(c);
        const merc = latLonToMercator(lat, lon);
        const mxx = merc.x;
        const mzz = merc.y;
        if (mxx < bboxSeg.minX || mxx > bboxSeg.maxX || mzz < bboxSeg.minZ || mzz > bboxSeg.maxZ) continue;
        const { distance, roadY } = distanceToPolyline(mxx, mzz, pts);
        const inner = tunnelCarveWidth;
        const outer = tunnelCarveWidth + tunnelCarveFalloff;
        if (distance >= outer) continue;
        const carveTarget = roadY - tunnelClearance;
        // Full carve inside tunnelCarveWidth; smooth ramp to no carve at outer edge.
        const blend = distance <= inner ? 1 : 1 - smoothstep((distance - inner) / tunnelCarveFalloff);
        const idx = r * gridCols + c;
        const current = data[idx];
        data[idx] = Math.min(current, current + blend * (carveTarget - current));
      }
    }
  }

  // Clamp adjacent-cell height delta: no delta > 2m between 4-neighbors. Iterative relaxation.
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        const idx = r * gridCols + c;
        const v = data[idx];
        const neighbors = [];
        if (r > 0) neighbors.push(data[(r - 1) * gridCols + c]);
        if (r < gridRows - 1) neighbors.push(data[(r + 1) * gridCols + c]);
        if (c > 0) neighbors.push(data[r * gridCols + (c - 1)]);
        if (c < gridCols - 1) neighbors.push(data[r * gridCols + (c + 1)]);
        if (neighbors.length === 0) continue;
        const allowedMin = Math.max(...neighbors.map((n) => n - MAX_ADJACENT_DELTA));
        const allowedMax = Math.min(...neighbors.map((n) => n + MAX_ADJACENT_DELTA));
        data[idx] = Math.max(allowedMin, Math.min(allowedMax, v));
      }
    }
  }

  return { data, cellsModified, maxHeightDelta };
}

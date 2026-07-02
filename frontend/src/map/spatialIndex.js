/**
 * Road segments and nearest-segment query for street name display.
 * Point-to-segment distance for car position.
 */

const MAX_DISTANCE_M = 50;

/**
 * Squared distance from point (px, pz) to segment (ax, az)-(bx, bz).
 */
function pointToSegmentSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qz = az + t * dz;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

/**
 * Closest point on segment (ax,az)-(bx,bz) to (px,pz), plus segment direction (normalized).
 * @returns {{ dSq: number, qx: number, qz: number, dirX: number, dirZ: number }}
 */
function pointToSegmentSqAndDirection(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let dirX = 0;
  let dirZ = 0;
  if (lenSq > 0) {
    const len = Math.sqrt(lenSq);
    dirX = dx / len;
    dirZ = dz / len;
  }
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qz = az + t * dz;
  const dSq = (px - qx) ** 2 + (pz - qz) ** 2;
  return { dSq, qx, qz, dirX, dirZ };
}

/**
 * Find closest point on any segment to (wx, wz) and the segment direction.
 * Points use { x: worldX, y: worldZ }.
 * @param {{ points: {x: number, y: number}[] }[]} segments
 * @param {number} wx
 * @param {number} wz
 * @returns {{ qx: number, qz: number, dirX: number, dirZ: number, distanceSq: number } | null}
 */
export function getClosestPointOnSegments(segments, wx, wz) {
  if (!segments || segments.length === 0) return null;
  let best = null;
  let bestSq = Infinity;
  for (const seg of segments) {
    const pts = seg.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const ax = a.x;
      const az = a.y;
      const bx = b.x;
      const bz = b.y;
      const { dSq, qx, qz, dirX, dirZ } = pointToSegmentSqAndDirection(wx, wz, ax, az, bx, bz);
      if (dSq < bestSq) {
        bestSq = dSq;
        best = { qx, qz, dirX, dirZ, distanceSq: dSq };
      }
    }
  }
  return best;
}

/**
 * Minimum distance from (px, pz) to any segment of the road (points array).
 */
function distanceToRoadSq(px, pz, points) {
  if (!points || points.length < 2) return Infinity;
  let minSq = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = pointToSegmentSq(px, pz, a.x, a.y, b.x, b.y);
    if (d < minSq) minSq = d;
  }
  return minSq;
}

/**
 * Create spatial index for a tile (stores roads for later query).
 * @param {object[]} roads - Each { id, name, points }
 * @returns {object} - Index that can be queried (or just use queryNearestRoadSegment with segment list)
 */
export function createSpatialIndex(roads) {
  return { roads: roads || [] };
}

/**
 * From a list of road segments (each { name, points, id?, highwayType? }), find the nearest within MAX_DISTANCE_M.
 * @param {{ name: string, points: {x,y}[], highwayType?: string }[]} segments
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {{ name: string, distance: number, highwayType?: string } | null}
 */
export function queryNearestRoadSegment(segments, worldX, worldZ) {
  if (!segments || segments.length === 0) return null;
  const maxSq = MAX_DISTANCE_M * MAX_DISTANCE_M;
  let best = null;
  let bestSq = maxSq;
  for (const seg of segments) {
    const dSq = distanceToRoadSq(worldX, worldZ, seg.points);
    if (dSq < bestSq) {
      bestSq = dSq;
      best = {
        name: seg.name || '—',
        distance: Math.sqrt(dSq),
        highwayType: seg.highwayType || '',
      };
    }
  }
  return best;
}

/**
 * Find the nearest road segment to (worldX, worldZ) with no distance limit.
 * Used for building facade category (residential vs commercial).
 * @param {{ name?: string, points: {x,y}[], highwayType?: string }[]} roads
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {{ road: object, highwayType: string, distance: number } | null}
 */
export function findNearestRoadSegment(roads, worldX, worldZ) {
  if (!roads || roads.length === 0) return null;
  let best = null;
  let bestSq = Infinity;
  for (const road of roads) {
    const dSq = distanceToRoadSq(worldX, worldZ, road.points);
    if (dSq < bestSq) {
      bestSq = dSq;
      best = {
        road,
        highwayType: road.highwayType || 'unclassified',
        distance: Math.sqrt(dSq),
      };
    }
  }
  return best;
}

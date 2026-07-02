/**
 * MergeGeometryBuilder: generate gore wedge geometry for merge/exit junctions.
 * Runs per-tile after resampling, before clipping.
 *
 * All coordinates are absolute Mercator (matching road points and tile bounds).
 * Road points format: [mercX, yHeight, mercY, ...]
 */

const GORE_LENGTH = 30; // meters to walk back from junction
const SAMPLE_COUNT = 6; // edge sample points along each road

/**
 * Build merge geometry (gore polygons) for junctions within tile bounds.
 * @param {Array} junctions - all classified junctions (mx/my in absolute Mercator)
 * @param {Array} tileRoads - resampled roads for this tile
 * @param {object} bounds - { minX, maxX, minY, maxY } in absolute Mercator
 * @returns {Array} junctions within tile, with gore geometry attached to merge_exit types
 */
export function buildMergeGeometry(junctions, tileRoads, bounds) {
  const MARGIN = 30;
  const tileJunctions = junctions.filter((j) =>
    j.mx >= bounds.minX - MARGIN && j.mx <= bounds.maxX + MARGIN &&
    j.my >= bounds.minY - MARGIN && j.my <= bounds.maxY + MARGIN
  );

  // Build wayId → road lookup
  const roadsByWayId = new Map();
  for (const road of tileRoads) {
    if (!roadsByWayId.has(road.id)) roadsByWayId.set(road.id, []);
    roadsByWayId.get(road.id).push(road);
  }

  for (const junction of tileJunctions) {
    if (junction.type !== 'merge_exit') continue;

    const gore = buildGoreForJunction(junction, roadsByWayId);
    if (gore) junction.gore = gore;
  }

  return tileJunctions;
}

/**
 * Find the two nearly-parallel roads at a merge_exit junction and build gore geometry.
 */
function buildGoreForJunction(junction, roadsByWayId) {
  const { roads } = junction;
  if (roads.length < 3) return null;

  // Find the pair with smallest angle difference (the ramp pair)
  let bestPair = null;
  let bestDiff = Infinity;
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      let diff = Math.abs(roads[i].angle - roads[j].angle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPair = [i, j];
      }
    }
  }
  if (!bestPair) return null;

  const roadA = findRoadGeometry(roads[bestPair[0]], roadsByWayId, junction);
  const roadB = findRoadGeometry(roads[bestPair[1]], roadsByWayId, junction);
  if (!roadA || !roadB) return null;

  // Walk backward from junction along each road and sample inner edge points
  // Road points: [mercX, y, mercY, ...]
  const edgeA = sampleInnerEdge(roadA.points, roadA.width, junction, roadB.points);
  const edgeB = sampleInnerEdge(roadB.points, roadB.width, junction, roadA.points);

  if (edgeA.length < 2 || edgeB.length < 2) return null;

  // Triangulate as quad strip
  const vertices = [];
  const indices = [];
  const minLen = Math.min(edgeA.length, edgeB.length);

  for (let i = 0; i < minLen; i++) {
    vertices.push(edgeA[i][0], edgeA[i][1], edgeA[i][2]);
    vertices.push(edgeB[i][0], edgeB[i][1], edgeB[i][2]);
  }

  for (let i = 0; i < minLen - 1; i++) {
    const a0 = i * 2;
    const b0 = i * 2 + 1;
    const a1 = (i + 1) * 2;
    const b1 = (i + 1) * 2 + 1;
    indices.push(a0, a1, b1);
    indices.push(a0, b1, b0);
  }

  return { vertices, indices };
}

/**
 * Find the road geometry segment for a junction road entry.
 * Road points format: [mercX, y, mercY, ...]
 */
function findRoadGeometry(roadInfo, roadsByWayId, junction) {
  const segments = roadsByWayId.get(roadInfo.wayId);
  if (!segments || segments.length === 0) return null;

  let bestSeg = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    if (!seg.points || seg.points.length < 2) continue;
    for (const pt of [seg.points[0], seg.points[seg.points.length - 1]]) {
      // pt[0] = mercX, pt[2] = mercY; junction.mx/my = absolute Mercator
      const d = Math.hypot(pt[0] - junction.mx, pt[2] - junction.my);
      if (d < bestDist) {
        bestDist = d;
        bestSeg = seg;
      }
    }
  }

  return bestSeg;
}

/**
 * Sample inner edge points along a road, walking backward from junction.
 * Road points: [mercX, y, mercY, ...] — uses [0] and [2] for horizontal distance.
 */
function sampleInnerEdge(points, width, junction, otherPoints) {
  if (!points || points.length < 2) return [];

  const dFirst = Math.hypot(points[0][0] - junction.mx, points[0][2] - junction.my);
  const dLast = Math.hypot(
    points[points.length - 1][0] - junction.mx,
    points[points.length - 1][2] - junction.my
  );

  const ordered = dFirst <= dLast ? [...points] : [...points].reverse();

  let totalLen = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    totalLen += Math.hypot(
      ordered[i + 1][0] - ordered[i][0],
      ordered[i + 1][2] - ordered[i][2]
    );
  }
  const goreLen = Math.min(GORE_LENGTH, totalLen);
  if (goreLen < 1) return [];

  const otherCenter = getPolylineCentroid(otherPoints);
  const halfWidth = width / 2;

  const edgePoints = [];
  const step = goreLen / (SAMPLE_COUNT - 1);

  for (let s = 0; s < SAMPLE_COUNT; s++) {
    const dist = s * step;
    const pt = interpolateAlongPolyline(ordered, dist);
    if (!pt) break;

    const dir = getDirectionAt(ordered, dist);
    if (!dir) break;

    // Perpendicular (to the left): rotate direction 90°
    const perpX = -dir.dz;
    const perpZ = dir.dx;

    // Determine which side the other road is on
    const toOther = [otherCenter[0] - pt[0], otherCenter[2] - pt[2]];
    const dot = toOther[0] * perpX + toOther[1] * perpZ;
    const sign = dot >= 0 ? 1 : -1;

    edgePoints.push([
      pt[0] + sign * perpX * halfWidth,
      pt[1],
      pt[2] + sign * perpZ * halfWidth,
    ]);
  }

  return edgePoints;
}

function getPolylineCentroid(points) {
  if (!points || points.length === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    x += p[0]; y += p[1]; z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

function interpolateAlongPolyline(points, targetDist) {
  let accumulated = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const dz = points[i + 1][2] - points[i][2];
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.001) continue;

    if (accumulated + segLen >= targetDist) {
      const t = (targetDist - accumulated) / segLen;
      return [
        points[i][0] + t * dx,
        points[i][1] + t * dy,
        points[i][2] + t * dz,
      ];
    }
    accumulated += segLen;
  }
  return points[points.length - 1];
}

function getDirectionAt(points, targetDist) {
  let accumulated = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dz = points[i + 1][2] - points[i][2];
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.001) continue;

    if (accumulated + segLen >= targetDist) {
      return { dx: dx / segLen, dz: dz / segLen };
    }
    accumulated += segLen;
  }
  if (points.length >= 2) {
    const last = points.length - 1;
    const dx = points[last][0] - points[last - 1][0];
    const dz = points[last][2] - points[last - 1][2];
    const len = Math.hypot(dx, dz);
    if (len > 0.001) return { dx: dx / len, dz: dz / len };
  }
  return null;
}

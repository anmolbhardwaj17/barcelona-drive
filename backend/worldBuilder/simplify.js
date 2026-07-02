/**
 * Douglas-Peucker polyline simplification in the horizontal (x, z) plane.
 * Points are [x, yUp, z] (mercator x, elevation yUp, mercator z). Simplification uses x and z only.
 * Tolerance in same units as coordinates (meters for mercator).
 */
function perpendicularDistance(point, lineStart, lineEnd) {
  const px = point[0];
  const pz = point[2];
  const x1 = lineStart[0];
  const z1 = lineStart[2];
  const x2 = lineEnd[0];
  const z2 = lineEnd[2];
  const dx = x2 - x1;
  const dz = z2 - z1;
  const mag = Math.hypot(dx, dz) || 1e-10;
  const u = ((px - x1) * dx + (pz - z1) * dz) / (mag * mag);
  let x, z;
  if (u < 0) {
    x = x1;
    z = z1;
  } else if (u > 1) {
    x = x2;
    z = z2;
  } else {
    x = x1 + u * dx;
    z = z1 + u * dz;
  }
  return Math.hypot(px - x, pz - z);
}

/**
 * Douglas-Peucker: reduce points, preserve shape within tolerance (horizontal plane).
 * @param {number[][]} points - Array of [x, yUp, z] or [x, yUp, z, rawDem]; indices 0,2 used for distance only; full elements preserved in output.
 * @param {number} tolerance - Max distance (meters) from simplified line
 * @returns {number[][]} Simplified points (same format, same element length)
 */
export function douglasPeucker(points, tolerance = 0.8) {
  if (!points || points.length <= 2) return points ? [...points] : [];
  const start = 0;
  const end = points.length - 1;
  let maxDist = 0;
  let maxIdx = start;
  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[start], points[end]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= tolerance) {
    return [points[start], points[end]];
  }
  const left = douglasPeucker(points.slice(start, maxIdx + 1), tolerance);
  const right = douglasPeucker(points.slice(maxIdx, end + 1), tolerance);
  return [...left.slice(0, -1), ...right];
}

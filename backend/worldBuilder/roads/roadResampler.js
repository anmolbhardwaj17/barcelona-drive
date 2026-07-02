/**
 * Resample road polylines at uniform spacing (e.g. 2 m) for consistent segment density.
 * Input/output points: [x, yUp, z] or [x, yUp, z, terrainHeight]. All components are
 * interpolated linearly between consecutive vertices.
 *
 * Topology: first and last vertices are preserved exactly (never shifted or interpolated).
 * This keeps snapped endpoint coordinates from RoadTopologyNormalizer intact so that
 * shared junctions remain aligned after resampling.
 */

/**
 * Linear interpolation of a point at parameter t in [0,1] between p0 and p1.
 * Supports 3- or 4-element points; interpolates every component.
 */
function lerpPoint(p0, p1, t) {
  const len = Math.max(p0.length, p1.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const a = p0[i] ?? p1[i];
    const b = p1[i] ?? p0[i];
    out.push(a + t * (b - a));
  }
  return out;
}

/**
 * Resample a single road at fixed spacing along the polyline (meters in x,z plane).
 * First and last vertices are always included and are exact copies of the input
 * endpoints (never replaced by lerp); intermediate points are placed every
 * `spacing` meters. Points can be [x, yUp, z] or [x, yUp, z, terrainHeight].
 *
 * @param {object} road - { points: number[][] }
 * @param {number} spacing - Distance between samples in meters (same units as x,z)
 * @returns {object} Road with points replaced by resampled polyline
 */
export function resampleRoad(road, spacing) {
  const points = road.points;
  if (!points || points.length < 2 || spacing <= 0) {
    return { ...road, points: points ? [...points] : [] };
  }

  const out = [];

  out.push(points[0].slice());
  let nextSampleDist = spacing;

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const dx = p1[0] - p0[0];
    const dz = p1[2] - p0[2];
    const segLen = Math.hypot(dx, dz);

    if (segLen < 1e-10) continue;

    const invLen = 1 / segLen;
    let dist = nextSampleDist;

    while (dist <= segLen) {
      const t = dist * invLen;
      out.push(lerpPoint(p0, p1, t));
      dist += spacing;
    }

    nextSampleDist = dist - segLen;
  }

  const last = points[points.length - 1];
  const prev = out[out.length - 1];
  if (out.length < 2 || Math.hypot(prev[0] - last[0], prev[2] - last[2]) > 1e-6) {
    out.push(last.slice());
  }

  if (road.closedLoop && out.length >= 2) {
    const first = out[0];
    const tail = out[out.length - 1];
    if (Math.hypot(first[0] - tail[0], first[2] - tail[2]) > 1e-6) {
      out.push(first.slice());
    }
  }

  return {
    ...road,
    points: out,
  };
}

/**
 * Resample all roads at the given spacing.
 * @param {object[]} roads
 * @param {number} spacing
 * @returns {object[]}
 */
export function resampleRoads(roads, spacing) {
  return roads.map((road) => resampleRoad(road, spacing));
}

/**
 * RoadGeometryBuilder: build road points from ways + vertexHeights.
 * Projects (lat,lon) to mercator, applies per-vertex Y.
 * No terrain. No DEM.
 */
import { latLonToMercator } from '../../projection.js';
import { resolveBaseHeight } from './LayerResolver.js';

// Steepest Case-C connector kept rather than deleted. 30% is deliberately above the measured worst
// (27.3%) so all four recoverable ways survive, and far below the >60% cliff backstop. Override with
// CASE_C_KEEP_GRADE_PCT to re-tighten without a code change.
const CASE_C_KEEP_GRADE_PCT = Number.isFinite(parseFloat(process.env.CASE_C_KEEP_GRADE_PCT))
  ? parseFloat(process.env.CASE_C_KEEP_GRADE_PCT) : 30;

/**
 * Build road geometry with per-vertex heights.
 * @param {object[]} ways - Each { id, nodeIds, points or lat/lon from nodes }
 * @param {Map} nodeMap - nodeId → { lat, lon }
 * @param {Map} rampResult - wayId → { isRamp, vertexHeights?, baseHeight }
 * @returns {object[]} Roads with points: [[x, yUp, z], ...]
 */
export function buildRoadGeometry(ways, nodeMap, rampResult) {
  const nodeMapObj = nodeMap instanceof Map ? Object.fromEntries(nodeMap) : nodeMap;
  const result = [];

  for (const way of ways) {
    const nodeIds = way.nodeIds || [];
    if (nodeIds.length < 2) continue;

    const ramp = rampResult?.get(way.id);
    const isRamp = ramp?.isRamp ?? false;
    const vertexHeights = ramp?.vertexHeights;
    const baseHeight = ramp?.baseHeight ?? resolveBaseHeight(way);

    const points = [];
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      const n = way.points?.[i] ?? nodeMapObj[nodeId];
      if (!n) continue;
      const lat = n.lat ?? n[1];
      const lon = n.lon ?? n[0];
      if (lat == null || lon == null) continue;
      const m = latLonToMercator(lat, lon);
      let y;
      if (isRamp && vertexHeights && vertexHeights[i] != null) {
        y = vertexHeights[i];
      } else {
        y = baseHeight;
      }
      points.push([m.x, y, m.y, y]);
    }

    if (points.length < 2) continue;

    result.push({
      id: way.id,
      nodeIds: [...nodeIds],
      points,
      width: way.width,
      bridge: way.bridge,
      tunnel: way.tunnel,
      layer: way.layer,
      highwayType: way.highwayType,
      name: way.name || '',
      closedLoop: way.closedLoop,
      isRamp,
      // Case-C short tunnel between surface roads at DIFFERENT layers — RampResolver could not fit a
      // dip, so it gave the way a MONOTONIC linear profile matching both endpoint heights. That is
      // valid, connected geometry; the only question is whether it is too steep to drive.
      //
      // It used to be `flattenedShortTunnel && !flat`, i.e. "delete it if the ends differ at all".
      // The P-R1 census measured what that discards: FOUR ways, at 16.2 / 22 / 26.5 / 27.3 percent.
      // Barcelona has public streets steeper than that. Deleting them leaves a hole where a
      // connector belongs — the "road missing where one obviously should be" the user reported —
      // and a steep ramp beats no ramp.
      //
      // The >60% profile backstop in buildRegion is untouched and still catches the real cracks:
      // the census puts its median at 94% and its tail at 3181%, and 305 of those 358 are stairs,
      // footways, corridors and service passages, which SHOULD be dropped.
      brokenRamp: ramp?.flattenedShortTunnel === true && ramp?.flat === false
                  && !(Number.isFinite(ramp?.gradePct) && ramp.gradePct <= CASE_C_KEEP_GRADE_PCT),
    });
  }

  return result;
}

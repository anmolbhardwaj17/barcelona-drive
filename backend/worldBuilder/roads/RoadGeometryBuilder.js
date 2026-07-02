/**
 * RoadGeometryBuilder: build road points from ways + vertexHeights.
 * Projects (lat,lon) to mercator, applies per-vertex Y.
 * No terrain. No DEM.
 */
import { latLonToMercator } from '../../projection.js';
import { resolveBaseHeight } from './LayerResolver.js';

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
      // Mangled Case-C short tunnel between surface roads at DIFFERENT layers (RampResolver gave
      // up fitting a dip → steep monotonic connector with broken lines). Precise broken-ramp signal.
      brokenRamp: ramp?.flattenedShortTunnel === true && ramp?.flat === false,
    });
  }

  return result;
}

/**
 * JunctionClassifier: detect and classify road junctions from the road graph.
 * Produces junction metadata (type, position, connected roads) for downstream
 * gore/merge geometry generation.
 */
import { resolveBaseLayer } from '../roads/LayerResolver.js';
import { latLonToMercator } from '../../projection.js';

const MERGE_ANGLE_THRESHOLD = 30 * (Math.PI / 180); // 30° in radians

/**
 * Compute approach angle (radians) of a way at a given node.
 * Angle is measured from the junction node toward the next node along the way.
 * @returns {number} angle in radians [-PI, PI]
 */
function computeApproachAngle(nodeId, way, nodeMap) {
  const idx = way.nodeIds.indexOf(nodeId);
  if (idx < 0) return 0;

  // Pick the adjacent node (away from junction)
  let nextIdx;
  if (idx === 0) {
    nextIdx = 1;
  } else if (idx === way.nodeIds.length - 1) {
    nextIdx = way.nodeIds.length - 2;
  } else {
    // Interior node — use the node further from the junction
    nextIdx = idx + 1;
  }

  const jNode = nodeMap.get(nodeId);
  const nNode = nodeMap.get(way.nodeIds[nextIdx]);
  if (!jNode || !nNode) return 0;

  const jm = latLonToMercator(jNode.lat, jNode.lon);
  const nm = latLonToMercator(nNode.lat, nNode.lon);
  return Math.atan2(nm.y - jm.y, nm.x - jm.x);
}

/**
 * Determine which endpoint of a way this node represents.
 * @returns {'start'|'end'|'interior'}
 */
function getEndpoint(nodeId, way) {
  if (way.nodeIds[0] === nodeId) return 'start';
  if (way.nodeIds[way.nodeIds.length - 1] === nodeId) return 'end';
  return 'interior';
}

/**
 * Classify junctions in the road graph.
 * @param {object} graph - { nodeMap, wayMap, nodeToWays } from buildFromWays
 * @returns {Array<{nodeId, x, z, type, layer, roads}>}
 */
export function classifyJunctions(graph) {
  const { nodeMap, wayMap, nodeToWays } = graph;
  const junctions = [];

  for (const [nodeId, wayIds] of nodeToWays) {
    if (wayIds.size < 3) continue;

    // Group connected ways by layer
    const layerGroups = new Map();
    for (const wayId of wayIds) {
      const way = wayMap.get(wayId);
      if (!way) continue;
      const { baseLayer } = resolveBaseLayer(way);
      if (!layerGroups.has(baseLayer)) layerGroups.set(baseLayer, []);
      layerGroups.get(baseLayer).push(way);
    }

    for (const [layer, ways] of layerGroups) {
      if (ways.length < 2) continue;

      // Compute approach info for each road
      const roads = ways.map((way) => ({
        wayId: way.id,
        angle: computeApproachAngle(nodeId, way, nodeMap),
        highwayType: way.highwayType,
        endpoint: getEndpoint(nodeId, way),
      }));

      // Classify junction type
      let type;
      const hasRoundabout = ways.some((w) => w.tags?.junction === 'roundabout');
      if (hasRoundabout) {
        type = 'roundabout';
      } else if (roads.length === 3) {
        // Check for merge/exit pattern: 2 roads within 30° angle
        const angles = roads.map((r) => r.angle);
        let isMerge = false;
        for (let i = 0; i < angles.length && !isMerge; i++) {
          for (let j = i + 1; j < angles.length; j++) {
            let diff = Math.abs(angles[i] - angles[j]);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;
            if (diff < MERGE_ANGLE_THRESHOLD) {
              isMerge = true;
              break;
            }
          }
        }
        type = isMerge ? 'merge_exit' : 'crossing';
      } else {
        type = 'crossing';
      }

      // Store absolute Mercator coords (matching road points and tile bounds)
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      const merc = latLonToMercator(node.lat, node.lon);

      junctions.push({
        nodeId,
        mx: merc.x,
        my: merc.y,
        type,
        layer,
        roads,
      });
    }
  }

  return junctions;
}

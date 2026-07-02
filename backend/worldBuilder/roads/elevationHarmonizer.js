/**
 * Elevation Harmonizer: after ElevationProcessor (smooth + bridge/tunnel ramps), set
 * the same Y at every graph node for all incident road endpoints so there are no
 * vertical cracks at merge points. Harmonization is done per layer: at each node we
 * group adjacency by road.layer, average Y within each group, and assign back only
 * within that group. This avoids collapsing flyover/bridge height at ramp nodes.
 */

import { buildRoadGraph } from './roadGraphBuilder.js';

/**
 * Harmonize elevation at shared nodes, per layer: for each node, group incident
 * endpoints by road.layer; for each layer group, average Y and assign back only to
 * that group. Does not average across layers (e.g. ground vs bridge).
 * Mutates road point arrays in place (y and, if present, 4th component).
 *
 * @param {object[]} roads - Each { points: [...], layer?: number }
 * @returns {object[]} Same road array with endpoint elevations harmonized at shared nodes
 */
export function harmonizeElevation(roads) {
  const graph = buildRoadGraph(roads);
  const { adjacency } = graph;

  for (let nodeId = 0; nodeId < adjacency.length; nodeId++) {
    const list = adjacency[nodeId];
    if (!list || list.length === 0) continue;

    const byLayer = new Map();
    for (const entry of list) {
      const layer = roads[entry.roadIndex].layer ?? 0;
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer).push(entry);
    }

    for (const [, group] of byLayer) {
      let sumY = 0;
      let count = 0;
      for (const { roadIndex, which } of group) {
        const pts = roads[roadIndex].points;
        if (!pts.length) continue;
        const p = which === 'start' ? pts[0] : pts[pts.length - 1];
        if (p.length >= 2 && Number.isFinite(p[1])) {
          sumY += p[1];
          count++;
        }
      }
      if (count === 0) continue;
      const avgY = sumY / count;

      for (const { roadIndex, which } of group) {
        const pts = roads[roadIndex].points;
        if (!pts.length) continue;
        const p = which === 'start' ? pts[0] : pts[pts.length - 1];
        p[1] = avgY;
        if (p.length >= 4) p[3] = avgY;
      }
    }
  }

  return roads;
}

/**
 * RoadGraph: build topology graph from ways and nodes.
 * Pure topology. No terrain. No DEM.
 *
 * Data structures:
 *   nodeMap: nodeId → { lat, lon }
 *   wayMap: wayId → { nodeIds, tags, ... }
 *   nodeToWays: nodeId → Set<wayId>
 */
export function buildFromWays(roads, nodeMap) {
  const wayMap = new Map();
  const nodeToWays = new Map();

  for (const road of roads) {
    const wayId = road.id;
    const nodeIds = road.nodeIds || [];
    if (nodeIds.length < 2) continue;

    wayMap.set(wayId, {
      id: wayId,
      nodeIds: [...nodeIds],
      tags: road.tags || {},
      bridge: road.bridge,
      tunnel: road.tunnel,
      layer: road.layer,
      highwayType: road.highwayType,
      closedLoop: road.closedLoop,
      // N-52: the fixer needs the DRAWN width to tell a centreline gap from a ribbon gap. Without
      // it every connector rule reasons about centrelines and happily lays a second ribbon on top
      // of a road that was already there.
      width: road.width,
      points: road.points,
    });

    for (const nodeId of nodeIds) {
      if (!nodeToWays.has(nodeId)) nodeToWays.set(nodeId, new Set());
      nodeToWays.get(nodeId).add(wayId);
    }
  }

  return {
    nodeMap: nodeMap instanceof Map ? new Map(nodeMap) : new Map(Object.entries(nodeMap || {})),
    wayMap,
    nodeToWays,
  };
}

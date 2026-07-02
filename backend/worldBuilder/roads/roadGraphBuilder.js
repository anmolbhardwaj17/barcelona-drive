/**
 * RoadGraphBuilder: build a graph of nodes and edges from the road network so that
 * Elevation Harmonizer can identify shared junctions (same node = same (x,z) after
 * topology normalization). Nodes are unique (x,z); edges are road segments;
 * adjacency lists which road endpoints meet at each node.
 */

/** Tolerance for treating (x,z) as the same node (meters). */
const NODE_EPS = 1e-6;

function nodeKey(x, z) {
  const gx = Math.round(x / NODE_EPS) * NODE_EPS;
  const gz = Math.round(z / NODE_EPS) * NODE_EPS;
  return `${gx},${gz}`;
}

/**
 * Build graph from current road list (after normalize + resample).
 *
 * @param {object[]} roads - Each { points: [[x,yUp,z], ...] }
 * @returns {{
 *   nodes: number[],
 *   nodeIdToKey: string[],
 *   keyToNodeId: Map<string, number>,
 *   edges: { roadIndex: number, startNodeId: number, endNodeId: number }[],
 *   adjacency: { roadIndex: number, which: 'start'|'end' }[][]
 * }}
 */
export function buildRoadGraph(roads) {
  const keyToNodeId = new Map();
  const nodeIdToKey = [];
  const edges = [];
  const adjacency = [];

  function getNodeId(x, z) {
    const key = nodeKey(x, z);
    if (keyToNodeId.has(key)) return keyToNodeId.get(key);
    const id = nodeIdToKey.length;
    keyToNodeId.set(key, id);
    nodeIdToKey.push(key);
    adjacency.push([]);
    return id;
  }

  for (let ri = 0; ri < roads.length; ri++) {
    const pts = roads[ri].points;
    if (!pts || pts.length < 2) continue;
    const x0 = pts[0][0];
    const z0 = pts[0][2];
    const x1 = pts[pts.length - 1][0];
    const z1 = pts[pts.length - 1][2];
    const startId = getNodeId(x0, z0);
    const endId = getNodeId(x1, z1);

    edges.push({ roadIndex: ri, startNodeId: startId, endNodeId: endId });
    adjacency[startId].push({ roadIndex: ri, which: 'start' });
    adjacency[endId].push({ roadIndex: ri, which: 'end' });
  }

  return {
    nodes: nodeIdToKey.map((k) => {
      const [x, z] = k.split(',').map(Number);
      return [x, z];
    }).flat(),
    nodeIdToKey,
    keyToNodeId,
    edges,
    adjacency,
  };
}

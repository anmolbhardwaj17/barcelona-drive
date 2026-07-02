/**
 * RoadTopologyNormalizer: snap road endpoints within snapTolerance so shared junctions
 * use identical (x, z). Run after simplify, before resample. Only (x, z) are modified;
 * elevation (y) is unchanged (Elevation Harmonizer aligns Y later).
 *
 * Uses spatial grid hash + Union-Find to cluster endpoints, then assigns canonical (x,z)
 * per cluster (centroid) and applies back to all roads.
 */

/**
 * Union-Find: parent[i] is the representative index; find with path compression.
 */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }
  function union(i, j) {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  }
  return { find, union };
}

/**
 * Grid cell key for (x, z) with given cell size.
 */
function cellKey(x, z, cellSize) {
  const cx = Math.floor(x / cellSize);
  const cz = Math.floor(z / cellSize);
  return `${cx},${cz}`;
}

/**
 * Normalize road endpoints so that endpoints within snapTolerance get identical (x, z).
 * Mutates road point arrays in place for endpoints only; y and 4th component unchanged.
 *
 * @param {object[]} roads - Each { points: [[x,yUp,z] or [x,yUp,z,terrainHeight], ...] }
 * @param {{ nodeSnapDistance?: number, topologySnapTolerance?: number }} config - nodeSnapDistance (1m) or topologySnapTolerance
 * @returns {object[]} Same road array with endpoint (x,z) updated
 */
export function normalizeRoadTopology(roads, config) {
  const snapTolerance = config.nodeSnapDistance ?? config.topologySnapTolerance ?? 1;
  if (snapTolerance <= 0) return roads;

  const endpoints = [];
  for (let ri = 0; ri < roads.length; ri++) {
    const pts = roads[ri].points;
    if (!pts || pts.length < 2) continue;
    endpoints.push({
      x: pts[0][0],
      z: pts[0][2],
      roadIndex: ri,
      which: 'start',
    });
    endpoints.push({
      x: pts[pts.length - 1][0],
      z: pts[pts.length - 1][2],
      roadIndex: ri,
      which: 'end',
    });
  }

  if (endpoints.length === 0) return roads;

  const n = endpoints.length;
  const uf = makeUnionFind(n);
  const cellSize = Math.max(snapTolerance, 1e-9);
  const grid = new Map();

  for (let i = 0; i < n; i++) {
    const key = cellKey(endpoints[i].x, endpoints[i].z, cellSize);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  const cellOffsets = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  for (let i = 0; i < n; i++) {
    const e = endpoints[i];
    const cx = Math.floor(e.x / cellSize);
    const cz = Math.floor(e.z / cellSize);
    const tolSq = snapTolerance * snapTolerance;

    for (const [dx, dz] of cellOffsets) {
      const key = `${cx + dx},${cz + dz}`;
      const list = grid.get(key);
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const f = endpoints[j];
        const dSq = (e.x - f.x) ** 2 + (e.z - f.z) ** 2;
        if (dSq <= tolSq) uf.union(i, j);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const canonicalX = new Array(n);
  const canonicalZ = new Array(n);
  for (const indices of clusters.values()) {
    let sumX = 0, sumZ = 0;
    for (const i of indices) {
      sumX += endpoints[i].x;
      sumZ += endpoints[i].z;
    }
    const cx = sumX / indices.length;
    const cz = sumZ / indices.length;
    for (const i of indices) {
      canonicalX[i] = cx;
      canonicalZ[i] = cz;
    }
  }

  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const e = endpoints[i];
    const x = canonicalX[root];
    const z = canonicalZ[root];
    const road = roads[e.roadIndex];
    const pts = road.points;
    if (e.which === 'start') {
      pts[0][0] = x;
      pts[0][2] = z;
    } else {
      pts[pts.length - 1][0] = x;
      pts[pts.length - 1][2] = z;
    }
  }

  return roads;
}

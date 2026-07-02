/**
 * Spatial index of roads by bounding box (mercator x,z). Used for tile-streaming:
 * query tile bbox to get road indices for per-tile processing.
 */
import Rbush from 'rbush';

/**
 * Compute road bbox from points. Points are [x, yUp, z] or [x, yUp, z, terrainHeight].
 * Returns { minX, minY, maxX, maxY } for rbush (minY/maxY = mercator z).
 */
function roadBbox(points) {
  if (!points || points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    const x = p[0];
    const z = p[2];
    if (Number.isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (Number.isFinite(z)) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  }
  if (minX === Infinity) minX = maxX = 0;
  if (minZ === Infinity) minZ = maxZ = 0;
  return { minX, minY: minZ, maxX, maxY: maxZ };
}

/**
 * Build R-tree index from simplified roads. Each road gets one bbox entry with idx.
 *
 * @param {object[]} roads - Each { points: [[x,yUp,z], ...], ... }
 * @returns {{ query: (bbox: { minX, minY, maxX, maxY }) => number[] }}
 */
export function buildRoadIndex(roads) {
  const tree = new Rbush();
  const items = [];
  for (let i = 0; i < roads.length; i++) {
    const pts = roads[i].points;
    if (!pts || pts.length < 2) continue;
    const bbox = roadBbox(pts);
    items.push({
      ...bbox,
      idx: i,
    });
  }
  tree.load(items);

  return {
    /**
     * Query roads whose bbox intersects the given bounds.
     * Bounds: { minX, minY, maxX, maxY } in mercator (minY/maxY = z).
     * @returns {number[]} Road indices into the original roads array
     */
    query(bounds) {
      const results = tree.search(bounds);
      return results.map((r) => r.idx);
    },
  };
}

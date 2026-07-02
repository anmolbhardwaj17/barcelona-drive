/**
 * BridgeToBridgeResolver: post-processing pass for link roads connecting
 * bridges at different layers (e.g. layer 1 → layer 2).
 *
 * Runs AFTER resolveRamps() to handle cases where a _link road connects
 * two elevated roads at different layers, creating a smooth elevation
 * gradient instead of a vertical gap.
 *
 * Only modifies _link type highways. Never touches main roads.
 */
import { resolveBaseLayer, LAYER_STEP } from './LayerResolver.js';

const LINK_TYPES = new Set([
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
]);

const MIN_LINK_LENGTH = 40;   // metres — shorter links would be too steep
const MAX_GRADE = 0.15;       // 15% grade limit

/**
 * Compute cumulative arc lengths along a set of points.
 * Points are [x, yUp, z, elevation] during processing.
 * Distance is 2D (x, z) since elevation is what we're setting.
 * @param {number[][]} points
 * @returns {number[]} cumulative distances, same length as points
 */
function cumulativeArcLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dz = points[i][2] - points[i - 1][2];
    lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  return lengths;
}

/**
 * Check whether a road's points already have a non-uniform elevation gradient.
 * Returns true if any point's elevation differs from the first point's elevation.
 */
function hasNonUniformElevation(points) {
  if (points.length < 2) return false;
  const baseElev = points[0][3];
  for (let i = 1; i < points.length; i++) {
    if (points[i][3] !== baseElev) return true;
  }
  return false;
}

/**
 * Find the single elevated (layer > 0) road connected at a node,
 * excluding the link road itself.
 * Returns null if there are zero or multiple elevated connections (ambiguous).
 * @param {string|number} nodeId
 * @param {string|number} selfWayId
 * @param {Map} wayMap
 * @param {Map} nodeToWays
 * @returns {{ wayId, way, baseLayer, baseHeight } | null}
 */
function findSingleElevatedConnection(nodeId, selfWayId, wayMap, nodeToWays) {
  const wayIds = nodeToWays.get(nodeId);
  if (!wayIds) return null;

  const elevated = [];
  for (const wid of wayIds) {
    if (wid === selfWayId) continue;
    const w = wayMap.get(wid);
    if (!w) continue;
    const { baseLayer, baseHeight } = resolveBaseLayer(w);
    if (baseLayer > 0) {
      elevated.push({ wayId: wid, way: w, baseLayer, baseHeight });
    }
  }

  // Only proceed when exactly one elevated road connects here
  if (elevated.length !== 1) return null;
  return elevated[0];
}

/**
 * Resolve bridge-to-bridge elevation transitions for link roads.
 *
 * @param {object} graph - { wayMap, nodeToWays } from RoadGraph
 * @param {Map} rampResult - wayId → { isRamp, vertexHeights?, baseHeight }
 *   (mutated in place — qualifying links get new vertexHeights)
 * @returns {number} count of resolved transitions
 */
export function resolveBridgeToBridge(graph, rampResult) {
  const { wayMap, nodeToWays } = graph;
  let resolved = 0;

  for (const [wayId, way] of wayMap) {
    // ── Filter: only _link highways ──────────────────────────────
    if (!LINK_TYPES.has(way.highwayType)) continue;

    const nodeIds = way.nodeIds || [];
    if (nodeIds.length < 2) continue;

    // ── Skip if already resolved with non-uniform elevation ─────
    const existing = rampResult.get(wayId);
    if (existing?.isRamp && existing.vertexHeights) {
      // Check if already has a non-trivial gradient
      const vh = existing.vertexHeights;
      const first = vh[0];
      if (vh.some(h => h !== first)) continue;
    }

    // ── Find elevated connections at both endpoints ─────────────
    const startNodeId = nodeIds[0];
    const endNodeId = nodeIds[nodeIds.length - 1];

    const startConn = findSingleElevatedConnection(startNodeId, wayId, wayMap, nodeToWays);
    const endConn = findSingleElevatedConnection(endNodeId, wayId, wayMap, nodeToWays);

    // Both endpoints must connect to exactly one elevated road
    if (!startConn || !endConn) continue;

    // The two connected roads must be at different layers
    if (startConn.baseLayer === endConn.baseLayer) continue;

    // ── Check the link road's own points for existing gradient ──
    // We need the road's points to compute length. During graph phase,
    // points may not be projected yet, so use nodeIds length as proxy
    // and check rampResult for existing vertex heights.

    // Compute start and end elevation from connected bridges
    const startElev = startConn.baseLayer * LAYER_STEP;
    const endElev = endConn.baseLayer * LAYER_STEP;
    const heightDiff = Math.abs(endElev - startElev);

    // ── Estimate link length from points if available ───────────
    // During graph phase, way.points may contain lat/lon objects or
    // projected [x, y, z] arrays. We need to handle both.
    let linkLength = 0;
    const points = way.points;
    if (points && points.length >= 2) {
      // Check if points are projected (arrays) or lat/lon objects
      if (Array.isArray(points[0])) {
        const arcs = cumulativeArcLengths(points);
        linkLength = arcs[arcs.length - 1];
      } else {
        // lat/lon objects — approximate distance using haversine-lite
        for (let i = 1; i < points.length; i++) {
          const p0 = points[i - 1];
          const p1 = points[i];
          const lat0 = p0.lat ?? p0[1];
          const lon0 = p0.lon ?? p0[0];
          const lat1 = p1.lat ?? p1[1];
          const lon1 = p1.lon ?? p1[0];
          if (lat0 == null || lon0 == null || lat1 == null || lon1 == null) continue;
          const dLat = (lat1 - lat0) * 111320;
          const dLon = (lon1 - lon0) * 111320 * Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
          linkLength += Math.sqrt(dLat * dLat + dLon * dLon);
        }
      }
    } else {
      // No points available — skip (can't verify length)
      continue;
    }

    // ── Safety: minimum length ──────────────────────────────────
    if (linkLength < MIN_LINK_LENGTH) continue;

    // ── Safety: maximum grade ───────────────────────────────────
    if (linkLength > 0 && heightDiff / linkLength > MAX_GRADE) continue;

    // ── Interpolate elevation along the link ────────────────────
    const n = nodeIds.length;
    const vertexHeights = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = n <= 1 ? 0 : i / (n - 1);
      vertexHeights[i] = startElev + t * (endElev - startElev);
    }

    rampResult.set(wayId, { isRamp: true, vertexHeights });
    resolved++;
  }

  return resolved;
}

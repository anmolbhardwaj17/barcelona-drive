/**
 * OsmDataFixer: preprocessing pass that cleans up OSM data before
 * junction classification and ramp resolution.
 *
 * Rules (applied in order):
 *   4. Orphan Short Bridge Cleaner
 *   5. Duplicate Road Remover
 *   1. Bridge Layer Conflict Resolver
 *   6. Ground Road Lateral Offset Under Bridges
 *
 * Pure topology + geometry fixes. No DEM. No terrain.
 */

// ─── Highway type priority (higher = more important / wider) ─────────────
const HIGHWAY_PRIORITY = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  motorway_link: 5, trunk_link: 5, primary_link: 5,
  secondary_link: 4, tertiary_link: 4,
  residential: 3, living_street: 3, unclassified: 3,
  service: 2, track: 1,
};

function highwayPriority(type) {
  return HIGHWAY_PRIORITY[type] ?? 2;
}

// ─── Synthetic node ID counter ───────────────────────────────────────────
let syntheticNodeId = -1000000;
function nextSyntheticId() {
  return syntheticNodeId--;
}

// ═══════════════════════════════════════════════════════════════════════════
// Geometry helpers
// ═══════════════════════════════════════════════════════════════════════════

const DEG_TO_M = 111320;

/**
 * Haversine-lite: approximate lat/lon delta to metres.
 * Returns { dx (east-west), dz (north-south) }.
 */
function toMeters(lat1, lon1, lat2, lon2) {
  const dz = (lat2 - lat1) * DEG_TO_M;
  const dx = (lon2 - lon1) * DEG_TO_M * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return { dx, dz };
}

/**
 * Polyline length in metres from nodeIds + nodeMap.
 */
function wayLength(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < ids.length; i++) {
    const a = nodeMap.get(ids[i - 1]);
    const b = nodeMap.get(ids[i]);
    if (!a || !b) continue;
    const { dx, dz } = toMeters(a.lat, a.lon, b.lat, b.lon);
    total += Math.sqrt(dx * dx + dz * dz);
  }
  return total;
}

/**
 * Point-to-segment distance in metres (2D, using metric coords).
 */
function pointToSegDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq === 0) {
    const ex = px - ax;
    const ez = pz - az;
    return Math.sqrt(ex * ex + ez * ez);
  }
  let t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cz = az + t * abz;
  const ex = px - cx;
  const ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Minimum distance from a point to a polyline (array of {dx, dz} metric coords).
 */
function pointToPolylineDist(px, pz, polyMetric) {
  let minD = Infinity;
  for (let i = 0; i < polyMetric.length - 1; i++) {
    const d = pointToSegDist(px, pz, polyMetric[i].dx, polyMetric[i].dz,
      polyMetric[i + 1].dx, polyMetric[i + 1].dz);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * 2D segment-segment intersection test.
 * Returns true if segments (a1→a2) and (b1→b2) cross.
 */
function segmentsIntersect(a1x, a1z, a2x, a2z, b1x, b1z, b2x, b2z) {
  const d1x = a2x - a1x, d1z = a2z - a1z;
  const d2x = b2x - b1x, d2z = b2z - b1z;
  const cross = d1x * d2z - d1z * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel
  const dx = b1x - a1x, dz = b1z - a1z;
  const t = (dx * d2z - dz * d2x) / cross;
  const u = (dx * d1z - dz * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * Compute bounding box of a way in approximate metres, relative to
 * the way's first node (origin). Returns { minX, minZ, maxX, maxZ, originLat, originLon }.
 */
function wayBbox(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length === 0) return null;
  const origin = nodeMap.get(ids[0]);
  if (!origin) return null;

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  let validCount = 0;
  for (const nid of ids) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    const { dx, dz } = toMeters(origin.lat, origin.lon, n.lat, n.lon);
    if (dx < minX) minX = dx;
    if (dx > maxX) maxX = dx;
    if (dz < minZ) minZ = dz;
    if (dz > maxZ) maxZ = dz;
    validCount++;
  }
  if (validCount < 2) return null;
  return { minX, minZ, maxX, maxZ, originLat: origin.lat, originLon: origin.lon };
}

/**
 * Compute bounding box in lat/lon (no metric conversion needed for overlap test).
 */
function wayBboxLatLon(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length === 0) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let valid = 0;
  for (const nid of ids) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
    valid++;
  }
  if (valid < 2) return null;
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Check if two lat/lon bboxes overlap with a margin in degrees.
 */
function bboxOverlapLatLon(a, b, marginDeg) {
  if (!a || !b) return false;
  return a.minLat - marginDeg <= b.maxLat &&
         a.maxLat + marginDeg >= b.minLat &&
         a.minLon - marginDeg <= b.maxLon &&
         a.maxLon + marginDeg >= b.minLon;
}

/**
 * Convert a way's node coordinates to metric coords relative to a reference point.
 */
function wayToMetric(way, nodeMap, refLat, refLon) {
  const result = [];
  for (const nid of way.nodeIds) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    const { dx, dz } = toMeters(refLat, refLon, n.lat, n.lon);
    result.push({ dx, dz, nodeId: nid });
  }
  return result;
}

/**
 * Sample points along a polyline at approximately the given interval (metres).
 * Input: array of { dx, dz }.
 * Returns array of { dx, dz }.
 */
function samplePolyline(polyMetric, interval) {
  if (polyMetric.length < 2) return [...polyMetric];
  const samples = [polyMetric[0]];
  let carry = 0;
  for (let i = 1; i < polyMetric.length; i++) {
    const segDx = polyMetric[i].dx - polyMetric[i - 1].dx;
    const segDz = polyMetric[i].dz - polyMetric[i - 1].dz;
    const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
    if (segLen === 0) continue;
    let pos = interval - carry;
    while (pos <= segLen) {
      const t = pos / segLen;
      samples.push({
        dx: polyMetric[i - 1].dx + t * segDx,
        dz: polyMetric[i - 1].dz + t * segDz,
      });
      pos += interval;
    }
    carry = segLen - (pos - interval);
  }
  return samples;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 4: Orphan Short Bridge Cleaner
// ═══════════════════════════════════════════════════════════════════════════

function rule4_orphanShortBridge(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  for (const [wayId, way] of wayMap) {
    if (!way.bridge && (way.layer || 0) <= 0) continue;
    if ((way.highwayType || '').includes('rail')) continue;

    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;

    // Check length < 30m
    const len = wayLength(way, nodeMap);
    if (len >= 30) continue;

    // Check if start AND end are truly orphaned (not shared with any other way)
    const startNodeId = ids[0];
    const endNodeId = ids[ids.length - 1];

    const startWays = nodeToWays.get(startNodeId);
    const endWays = nodeToWays.get(endNodeId);

    const startOrphaned = !startWays || startWays.size <= 1;
    const endOrphaned = !endWays || endWays.size <= 1;

    if (!startOrphaned || !endOrphaned) continue;

    // Demote: remove bridge status
    way.bridge = false;
    way.layer = 0;
    fixed++;
  }
  return fixed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 5: Duplicate Road Remover
// ═══════════════════════════════════════════════════════════════════════════

function rule5_duplicateRoadRemover(wayMap, nodeToWays, nodeMap) {
  let removed = 0;

  // Margin ~50m in degrees (approx)
  const MARGIN_DEG = 50 / DEG_TO_M;
  const SAMPLE_INTERVAL = 10; // metres
  const MAX_DIST = 3;         // metres
  const MIN_RATIO = 0.8;      // 80% of samples must be within MAX_DIST

  // Build bbox + length for all ways
  const wayEntries = [];
  for (const [wayId, way] of wayMap) {
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;
    const len = wayLength(way, nodeMap);
    wayEntries.push({ wayId, way, bbox, len });
  }

  // Sort by length descending so we process longer roads first
  wayEntries.sort((a, b) => b.len - a.len);

  const removedSet = new Set();

  for (let i = 0; i < wayEntries.length; i++) {
    const ea = wayEntries[i];
    if (removedSet.has(ea.wayId)) continue;

    for (let j = i + 1; j < wayEntries.length; j++) {
      const eb = wayEntries[j];
      if (removedSet.has(eb.wayId)) continue;

      // Must have same highway type
      if (ea.way.highwayType !== eb.way.highwayType) continue;

      // Skip if one is bridge and other isn't
      if (ea.way.bridge !== eb.way.bridge) continue;

      // Bbox overlap check
      if (!bboxOverlapLatLon(ea.bbox, eb.bbox, MARGIN_DEG)) continue;

      // eb is the shorter (or equal) road since sorted desc
      const shorter = eb;
      const longer = ea;

      // Use the first node of the shorter road as metric origin
      const firstNode = nodeMap.get(shorter.way.nodeIds[0]);
      if (!firstNode) continue;

      const shorterMetric = wayToMetric(shorter.way, nodeMap, firstNode.lat, firstNode.lon);
      const longerMetric = wayToMetric(longer.way, nodeMap, firstNode.lat, firstNode.lon);

      if (shorterMetric.length < 2 || longerMetric.length < 2) continue;

      // Sample the shorter road
      const samples = samplePolyline(shorterMetric, SAMPLE_INTERVAL);
      if (samples.length === 0) continue;

      // Check how many samples are within MAX_DIST of the longer road
      let withinCount = 0;
      for (const s of samples) {
        const d = pointToPolylineDist(s.dx, s.dz, longerMetric);
        if (d <= MAX_DIST) withinCount++;
      }

      if (withinCount / samples.length >= MIN_RATIO) {
        // Remove the shorter road
        removedSet.add(shorter.wayId);
        wayMap.delete(shorter.wayId);
        // Clean nodeToWays
        for (const nid of shorter.way.nodeIds) {
          const waySet = nodeToWays.get(nid);
          if (waySet) {
            waySet.delete(shorter.wayId);
            if (waySet.size === 0) nodeToWays.delete(nid);
          }
        }
        removed++;
      }
    }
  }

  return removed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 1: Bridge Layer Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

function rule1_bridgeLayerConflict(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  const MARGIN_DEG = 100 / DEG_TO_M;

  // Collect all elevated roads
  const elevated = [];
  for (const [wayId, way] of wayMap) {
    if (!way.bridge && (way.layer || 0) <= 0) continue;
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;
    elevated.push({ wayId, way, bbox });
  }

  for (let i = 0; i < elevated.length; i++) {
    const ea = elevated[i];
    for (let j = i + 1; j < elevated.length; j++) {
      const eb = elevated[j];

      // Skip if different layers already
      if ((ea.way.layer || 0) !== (eb.way.layer || 0)) continue;

      // Skip if they share any nodeId (connected = intentional)
      const nodeSetA = new Set(ea.way.nodeIds);
      let shared = false;
      for (const nid of eb.way.nodeIds) {
        if (nodeSetA.has(nid)) { shared = true; break; }
      }
      if (shared) continue;

      // Bbox overlap check
      if (!bboxOverlapLatLon(ea.bbox, eb.bbox, MARGIN_DEG)) continue;

      // Convert to metric for intersection test
      const firstNodeA = nodeMap.get(ea.way.nodeIds[0]);
      if (!firstNodeA) continue;

      const metricA = wayToMetric(ea.way, nodeMap, firstNodeA.lat, firstNodeA.lon);
      const metricB = wayToMetric(eb.way, nodeMap, firstNodeA.lat, firstNodeA.lon);

      if (metricA.length < 2 || metricB.length < 2) continue;

      // Test segment-segment crossings
      let crossing = false;
      for (let si = 0; si < metricA.length - 1 && !crossing; si++) {
        for (let sj = 0; sj < metricB.length - 1 && !crossing; sj++) {
          if (segmentsIntersect(
            metricA[si].dx, metricA[si].dz, metricA[si + 1].dx, metricA[si + 1].dz,
            metricB[sj].dx, metricB[sj].dz, metricB[sj + 1].dx, metricB[sj + 1].dz,
          )) {
            crossing = true;
          }
        }
      }

      if (!crossing) continue;

      // Bump the narrower (lower priority) road's layer
      const prioA = highwayPriority(ea.way.highwayType);
      const prioB = highwayPriority(eb.way.highwayType);
      if (prioA <= prioB) {
        ea.way.layer = (ea.way.layer || 0) + 1;
      } else {
        eb.way.layer = (eb.way.layer || 0) + 1;
      }
      fixed++;
    }
  }

  return fixed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 6: Ground Road Lateral Offset Under Bridges
// ═══════════════════════════════════════════════════════════════════════════

function rule6_groundRoadOffset(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  const MARGIN_DEG = 100 / DEG_TO_M;
  const BLEND_DIST = 20; // metres for smooth blending
  const EXTRA_CLEARANCE = 3; // metres beyond bridge half-width

  // Collect ground roads and elevated roads
  const groundRoads = [];
  const elevatedRoads = [];
  for (const [wayId, way] of wayMap) {
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;

    if ((way.layer || 0) === 0 && !way.bridge) {
      groundRoads.push({ wayId, way, bbox });
    } else if (way.bridge || (way.layer || 0) > 0) {
      elevatedRoads.push({ wayId, way, bbox });
    }
  }

  for (const gEntry of groundRoads) {
    const gWay = gEntry.way;
    const gIds = gWay.nodeIds;

    for (const eEntry of elevatedRoads) {
      const eWay = eEntry.way;

      // Bbox overlap check
      if (!bboxOverlapLatLon(gEntry.bbox, eEntry.bbox, MARGIN_DEG)) continue;

      // Skip if they share a nodeId (connected at junction)
      const eNodeSet = new Set(eWay.nodeIds);
      let shared = false;
      for (const nid of gIds) {
        if (eNodeSet.has(nid)) { shared = true; break; }
      }
      if (shared) continue;

      // Compute approximate direction of each road
      const gFirst = nodeMap.get(gIds[0]);
      const gLast = nodeMap.get(gIds[gIds.length - 1]);
      if (!gFirst || !gLast) continue;

      const eIds = eWay.nodeIds;
      const eFirst = nodeMap.get(eIds[0]);
      const eLast = nodeMap.get(eIds[eIds.length - 1]);
      if (!eFirst || !eLast) continue;

      const gDir = toMeters(gFirst.lat, gFirst.lon, gLast.lat, gLast.lon);
      const eDir = toMeters(eFirst.lat, eFirst.lon, eLast.lat, eLast.lon);

      const gLen = Math.sqrt(gDir.dx * gDir.dx + gDir.dz * gDir.dz);
      const eLen = Math.sqrt(eDir.dx * eDir.dx + eDir.dz * eDir.dz);
      if (gLen === 0 || eLen === 0) continue;

      // Normalize and compute dot product
      const dot = (gDir.dx * eDir.dx + gDir.dz * eDir.dz) / (gLen * eLen);

      // Skip if roughly perpendicular (crossing is fine)
      if (Math.abs(dot) < 0.7) continue;

      // Convert bridge to metric relative to gFirst
      const bridgeMetric = wayToMetric(eWay, nodeMap, gFirst.lat, gFirst.lon);
      if (bridgeMetric.length < 2) continue;

      // Estimate bridge half-width (rough: 4m default)
      const bridgeHalfWidth = 4 + EXTRA_CLEARANCE;

      // For each ground road point, check if it's in the overlap zone
      let wayModified = false;
      // Track which indices are in the zone and their offsets
      const offsets = new Array(gIds.length).fill(0);
      const inZone = new Array(gIds.length).fill(false);

      for (let pi = 0; pi < gIds.length; pi++) {
        const gNode = nodeMap.get(gIds[pi]);
        if (!gNode) continue;

        const { dx: px, dz: pz } = toMeters(gFirst.lat, gFirst.lon, gNode.lat, gNode.lon);

        // Distance to bridge centerline
        const distToBridge = pointToPolylineDist(px, pz, bridgeMetric);

        if (distToBridge < bridgeHalfWidth) {
          inZone[pi] = true;

          // Find closest point on bridge to determine offset direction
          let minD = Infinity;
          let closestSeg = 0;
          for (let si = 0; si < bridgeMetric.length - 1; si++) {
            const d = pointToSegDist(px, pz,
              bridgeMetric[si].dx, bridgeMetric[si].dz,
              bridgeMetric[si + 1].dx, bridgeMetric[si + 1].dz);
            if (d < minD) { minD = d; closestSeg = si; }
          }

          // Bridge segment direction
          const bsDx = bridgeMetric[closestSeg + 1].dx - bridgeMetric[closestSeg].dx;
          const bsDz = bridgeMetric[closestSeg + 1].dz - bridgeMetric[closestSeg].dz;
          const bsLen = Math.sqrt(bsDx * bsDx + bsDz * bsDz);
          if (bsLen === 0) continue;

          // Perpendicular to bridge segment (right-hand normal)
          let perpDx = -bsDz / bsLen;
          let perpDz = bsDx / bsLen;

          // Determine which side the ground point is on
          const toPx = px - bridgeMetric[closestSeg].dx;
          const toPz = pz - bridgeMetric[closestSeg].dz;
          const side = toPx * perpDx + toPz * perpDz;
          if (side < 0) { perpDx = -perpDx; perpDz = -perpDz; }

          // Push point to bridgeHalfWidth distance from bridge center
          const pushDist = bridgeHalfWidth - distToBridge;
          if (pushDist > 0) {
            offsets[pi] = pushDist;
          }
        }
      }

      // Check if any points need offsetting
      if (!offsets.some(o => o > 0)) continue;

      // Apply offsets with blending at zone boundaries
      // Find zone boundaries for blending
      for (let pi = 0; pi < gIds.length; pi++) {
        if (offsets[pi] <= 0) continue;

        // Compute blend factor based on distance to zone edge
        let blendFactor = 1.0;

        // Find cumulative distance from zone start
        let distFromStart = 0;
        for (let k = pi - 1; k >= 0; k--) {
          const nA = nodeMap.get(gIds[k]);
          const nB = nodeMap.get(gIds[k + 1]);
          if (!nA || !nB) break;
          const { dx, dz } = toMeters(nA.lat, nA.lon, nB.lat, nB.lon);
          distFromStart += Math.sqrt(dx * dx + dz * dz);
          if (!inZone[k]) break;
        }

        // Find cumulative distance to zone end
        let distToEnd = 0;
        for (let k = pi + 1; k < gIds.length; k++) {
          const nA = nodeMap.get(gIds[k - 1]);
          const nB = nodeMap.get(gIds[k]);
          if (!nA || !nB) break;
          const { dx, dz } = toMeters(nA.lat, nA.lon, nB.lat, nB.lon);
          distToEnd += Math.sqrt(dx * dx + dz * dz);
          if (!inZone[k]) break;
        }

        const edgeDist = Math.min(distFromStart, distToEnd);
        if (edgeDist < BLEND_DIST) {
          blendFactor = edgeDist / BLEND_DIST;
          blendFactor = blendFactor * blendFactor * (3 - 2 * blendFactor); // smoothstep
        }

        const finalOffset = offsets[pi] * blendFactor;
        if (finalOffset < 0.1) continue;

        // Get the node and compute offset direction
        const gNode = nodeMap.get(gIds[pi]);
        if (!gNode) continue;

        const { dx: px, dz: pz } = toMeters(gFirst.lat, gFirst.lon, gNode.lat, gNode.lon);

        // Find closest bridge segment for perpendicular direction
        let minD = Infinity;
        let closestSeg = 0;
        for (let si = 0; si < bridgeMetric.length - 1; si++) {
          const d = pointToSegDist(px, pz,
            bridgeMetric[si].dx, bridgeMetric[si].dz,
            bridgeMetric[si + 1].dx, bridgeMetric[si + 1].dz);
          if (d < minD) { minD = d; closestSeg = si; }
        }

        const bsDx = bridgeMetric[closestSeg + 1].dx - bridgeMetric[closestSeg].dx;
        const bsDz = bridgeMetric[closestSeg + 1].dz - bridgeMetric[closestSeg].dz;
        const bsLen = Math.sqrt(bsDx * bsDx + bsDz * bsDz);
        if (bsLen === 0) continue;

        let perpDx = -bsDz / bsLen;
        let perpDz = bsDx / bsLen;
        const toPx = px - bridgeMetric[closestSeg].dx;
        const toPz = pz - bridgeMetric[closestSeg].dz;
        const side = toPx * perpDx + toPz * perpDz;
        if (side < 0) { perpDx = -perpDx; perpDz = -perpDz; }

        // Convert offset back to lat/lon delta
        const offsetDx = perpDx * finalOffset;
        const offsetDz = perpDz * finalOffset;
        const cosLat = Math.cos(gNode.lat * Math.PI / 180);
        const dLon = offsetDx / (DEG_TO_M * cosLat);
        const dLat = offsetDz / DEG_TO_M;

        // Create a new synthetic node instead of mutating shared nodes
        const newNodeId = nextSyntheticId();
        nodeMap.set(newNodeId, { lat: gNode.lat + dLat, lon: gNode.lon + dLon });

        // Replace nodeId in the ground way
        const oldNodeId = gIds[pi];
        gWay.nodeIds[pi] = newNodeId;

        // Update nodeToWays: remove old mapping for this way, add new
        const oldSet = nodeToWays.get(oldNodeId);
        if (oldSet) {
          oldSet.delete(gEntry.wayId);
          if (oldSet.size === 0) nodeToWays.delete(oldNodeId);
        }
        if (!nodeToWays.has(newNodeId)) nodeToWays.set(newNodeId, new Set());
        nodeToWays.get(newNodeId).add(gEntry.wayId);

        wayModified = true;
      }

      if (wayModified) fixed++;
    }
  }

  return fixed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fix OSM data issues in the road graph.
 * Mutates graph.wayMap, graph.nodeToWays, and nodeMap in place.
 *
 * @param {object} graph - { wayMap, nodeToWays, nodeMap } from buildFromWays
 * @param {Map} nodeMap - nodeId → { lat, lon }
 * @returns {{ rule4, rule5, rule1, rule6 }} counts of fixes applied per rule
 */
export function fixOsmData(graph, nodeMap) {
  const { wayMap, nodeToWays } = graph;

  // Use graph's nodeMap if separate nodeMap not provided
  const nm = nodeMap || graph.nodeMap;

  const rule4 = rule4_orphanShortBridge(wayMap, nodeToWays, nm);
  const rule5 = rule5_duplicateRoadRemover(wayMap, nodeToWays, nm);
  const rule1 = rule1_bridgeLayerConflict(wayMap, nodeToWays, nm);
  const rule6 = rule6_groundRoadOffset(wayMap, nodeToWays, nm);

  return { rule4, rule5, rule1, rule6 };
}

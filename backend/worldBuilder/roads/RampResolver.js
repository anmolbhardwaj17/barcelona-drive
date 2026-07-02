/**
 * RampResolver: detect ramp ways and compute per-vertex heights.
 *
 * Non-bridge ways: classic ramp detection — if two endpoints connect to roads at
 * different heights, interpolate (e.g. ground 0→bridge 6m).
 *
 * Bridge ways: only consider other elevated (bridge/layer≥1) connections at each
 * endpoint. This lets a layer-1 bridge ramp to layer-2 (6→12m) without being
 * pulled down to ground (0m) by a co-located ground road.
 *
 * Bridge-to-bridge transitions: when two bridges at different layers share a node,
 * there's no space for a separate ramp. We create a smooth transition by ramping
 * the last few points of each bridge toward the shared height.
 *
 * Tunnel ways: fixed height, never ramps.
 * No terrain. No DEM.
 */
import { resolveBaseLayer, LAYER_STEP } from './LayerResolver.js';
import { mercatorToWorld } from '../../projection.js';

// Ramp grade limits (rise/run). MAX_RAMP_GRADE matches the validator's flag threshold
// (tools/tunnel-inspect.mjs --validate). CONSTRUCT_RAMP_GRADE is the gentler target used
// when building Case-C valley ramps so constructed ramps sit comfortably under the flag.
const MAX_RAMP_GRADE = 0.15;
const CONSTRUCT_RAMP_GRADE = 0.12;

/**
 * Cumulative ground distance (metres) along a way's points. Points are Mercator
 * {x, y, lat, lon}. Under Unstretch-X the projection (`mercatorToWorld`) already yields
 * real-metre world coords, so we measure distance in world space — no local cos(lat)
 * correction (purged per vertical-model-foundation-spec §3; the projection owns the unit factor).
 */
function cumulativeGroundDist(points) {
  const d = new Array(points.length).fill(0);
  let prev = mercatorToWorld(points[0].x ?? 0, points[0].y ?? 0);
  for (let i = 1; i < points.length; i++) {
    const cur = mercatorToWorld(points[i].x ?? 0, points[i].y ?? 0);
    d[i] = d[i - 1] + Math.hypot(cur.x - prev.x, cur.z - prev.z);
    prev = cur;
  }
  return d;
}

/**
 * Find the height that best represents the "target" elevation at a node.
 * Looks at other roads connected at this node and returns the height that
 * differs most from selfBaseHeight.
 *
 * @param {boolean} onlyElevated - when true, only consider bridge/elevated (layer≥1)
 *   connections (used for bridge ways so ground roads don't pull height to 0).
 */
function getEndpointTargetHeight(nodeId, selfWayId, selfBaseHeight, wayMap, nodeToWays, onlyElevated) {
  const wayIds = nodeToWays.get(nodeId);
  if (!wayIds) return selfBaseHeight;
  let bestHeight = selfBaseHeight;
  let bestDiff = 0;
  let foundElevated = false;
  let hasGroundConnection = false;
  for (const wid of wayIds) {
    if (wid === selfWayId) continue;
    const w = wayMap.get(wid);
    if (!w) continue;
    const { baseLayer, baseHeight } = resolveBaseLayer(w);
    if (onlyElevated && !w.bridge && baseLayer <= 0) {
      // Track that ground roads exist at this node even though we skip them
      hasGroundConnection = true;
      continue;
    }
    foundElevated = true;
    const diff = Math.abs(baseHeight - selfBaseHeight);
    if (diff > bestDiff) {
      bestDiff = diff;
      bestHeight = baseHeight;
    }
  }
  // If this bridge endpoint has NO elevated connections but DOES connect to
  // ground roads, the bridge must ramp down to ground level (0).
  if (onlyElevated && !foundElevated && hasGroundConnection) {
    return 0;
  }
  return bestHeight;
}

/**
 * Detect ramps and compute vertexHeights for each way.
 * @param {object} graph - { wayMap, nodeToWays } from RoadGraph
 * @returns {Map<wayId, { isRamp: boolean, vertexHeights?: number[], baseHeight: number }>}
 */
export function resolveRamps(graph) {
  const { wayMap, nodeToWays } = graph;
  const result = new Map();
  let tunnelRampCount = 0;  // logged at end for diagnostics
  let caseCValley = 0;      // Case C short tunnels given a valley ramp
  let caseCFlatten = 0;     // Case C short tunnels flattened to surface (covered road)
  const flattenedShortTunnels = []; // wayIds flattened — reported by the bake

  for (const [wayId, way] of wayMap) {
    const nodeIds = way.nodeIds || [];
    if (nodeIds.length < 2) continue;

    const { baseHeight } = resolveBaseLayer(way);
    const n = nodeIds.length;
    const FLAT_FRACTION = 0.20;

    // ── Tunnel ramp detection ─────────────────────────────────────────────
    // Previous behavior: all tunnels fixed at baseHeight, no ramp interpolation.
    // New behavior: if EXACTLY ONE endpoint connects to a non-tunnel road at a
    // different height (i.e. a surface portal), classify as ramp so the tunnel
    // descends smoothly from surface level to underground depth.
    //
    // Three cases:
    //   [A] Both endpoints → other tunnels only: mid-tunnel segment, keep flat.
    //   [B] Exactly one endpoint → surface road: classify as ramp (this fix).
    //   [C] Both endpoints → surface roads: short tunnel between surface sections;
    //       deferred — keeping flat (known limitation, see Section 5.5 of roadmap).
    if (way.tunnel) {
      const startTarget = getEndpointTargetHeight(nodeIds[0],     wayId, baseHeight, wayMap, nodeToWays, false);
      const endTarget   = getEndpointTargetHeight(nodeIds[n - 1], wayId, baseHeight, wayMap, nodeToWays, false);
      // A height difference > 0.5m means a connected road at a different layer was found.
      // Heights are multiples of LAYER_STEP (6m) so 0.5m threshold is safe.
      const startIsSurface = Math.abs(startTarget - baseHeight) > 0.5;
      const endIsSurface   = Math.abs(endTarget   - baseHeight) > 0.5;

      if (!startIsSurface && !endIsSurface) {
        // Case [A]: neither endpoint reaches surface — mid-tunnel segment, keep flat.
        result.set(wayId, { isRamp: false, baseHeight });
        continue;
      }
      if (startIsSurface && endIsSurface) {
        // Case [C] (TASK A): short tunnel between two surface roads. Build a valley that
        // surface-anchors BOTH ends to the connecting surface roads' actual baked Y
        // (startTarget/endTarget — NOT a synthetic 0) and dips to the layer-space interior
        // depth in between. If the way is too short to fit a descent + ascent even at the
        // flag grade, flatten it to the surface and treat it as a covered surface road
        // (no abrupt walls, no underground dip). Interior depth stays in layer space.
        const pts = way.points || [];
        const depth = baseHeight; // negative layer-space interior depth (e.g. -6)
        const useDist = pts.length === n && n >= 2;
        const dist = useDist ? cumulativeGroundDist(pts) : null;
        const L = useDist ? dist[n - 1] : 0;
        const minHalf = Math.abs(depth) / MAX_RAMP_GRADE; // shortest descent at the flag grade
        if (!useDist || L < 2 * minHalf) {
          // Too short to descend AND ascend at ≤ flag grade. Don't dip. Connect the two ends
          // with a MONOTONIC linear profile from startTarget → endTarget so BOTH endpoints
          // match their connecting roads' actual baked Y (no vertical crack). When both ends
          // are at the same level (the common 0→0 case) this is flat — a covered surface road.
          // When they differ (a short layer-transition segment) it is a short ramp, which may
          // be steep and is surfaced by the ramp-grade diagnostic for Phase 2.
          const vertexHeights = nodeIds.map((_, i) => {
            const t = useDist ? (L > 0 ? dist[i] / L : 0) : (n <= 1 ? 0 : i / (n - 1));
            return startTarget + t * (endTarget - startTarget);
          });
          const flat = Math.abs(startTarget - endTarget) < 0.5;
          result.set(wayId, { isRamp: true, vertexHeights, flattenedShortTunnel: true, flat });
          flattenedShortTunnels.push({ wayId, lengthM: Math.round(L), startH: +startTarget.toFixed(2), endH: +endTarget.toFixed(2), flat });
          caseCFlatten++;
          continue;
        }
        // Valley: descend startTarget→depth over rampEach, flat at depth, ascend depth→endTarget.
        // rampEach is the gentler of (target-grade length) and (half the way) so the built
        // grade is always ≤ flag grade; lengthen into the interior rather than steepen.
        const rampEach = Math.min(Math.abs(depth) / CONSTRUCT_RAMP_GRADE, L / 2);
        const vertexHeights = nodeIds.map((_, i) => {
          const x = dist[i];
          if (x <= rampEach) {
            const t = rampEach <= 0 ? 1 : x / rampEach;
            const s = t * t * (3 - 2 * t);
            return startTarget + s * (depth - startTarget);
          }
          if (x >= L - rampEach) {
            const t = rampEach <= 0 ? 1 : (L - x) / rampEach;
            const s = t * t * (3 - 2 * t);
            return endTarget + s * (depth - endTarget);
          }
          return depth; // flat interior at layer-space depth (unchanged)
        });
        result.set(wayId, { isRamp: true, vertexHeights });
        caseCValley++;
        continue;
      }

      // Case [B]: exactly one surface endpoint — ramp from underground to surface.
      // startH/endH follow the same convention as non-tunnel ramps below.
      const startH = startIsSurface ? startTarget : baseHeight;
      const endH   = endIsSurface   ? endTarget   : baseHeight;
      const startIsGround = Math.abs(startH) < Math.abs(endH);
      const vertexHeights = nodeIds.map((_, i) => {
        const rawT = n <= 1 ? 0 : i / (n - 1);
        let t;
        if (startIsGround) {
          t = rawT <= FLAT_FRACTION ? 0 : (rawT - FLAT_FRACTION) / (1 - FLAT_FRACTION);
        } else {
          t = rawT >= (1 - FLAT_FRACTION) ? 1 : rawT / (1 - FLAT_FRACTION);
        }
        const s = t * t * (3 - 2 * t);
        return startH + s * (endH - startH);
      });
      result.set(wayId, { isRamp: true, vertexHeights });
      tunnelRampCount++;
      continue;
    }

    // ── Non-tunnel ramp detection (unchanged) ─────────────────────────────
    // For bridge ways: only look at other elevated connections (don't let ground pull to 0).
    // For non-bridge ways: look at all connections (classic ramp: ground→bridge).
    const onlyElevated = !!way.bridge;

    const startH = getEndpointTargetHeight(nodeIds[0],                  wayId, baseHeight, wayMap, nodeToWays, onlyElevated);
    const endH   = getEndpointTargetHeight(nodeIds[nodeIds.length - 1], wayId, baseHeight, wayMap, nodeToWays, onlyElevated);

    if (startH === endH) {
      // Both endpoints at the same height — not a ramp.
      result.set(wayId, { isRamp: false, baseHeight });
      continue;
    }

    // Interpolate vertex heights from startH to endH with a flat buffer at the
    // ground-level end so the ramp stays flush with the road it connects to
    // before climbing.  The flat fraction keeps ~20% of the road at ground height.
    const startIsGround = Math.abs(startH) < Math.abs(endH);
    const vertexHeights = nodeIds.map((_, i) => {
      const rawT = n <= 1 ? 0 : i / (n - 1);
      let t;
      if (startIsGround) {
        // Ground at start → ramp up toward end; flat buffer at start
        t = rawT <= FLAT_FRACTION ? 0 : (rawT - FLAT_FRACTION) / (1 - FLAT_FRACTION);
      } else {
        // Ground at end → ramp down from start; flat buffer at end
        t = rawT >= (1 - FLAT_FRACTION) ? 1 : rawT / (1 - FLAT_FRACTION);
      }
      // Smoothstep for gentle slope transition
      const s = t * t * (3 - 2 * t);
      return startH + s * (endH - startH);
    });

    result.set(wayId, { isRamp: true, vertexHeights });
  }

  if (tunnelRampCount > 0) {
    console.log(`  Tunnel portals reclassified as ramps: ${tunnelRampCount} (single-surface Case B)`);
  }
  if (caseCValley > 0 || caseCFlatten > 0) {
    console.log(`  Case C short tunnels: ${caseCValley} valley-ramped, ${caseCFlatten} flattened to surface (covered roads)`);
    if (flattenedShortTunnels.length > 0) {
      console.log('  Flattened short tunnels:', JSON.stringify(flattenedShortTunnels.slice(0, 20)));
    }
  }

  // ── Post-process: smooth bridge-to-bridge layer transitions ──────────
  // When two bridges at different layers share a node with NO ramp between them,
  // ramp the last few points of each bridge toward the other's height.
  // This creates a smooth transition where the bridges meet.
  smoothBridgeTransitions(wayMap, nodeToWays, result);

  return result;
}

/**
 * Find bridge-to-bridge connections at different layers and create smooth
 * height transitions by modifying the last few vertex heights on each bridge.
 *
 * For each shared node between layer-N and layer-M bridges (N < M):
 *   - Lower bridge: last TRANSITION_POINTS ramp from N*STEP toward M*STEP
 *   - Upper bridge: first TRANSITION_POINTS ramp from N*STEP toward M*STEP
 * The transition blends so they meet at the shared node.
 */
function smoothBridgeTransitions(wayMap, nodeToWays, result) {
  // How many points at each end of a bridge to use for the transition ramp
  const TRANSITION_POINTS = 4;
  // Fraction of height difference to cover (1.0 = full transition, meet in the middle)
  const BLEND = 1.0;

  // Build a set of all nodes where bridges at different layers meet
  // Map: nodeId → [{ wayId, layer, baseHeight, isStart }]
  const bridgeEndpoints = new Map();

  for (const [wayId, way] of wayMap) {
    if (!way.bridge) continue;
    if (way.tunnel) continue;
    const nodeIds = way.nodeIds || [];
    if (nodeIds.length < 2) continue;

    const { baseHeight } = resolveBaseLayer(way);
    const entry = result.get(wayId);
    // Skip bridges already fully handled as ramps
    if (entry?.isRamp) continue;

    const startNode = nodeIds[0];
    const endNode = nodeIds[nodeIds.length - 1];

    if (!bridgeEndpoints.has(startNode)) bridgeEndpoints.set(startNode, []);
    bridgeEndpoints.get(startNode).push({ wayId, baseHeight, isStart: true, nodeCount: nodeIds.length });

    if (!bridgeEndpoints.has(endNode)) bridgeEndpoints.set(endNode, []);
    bridgeEndpoints.get(endNode).push({ wayId, baseHeight, isStart: false, nodeCount: nodeIds.length });
  }

  // Find nodes where bridges at different heights meet
  for (const [nodeId, endpoints] of bridgeEndpoints) {
    if (endpoints.length < 2) continue;

    // Find min and max height at this node
    let minH = Infinity, maxH = -Infinity;
    for (const ep of endpoints) {
      if (ep.baseHeight < minH) minH = ep.baseHeight;
      if (ep.baseHeight > maxH) maxH = ep.baseHeight;
    }
    if (minH === maxH) continue; // same height, no transition needed

    const targetH = (minH + maxH) / 2; // meet in the middle... no, meet at shared node
    // At the shared node, both bridges should be at the SAME height.
    // Lower bridge ramps UP to maxH, upper bridge stays at maxH (or vice versa).
    // Simpler: lower bridge ramps to maxH at the shared node.

    for (const ep of endpoints) {
      if (ep.baseHeight === maxH) continue; // upper bridge stays flat at its height
      // Lower bridge needs to ramp up to maxH at this endpoint

      const wayId = ep.wayId;
      const way = wayMap.get(wayId);
      const nodeIds = way.nodeIds || [];
      const n = nodeIds.length;
      const transitionPts = Math.min(TRANSITION_POINTS, Math.floor(n * 0.5));
      if (transitionPts < 1) continue;

      const entry = result.get(wayId);
      const baseH = ep.baseHeight;

      // Create or get vertexHeights array
      let vertexHeights;
      if (entry?.vertexHeights) {
        vertexHeights = [...entry.vertexHeights];
      } else {
        vertexHeights = new Array(n).fill(baseH);
      }

      // Ramp the endpoint side toward maxH
      if (ep.isStart) {
        // Transition first N points: index 0 = maxH (shared node), ramping back to baseH
        for (let i = 0; i < transitionPts; i++) {
          const t = 1 - (i / transitionPts); // 1.0 at shared node, 0.0 at transition end
          vertexHeights[i] = baseH + (maxH - baseH) * t * BLEND;
        }
      } else {
        // Transition last N points: last index = maxH (shared node), ramping from baseH
        for (let i = 0; i < transitionPts; i++) {
          const idx = n - 1 - i;
          const t = 1 - (i / transitionPts);
          vertexHeights[idx] = baseH + (maxH - baseH) * t * BLEND;
        }
      }

      result.set(wayId, { isRamp: true, vertexHeights });
    }
  }
}

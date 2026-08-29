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
 * N-46 · The height of a SURFACE road connected at this node, or null if none is.
 *
 * `getEndpointTargetHeight` answers "which connected way differs most in height from me", and the
 * tunnel branch then calls the result `startIsSurface` when it differs by more than 0.5 m. Those are
 * not the same question, and the name hides it: a tunnel at −6 connected to a DEEPER tunnel at −12
 * satisfies "differs by more than 0.5" perfectly well. Where a tunnel meets BOTH a surface road and
 * a deeper tunnel at one node — an interchange, which is exactly where portals live — the largest
 * difference can be the deeper tunnel. The portal then ramps the wrong way and the surface road is
 * left standing at ground level over a way that dived away from it.
 *
 * That is the step the user photographed and the continuity census counts: 462 drivable breaks,
 * 366 of them "surface meets TUNNEL", and of the worst 40 the tunnel side was ALREADY a ramp in 32.
 * The portal was not missing. It was aimed somewhere else.
 *
 * A portal exists where a tunnel meets the SURFACE network. So ask that directly.
 */
function getEndpointSurfaceHeight(nodeId, selfWayId, wayMap, nodeToWays) {
  const wayIds = nodeToWays.get(nodeId);
  if (!wayIds) return null;
  let best = null;
  for (const wid of wayIds) {
    if (wid === selfWayId) continue;
    const w = wayMap.get(wid);
    if (!w || w.tunnel) continue;                 // a tunnel is not the surface
    const { baseHeight } = resolveBaseLayer(w);
    // Prefer the SHALLOWEST surface connection: at a portal the tunnel must come up to meet the
    // street, and if several surface ways meet here the street is the highest of them.
    if (best === null || baseHeight > best) best = baseHeight;
  }
  return best;
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
  let rampReachClamped = 0; // N-41: ways whose climb no longer spans the whole street
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
      // N-46: ask for the SURFACE connection first. If a non-tunnel way meets this end, that is
      // where the portal belongs and its height is the target — full stop. Only when no surface way
      // is present does the old "largest height difference" question apply, which is the right
      // fallback for a tunnel meeting another tunnel at a different depth.
      const startSurf = getEndpointSurfaceHeight(nodeIds[0],     wayId, wayMap, nodeToWays);
      const endSurf   = getEndpointSurfaceHeight(nodeIds[n - 1], wayId, wayMap, nodeToWays);
      const startTarget = startSurf !== null ? startSurf
        : getEndpointTargetHeight(nodeIds[0],     wayId, baseHeight, wayMap, nodeToWays, false);
      const endTarget   = endSurf !== null ? endSurf
        : getEndpointTargetHeight(nodeIds[n - 1], wayId, baseHeight, wayMap, nodeToWays, false);
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
          // Carry the GRADE, not just "is it flat". The profile above is monotonic and matches both
          // endpoints, so this connector is valid geometry — the only question is whether it is too
          // steep to keep, and that is a number, not a boolean. Without it the consumer can only ask
          // "do the ends differ", which deletes a drivable 16% ramp and a vertical crack alike.
          const gradePct = L > 0 ? +(100 * Math.abs(endTarget - startTarget) / L).toFixed(1) : Infinity;
          result.set(wayId, { isRamp: true, vertexHeights, flattenedShortTunnel: true, flat, gradePct });
          flattenedShortTunnels.push({ wayId, lengthM: Math.round(L), startH: +startTarget.toFixed(2), endH: +endTarget.toFixed(2), flat, gradePct });
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

      // ── Case [B]: exactly one surface endpoint — THE PORTAL. ────────────────────────────────
      //
      // N-45. This interpolated by INDEX FRACTION (`i / (n - 1)`), which is the same defect N-41
      // fixed on the non-tunnel path and which was never applied here — and here it does more
      // damage, because this is the case that builds tunnel MOUTHS. 247 ways take it.
      //
      // With unevenly spaced nodes, index fraction puts a large share of the descent between two
      // nodes that happen to be metres apart, so the LOCAL grade spikes. `isBrokenRampRoad` then
      // measures exactly that local grade, finds it over 60%, and DELETES the way — 205 dropped
      // last bake. A deleted portal is the user's report: the surface road stops, the tunnel sits
      // buried directly beneath it, and there is nothing joining them.
      //
      // Distance-based, and the descent takes the length the grade needs (capped by the way), so
      // the profile the backstop measures is the one the grade promised. LAYER_STEP is untouched —
      // depth is still layer-derived, which the LOCKED vertical-model spec lists as correct.
      const startH = startIsSurface ? startTarget : baseHeight;
      const endH   = endIsSurface   ? endTarget   : baseHeight;
      const startIsGround = Math.abs(startH) < Math.abs(endH);
      const groundH = startIsGround ? startH : endH;
      const deepH = startIsGround ? endH : startH;
      const bPts = way.points || [];
      const bDist = (bPts.length === n && n >= 2) ? cumulativeGroundDist(bPts) : null;
      const bLen = bDist ? bDist[n - 1] : 0;
      // A portal needs this much road to descend at the construction grade. If the way is shorter,
      // the whole way ramps and the grade is as gentle as the length allows — still far under the
      // backstop, where index fraction was landing at 600%.
      const bReach = (bDist && bLen > 0)
        ? Math.min(bLen, Math.abs(deepH - groundH) / CONSTRUCT_RAMP_GRADE) : 0;
      const vertexHeights = nodeIds.map((_, i) => {
        let t;
        if (bReach > 0) {
          // ⚠ MEASURED FROM THE GROUND END, and the direction is the whole point. N-41 shapes a
          // BRIDGE APPROACH: flat at grade, climbing only near the elevated end, because the street
          // is genuinely at grade for most of its length. A PORTAL is the mirror image — the road
          // leaves the surface AT THE MOUTH and the tunnel interior is deep. Copying N-41's shape
          // here kept the tunnel at surface level for most of its length, so `buildTrenchCorridors`
          // (which only emits a corridor where the profile is below −MIN_CUT) carved nothing under
          // the flat stretch, and the commit-blocking floor validator caught it: 56 violations on 3
          // roads. Descend at the mouth, then run flat at depth.
          const dFromGround = startIsGround ? bDist[i] : (bLen - bDist[i]);
          t = Math.max(0, Math.min(1, dFromGround / bReach));
        } else {
          const rawT = n <= 1 ? 0 : i / (n - 1);
          const fwd = startIsGround ? rawT : 1 - rawT;
          t = fwd <= FLAT_FRACTION ? 0 : (fwd - FLAT_FRACTION) / (1 - FLAT_FRACTION);
        }
        const s = t * t * (3 - 2 * t);
        return groundH + s * (deepH - groundH);
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

    // ── N-41 · THE CLIMB IS A LOCAL FEATURE, NOT A PROPERTY OF THE WHOLE STREET ───────────────
    //
    // This used to interpolate startH → endH across the ENTIRE way by index fraction. So an
    // ordinary at-grade street that merely TOUCHES a flyover at one end was lifted along its whole
    // length — halfway down the street it sat half the layer step in the air. Measured over the
    // baked region: of surface roads (layer 0, no bridge, no tunnel), `isRamp` ones float > 2 m
    // above their own terrain **27.5% of the time (84/306, worst 14.12 m)** against 4.4% for
    // everything else. Being handed a ramp profile made a street SIX TIMES more likely to float.
    //
    // A bridge approach is a local thing: it climbs over the distance the grade needs and the rest
    // of the street stays on the ground. So the climb now happens over REACH metres adjacent to the
    // elevated end, measured in real metres, with the remainder flat at the ground height.
    //
    // Still DEM-free (the header's promise, and decisions.md §183 depends on it): this asks the
    // GRADE how long a ramp must be, never the terrain how high the ground is.
    const startIsGround = Math.abs(startH) < Math.abs(endH);
    const groundH = startIsGround ? startH : endH;
    const topH = startIsGround ? endH : startH;
    const pts = way.points || [];
    const dist = (pts.length === n && n >= 2) ? cumulativeGroundDist(pts) : null;
    const L = dist ? dist[n - 1] : 0;
    // How much road a rise of this size actually needs at the construction grade. A 6 m layer step
    // wants 50 m of ramp; anything beyond that is a street being lifted, not a ramp climbing.
    const needed = Math.abs(topH - groundH) / CONSTRUCT_RAMP_GRADE;
    const reach = (dist && L > 0) ? Math.min(L, needed) : 0;
    if (reach > 0 && reach < L) rampReachClamped++;

    const vertexHeights = nodeIds.map((_, i) => {
      let t;
      if (reach > 0) {
        // Distance from THIS point to the elevated end, in metres.
        const dFromTop = startIsGround ? (L - dist[i]) : dist[i];
        t = Math.max(0, Math.min(1, 1 - dFromTop / reach));
      } else {
        // No usable geometry — fall back to the original index-fraction ramp with its flat buffer,
        // so a way with missing points behaves exactly as it did before rather than unpredictably.
        const rawT = n <= 1 ? 0 : i / (n - 1);
        const fwd = startIsGround ? rawT : 1 - rawT;
        t = fwd <= FLAT_FRACTION ? 0 : (fwd - FLAT_FRACTION) / (1 - FLAT_FRACTION);
      }
      const s = t * t * (3 - 2 * t);   // smoothstep: no kink where the climb starts
      return groundH + s * (topH - groundH);
    });

    result.set(wayId, { isRamp: true, vertexHeights });
  }

  if (rampReachClamped > 0) {
    console.log(`  [N-41] ramp climb limited to the grade's reach on ${rampReachClamped} ways `
      + `(was spread over the whole street)`);
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

  // Expose the Case-C flattened list for the P-R1 defect census. `brokenRamp` — and therefore the
  // deletion of 332 road segments — is derived from exactly these entries, so the census has to be
  // able to state their GRADE. Attached to the Map rather than changing the return shape, which
  // several callers destructure.
  result.flattenedShortTunnels = flattenedShortTunnels;
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

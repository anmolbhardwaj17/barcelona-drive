/**
 * ElevationProcessor: smooth DEM noise along roads and apply bridge/tunnel ramp transitions.
 * - Smoothing: moving average over a short window to reduce DEM noise along the centerline.
 * - Bridges: at entry/exit, interpolate from terrain height to elevated height over rampDistance
 *   (smoothstep) so there are no abrupt vertical steps.
 * - Tunnels: smooth descent ramp into tunnel, constant section, smooth ascent ramp out.
 *
 * Geometry: ramp uses smoothstep(t) = t*t*(3-2*t) for t in [0,1] so slope is zero at both ends.
 * Layer: only road centerline y is modified; TerrainModifier handles layer (no flatten under bridge).
 */

/**
 * Smoothstep for t in [0,1]: zero derivative at 0 and 1.
 */
function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Precompute cumulative distance from start for each point (meters in x,z plane).
 */
function cumulativeDistances(points) {
  const d = [0];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    d[i] = d[i - 1] + Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  }
  return d;
}

/**
 * Apply bridge ramp: blend from terrain to elevated over rampDistance at start and end.
 * Points: [x, yUp, z, terrainHeight]. We set yUp using smoothstep blend so slope is zero at ramp ends.
 * effectiveLayer (bridge => at least 1) sets elevated offset = layer * bridgeHeightPerLayer.
 */
function applyBridgeRamp(points, rampDistance, bridgeHeightPerLayer, layer) {
  if (points.length < 2 || rampDistance <= 0) return points;
  const dist = cumulativeDistances(points);
  const totalLen = dist[dist.length - 1];
  const elevatedOffset = layer * bridgeHeightPerLayer;
  const out = points.map((p) => p.slice());

  for (let i = 0; i < points.length; i++) {
    const terrainY = points[i][3] != null && Number.isFinite(points[i][3]) ? points[i][3] : points[i][1];
    const dStart = dist[i];
    const dEnd = totalLen - dStart;

    let blend = 1;
    if (dStart < rampDistance && rampDistance > 0) {
      blend = smoothstep(dStart / rampDistance);
    } else if (dEnd < rampDistance && rampDistance > 0) {
      blend = smoothstep(dEnd / rampDistance);
    }
    out[i][1] = terrainY + blend * elevatedOffset;
  }
  return out;
}

/**
 * Apply tunnel ramp: smooth descent over first rampDistance, constant (terrain - depth),
 * smooth ascent over last rampDistance. smoothstep gives zero slope at surface/tunnel interface.
 */
function applyTunnelRamp(points, rampDistance, tunnelDepth) {
  if (points.length < 2 || rampDistance <= 0) return points;
  const dist = cumulativeDistances(points);
  const totalLen = dist[dist.length - 1];
  const out = points.map((p) => p.slice());

  for (let i = 0; i < points.length; i++) {
    const terrainY = points[i][3] != null && Number.isFinite(points[i][3]) ? points[i][3] : points[i][1];
    const dStart = dist[i];
    const dEnd = totalLen - dStart;

    let t = 1;
    if (dStart < rampDistance && rampDistance > 0) {
      t = smoothstep(dStart / rampDistance);
    } else if (dEnd < rampDistance && rampDistance > 0) {
      t = smoothstep(dEnd / rampDistance);
    }
    out[i][1] = terrainY - t * tunnelDepth;
  }
  return out;
}

/**
 * Process elevation for one road: bridge or tunnel ramps.
 * Config: bridgeRampDistance, tunnelRampDistance, bridgeHeightPerLayer, tunnelDepth.
 * (Per-road elevation smoothing removed in Phase 2 — DEM noise is handled at source by
 * demLoader's global smoothing passes; the per-road smoother was never enabled.)
 */
export function processRoadElevation(road, config) {
  const bridgeRampDistance = config.bridgeRampDistance ?? 15;
  const tunnelRampDistance = config.tunnelRampDistance ?? 20;
  const bridgeHeightPerLayer = config.bridgeHeightPerLayer ?? 6;
  const tunnelDepth = config.tunnelDepth ?? 5;

  let points = road.points;
  if (!points || points.length < 2) return road;

  if (road.bridge) {
    const effectiveLayer = Math.max(1, road.layer ?? 0);
    points = applyBridgeRamp(points, bridgeRampDistance, bridgeHeightPerLayer, effectiveLayer);
  } else if (road.tunnel) {
    points = applyTunnelRamp(points, tunnelRampDistance, tunnelDepth);
  }

  return { ...road, points };
}

/**
 * Process elevation for all roads.
 */
export function processElevation(roads, config) {
  return roads.map((road) => processRoadElevation(road, config));
}

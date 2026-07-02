/**
 * Phase 3 slice ③ — commit-blocking floor validator.
 *
 * THE INVARIANT (authored-tunnels-design.md §3): drivable-surface-implies-floor.
 * Every drivable tunnel road, sampled every 2 m of arc, must have a floor beneath its
 * surface within FLOOR_TOLERANCE — i.e. the carved trench grid at the sample sits at
 * roadY − FLOOR_BELOW_ROAD (±tol). A miss means a drivable surface with nothing under it
 * (the original fall-through bug). ANY violation FAILS the bake (throw / non-zero exit),
 * so a bad trench carve can never silently ship — the keystone that locks in slice ②.
 *
 * Forward check only (the keystone). The inverse check (surface roads floating over a
 * trench footprint) is a recorded follow-up; the 2 known native-dip roads (23792470,
 * 34099200) are pre-existing and out of this check's scope.
 *
 * Tolerance 0.3 m is LOCKED (design §5: 6× headroom over the measured 0.05 m baseline).
 * Same grid/world frame as carveTrenchesIntoGrid — raw DEM metres, no offset/vertExag.
 */

const FLOOR_BELOW_ROAD = 0.15; // MUST match trenchAuthor.FLOOR_BELOW_ROAD
const FLOOR_TOLERANCE = 0.30;  // LOCKED — commit-blocking gap tolerance (m)
const SAMPLE_SPACING = 2;      // m of true arc length between samples
const R_EARTH = 6378137;
const K_UNSTRETCH = Math.cos((41.350 * Math.PI) / 180); // matches trenchAuthor

// Same drivable whitelist + below-grade scope as buildTrenchCorridors (only those roads are carved).
const DRIVABLE_TUNNEL_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
]);

const mercToLatLon = (mx, mz) => ({
  lon: (mx / R_EARTH) * (180 / Math.PI),
  lat: (2 * Math.atan(Math.exp(mz / R_EARTH)) - Math.PI / 2) * (180 / Math.PI),
});

/**
 * Floor height at lat/lon = the MINIMUM of the carved grid cells around the sample (the lowest
 * adjacent floor), NOT a bilinear average. The invariant is "is a carved floor cell present under
 * the road?" — if ANY adjacent cell is cut to the trench floor, the floor exists there. Bilinear
 * averaging instead reads HIGH wherever the road runs near the trench EDGE (one cell cut, the next
 * an uncut batter cell), producing false "no-floor" flags on perfectly-floored centerlines.
 */
function gridFloorAt(data, grid, south, west, north, east, lat, lon) {
  const rf = Math.max(0, Math.min(grid - 1, ((lat - south) / (north - south)) * (grid - 1)));
  const cf = Math.max(0, Math.min(grid - 1, ((lon - west) / (east - west)) * (grid - 1)));
  const r0 = Math.floor(rf), c0 = Math.floor(cf);
  const r1 = Math.min(grid - 1, r0 + 1), c1 = Math.min(grid - 1, c0 + 1);
  let min = Infinity;
  for (const r of [r0, r1]) for (const c of [c0, c1]) {
    const v = data[r * grid + c];
    if (Number.isFinite(v) && v < min) min = v;
  }
  return Number.isFinite(min) ? min : NaN;
}

/**
 * Collect floor violations for one tile's drivable tunnel roads (call after the trench carve,
 * with the DRAPED roads — points are [mercX, yUp, mercZ, absRoadY]).
 * @returns {Array<{tileId,roadId,roadY,gridY,expectedFloor,gap}>}
 */
export function collectTunnelFloorViolations(tileId, tileRoads, data, bounds, grid) {
  const { south, west, north, east } = bounds;
  const out = [];
  for (const road of tileRoads || []) {
    if (!road.tunnel || !DRIVABLE_TUNNEL_TYPES.has(road.highwayType)) continue;
    // v1 scope (design §5): the reachable shallow trenches (layer −1/−2). Deep tunnels (≤ −3) are
    // sealed under terrain / not drivable-reachable and are a recorded deferred follow-up — excluded
    // so the bake isn't blocked by known-out-of-scope cases (design §5: "whitelist excludes them").
    if (!(road.layer != null && road.layer < 0 && road.layer >= -2)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const yOf = (p) => (p.length >= 4 && Number.isFinite(p[3]) ? p[3] : p[1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[2] - a[2]) * K_UNSTRETCH;
      const n = Math.max(1, Math.round(segLen / SAMPLE_SPACING));
      const yA = yOf(a), yB = yOf(b);
      for (let s = 0; s <= n; s++) {
        const f = s / n;
        const mx = a[0] + f * (b[0] - a[0]);
        const mz = a[2] + f * (b[2] - a[2]);
        const roadY = yA + f * (yB - yA);
        if (!Number.isFinite(roadY)) continue;
        const ll = mercToLatLon(mx, mz);
        // Only validate samples whose floor lives in THIS tile's grid (others are validated by their tile).
        if (ll.lat < south || ll.lat > north || ll.lon < west || ll.lon > east) continue;
        const gy = gridFloorAt(data, grid, south, west, north, east, ll.lat, ll.lon);
        if (!Number.isFinite(gy)) {
          out.push({ tileId, roadId: road.id, roadY, gridY: NaN, expectedFloor: roadY - FLOOR_BELOW_ROAD, gap: Infinity });
          continue;
        }
        const expectedFloor = roadY - FLOOR_BELOW_ROAD;
        // ASYMMETRIC: the invariant is drivable-surface-implies-floor — the floor must be UNDER the
        // road surface. A grid BELOW expectedFloor is still a floor (carved deeper, e.g. where a
        // deeper overlapping corridor cuts the shared cells — safe). The violation is the grid TOO
        // HIGH: terrain rising into/above the roadway (no floor under the drivable surface). So flag
        // only gridY > expectedFloor + tol (≈ gridY above roadY).
        const gap = gy - expectedFloor;
        if (gap > FLOOR_TOLERANCE) out.push({ tileId, roadId: road.id, layer: road.layer, hwy: road.highwayType, roadY, gridY: gy, expectedFloor, gap });
      }
    }
  }
  return out;
}

/**
 * Region-wide report. In blocking mode, throws on any violation (non-zero exit).
 * @param {Array} violations  accumulated from collectTunnelFloorViolations
 * @param {{blocking:boolean, whitelist?:Set<number>}} opts
 */
export function reportTunnelFloorValidation(violations, { blocking = true, whitelist } = {}) {
  const filtered = whitelist ? violations.filter((v) => !whitelist.has(v.roadId)) : violations;
  if (filtered.length === 0) {
    console.log(`[FloorValidator] ✅ drivable-surface-implies-floor: 0 violations (tol ${FLOOR_TOLERANCE} m).`);
    return;
  }
  const byRoad = new Map();
  const byLayer = new Map();
  let worst = 0;
  for (const v of filtered) {
    byRoad.set(v.roadId, (byRoad.get(v.roadId) || 0) + 1);
    byLayer.set(v.layer, (byLayer.get(v.layer) || 0) + 1);
    if (v.gap > worst) worst = v.gap;
  }
  console.error(`[FloorValidator] ❌ ${filtered.length} floor violations on ${byRoad.size} drivable tunnel roads (worst gap ${worst === Infinity ? 'NaN-floor' : worst.toFixed(2) + ' m'}, tol ${FLOOR_TOLERANCE} m).`);
  console.error(`   by layer: ${[...byLayer.entries()].sort((a,b)=>a[0]-b[0]).map(([l,n]) => `L${l}:${n}`).join('  ')}`);
  for (const v of filtered.slice(0, 25)) {
    console.error(`   tile ${v.tileId} road ${v.roadId}: gridY ${Number.isFinite(v.gridY) ? v.gridY.toFixed(2) : 'NaN'} vs expectedFloor ${v.expectedFloor.toFixed(2)} → gap ${v.gap === Infinity ? '∞' : v.gap.toFixed(2)} m`);
  }
  if (filtered.length > 25) console.error(`   …and ${filtered.length - 25} more.`);
  // Compact distinct-road dump (every flagged road + its worst gap) — drives the drop/whitelist list.
  const worstByRoad = new Map();
  for (const v of filtered) worstByRoad.set(v.roadId, Math.max(worstByRoad.get(v.roadId) || 0, v.gap));
  console.error(`   DISTINCT_FLOOR_GAP_ROADS: ${[...worstByRoad.entries()].map(([id, g]) => `${id}(${g === Infinity ? '∞' : g.toFixed(1)}m)`).join(', ')}`);
  if (blocking) {
    throw new Error(`[FloorValidator] drivable-surface-implies-floor FAILED: ${filtered.length} violations. Bake aborted (commit-blocking, slice ③). Set TRENCH_VALIDATOR=report to bypass during diagnosis.`);
  }
  console.error(`[FloorValidator] (report mode — not blocking; set TRENCH_VALIDATOR=block to enforce.)`);
}

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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// R-P1 · THE SAME INVARIANT FOR SURFACE ROADS — and it points the OTHER WAY
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// "A drivable surface implies a floor, wherever it is." The tunnel check above is one half of it.
// The other half cannot be had by widening that whitelist, because the failure is mirrored:
//
//   TUNNEL   the carved floor must be UNDER the road, so the violation is the grid too HIGH —
//            terrain rising into the roadway. `gap = gridY - expectedFloor`.
//
//   SURFACE  the terrain IS the floor, and it is what the wheels rest on (the physics heightfield
//            is built from this same grid). The violation is the grid too LOW — the visual asphalt
//            hanging in the air with the collider metres beneath it. `drop = roadY - gridY`.
//            **That is the user's "there are roads in some places from where I fall":** the car is
//            on the collider the whole time; it is the road that is not where it looks.
//
// Widening the tunnel scope without flipping the sign would have flagged BURIED roads — a cosmetic
// problem you drive over — and missed every floating one, which is the problem you fall through.
//
// ELEVATED ROADS ARE EXCLUDED, and that is not a loophole. A bridge, a ramp, an `layer > 0` deck and
// an Option-L trench crossing are all SUPPOSED to sit above the terrain; each gets its own deck
// collider in tileManager. The gate is the same four booleans the guard-rail and street-parking
// gates lead with, deliberately — three systems, one definition of "this road carries its own
// surface", so they cannot drift apart.
//
// REPORTING, NOT BLOCKING. `barcelona-road-system.md` R-P1 is explicit: land it in report mode and
// read the count first, because P-R1b already measured 4.9% of drivable road points above the
// shipped terrain and a commit-blocking assert over that would fail every bake forever.

/** Buckets, in metres of drop, so the report says whether this is a handful of spots or systemic. */
export const SURFACE_DROP_BUCKETS = [0.5, 1.0, 2.0, 5.0, 10.0];

/** A road that carries its own deck is meant to be above the terrain. Same booleans as R-B1 / R-V1. */
function carriesOwnDeck(road) {
  return road.bridge === true
    || road.isRamp === true
    || (road.layer != null && road.layer > 0)
    || road.crossesTrench === true;
}

/**
 * Drop between a surface road and the terrain the wheels actually rest on, sampled every 2 m.
 *
 * @returns {Array<{tileId,roadId,hwy,roadY,gridY,drop}>} one entry per sample over the smallest bucket
 */
export function collectSurfaceFloorViolations(tileId, tileRoads, data, bounds, grid, stats = null) {
  const { south, west, north, east } = bounds;
  const minDrop = Number(process.env.RP1_MIN_DROP) > 0 ? Number(process.env.RP1_MIN_DROP) : SURFACE_DROP_BUCKETS[0];
  const out = [];
  for (const road of tileRoads || []) {
    if (!DRIVABLE_TUNNEL_TYPES.has(road.highwayType)) continue;
    if (road.tunnel) continue;              // the other half of the invariant covers these
    if (carriesOwnDeck(road)) continue;     // has its own collider, see the note above
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
        if (ll.lat < south || ll.lat > north || ll.lon < west || ll.lon > east) continue;
        // MAX of the adjacent cells, the mirror of gridFloorAt's MIN: for "is there ground under
        // this point", the highest nearby cell is the most generous reading, so a road flagged here
        // is floating above EVERY cell around it — not just above the lowest one.
        const gy = gridCeilAt(data, grid, south, west, north, east, ll.lat, ll.lon);
        if (!Number.isFinite(gy)) continue;
        const drop = roadY - gy;
        // PROOF OF WORK (D-23). A brand-new check reporting "0 violations" is indistinguishable from
        // a check that sampled nothing — the light-grid A/B already reported a false PASS this way.
        // So the collector counts what it looked at and the extremes it saw, and the report prints
        // them even on success. A green line with 0 samples is a broken check, not a clean city.
        if (stats) {
          stats.samples++;
          if (drop > stats.maxDrop) stats.maxDrop = drop;
          if (drop < stats.minDrop) stats.minDrop = drop;
        }
        if (drop > minDrop) out.push({ tileId, roadId: road.id, hwy: road.highwayType, roadY, gridY: gy, drop });
      }
    }
  }
  return out;
}

/** MAX of the four adjacent grid cells — the most generous "is there ground here" reading. */
function gridCeilAt(data, grid, south, west, north, east, lat, lon) {
  const rf = Math.max(0, Math.min(grid - 1, ((lat - south) / (north - south)) * (grid - 1)));
  const cf = Math.max(0, Math.min(grid - 1, ((lon - west) / (east - west)) * (grid - 1)));
  const r0 = Math.floor(rf), c0 = Math.floor(cf);
  const r1 = Math.min(grid - 1, r0 + 1), c1 = Math.min(grid - 1, c0 + 1);
  let max = -Infinity;
  for (const r of [r0, r1]) for (const c of [c0, c1]) {
    const v = data[r * grid + c];
    if (Number.isFinite(v) && v > max) max = v;
  }
  return Number.isFinite(max) ? max : NaN;
}

/**
 * R-P1 census. NEVER blocking — see the note above; this is a measurement, and the count decides
 * whether repair logic is worth writing at all (the same P-R1 gate that closed M1).
 */
export function reportSurfaceFloorValidation(violations, { stats = null } = {}) {
  const sampleCount = stats?.samples ?? 0;
  const workLine = stats
    ? `   ${sampleCount.toLocaleString()} samples taken · drop range `
      + `${Number.isFinite(stats.minDrop) ? stats.minDrop.toFixed(2) : 'n/a'} … `
      + `${Number.isFinite(stats.maxDrop) ? stats.maxDrop.toFixed(2) : 'n/a'} m`
    : '   ⚠ no stats collected — this report cannot tell you whether it measured anything';
  if (!violations.length) {
    if (!sampleCount) {
      console.error('[FloorValidator/surface] ⚠ R-P1 VOID — 0 samples taken. This is NOT "no '
        + 'violations"; it means the check looked at nothing. Fix it before trusting a green line.');
      return;
    }
    console.log('[FloorValidator/surface] ✅ R-P1: no drivable surface road sits more than '
      + `${SURFACE_DROP_BUCKETS[0]} m above the terrain under it.`);
    console.log(workLine);
    return;
  }
  const byBucket = new Map(SURFACE_DROP_BUCKETS.map((b) => [b, 0]));
  const roadsByBucket = new Map(SURFACE_DROP_BUCKETS.map((b) => [b, new Set()]));
  const worstByRoad = new Map();
  let worst = 0, worstRoad = null;
  for (const v of violations) {
    for (const b of SURFACE_DROP_BUCKETS) {
      if (v.drop > b) { byBucket.set(b, byBucket.get(b) + 1); roadsByBucket.get(b).add(v.roadId); }
    }
    if (v.drop > (worstByRoad.get(v.roadId) || 0)) worstByRoad.set(v.roadId, v.drop);
    if (v.drop > worst) { worst = v.drop; worstRoad = v; }
  }
  console.log('');
  console.log('[FloorValidator/surface] R-P1 — drivable SURFACE roads above the terrain they rest on');
  console.log(workLine);
  for (const b of SURFACE_DROP_BUCKETS) {
    const n = byBucket.get(b);
    const pct = sampleCount ? ` (${((n / sampleCount) * 100).toFixed(2)}% of samples)` : '';
    console.log(`   drop > ${String(b).padStart(4)} m : ${String(n).padStart(7)} samples on ${String(roadsByBucket.get(b).size).padStart(5)} roads${pct}`);
  }
  if (worstRoad) {
    console.log(`   worst: road ${worstRoad.roadId} (${worstRoad.hwy}) — road ${worstRoad.roadY.toFixed(1)} m vs terrain ${worstRoad.gridY.toFixed(1)} m = ${worst.toFixed(1)} m`);
  }
  const top = [...worstByRoad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`   worst roads: ${top.map(([id, d]) => `${id}(${d.toFixed(1)}m)`).join(', ')}`);
  console.log('   (REPORT ONLY — R-P1 says read the count before writing any repair.)');
}

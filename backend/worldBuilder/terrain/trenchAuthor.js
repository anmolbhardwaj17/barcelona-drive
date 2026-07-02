/**
 * Phase 3 slice ② — authored open-cut trenches, carved INTO the elevation grid.
 *
 * Design: docs/context/authored-tunnels-design.md §1/§2/§4 (OPTION L).
 * Drivable tunnel corridors are carved into the elevation grid as continuous open cuts,
 * END-TO-END — every consumer (terrain visual, physics heightfield, runtime
 * getElevationAt, baked terrain mesh) inherits the trench with zero extra plumbing.
 * Streets crossing above a corridor are flagged `crossesTrench` and ride deck colliders
 * (the existing structural-flags bridge mechanism); Phase 4 adds a physics-free visual
 * roof for covered sections.
 *
 * Corridors are built ONCE from the GLOBAL road list (pre-drape layer profiles + the
 * same DEM sampler the grid uses), then every tile carves against the same geometry —
 * cross-tile seams agree by construction (same argument as the global DEM pre-smooth).
 */

const R_EARTH = 6378137;
const K_UNSTRETCH = Math.cos((41.350 * Math.PI) / 180); // matches frontend MERCATOR_UNSTRETCH

const MIN_CUT = 0.05;         // m — profile shallower than this = at-grade, no cut (don't scrape the street)
const TRENCH_MARGIN = 4.0;    // m — corridor halfW = roadWidth/2 + this. MUST exceed the ~3.6 m grid cell so a full cell row beyond the road edge is cut — at 1.5 m, diagonal corridors alternated cut/uncut cells and wall wedges sliced INTO the roadway (car-blocking sawtooth)
const BATTER_WIDTH = 14.0;    // m — sloped-wall band BEYOND halfW. Cells in (halfW, halfW+BATTER) ease
                              // from floor up to natural terrain. WIDENED 8→14 + SMOOTHSTEP easing
                              // (slice ④ "real polish" pass): a wide S-curve graded slope (~4 grid cells,
                              // like a real highway cutting) instead of the 2-cell near-vertical band that
                              // staircased into the faceted sawtooth. The smoothstep has zero derivative at
                              // both ends, so it joins the floor AND the natural terrain seamlessly — no
                              // hard cut/uncut boundary to alias. Min-only: the batter only ever cuts DOWN
                              // and eases to 0 cut at the outer edge, so it can't raise terrain or gouge a
                              // step into adjacent ground. The floater/crossing pads track BATTER_WIDTH.
const smoothstep = (t) => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };
const FLOOR_BELOW_ROAD = 0.15;// m — trench floor below road surface (deck slab sits proud)
// OPTION L (approved): NO roof exception — the corridor is carved open END-TO-END,
// covered sections included. Rationale (the geometric impossibility finding): a heightfield
// is a single-valued surface y(x,z) — it cannot have an opening in its own cliff face, so a
// car can NEVER drive under it; any roof chain ends in a terrain wall across the roadway.
// Physics is daylighted; the visual roof returns in Phase 4 as a physics-free enclosure
// mesh. Streets crossing above a corridor are flagged `crossesTrench` (flagTrenchCrossings)
// and ride deck colliders — the existing structural-flags bridge mechanism.
const CROSSING_MIN_RISE = 2.0; // m — a road this far above the corridor road at a crossing is a crossing street (not the at-grade ramp connection)
const CROSSING_FLAG_PAD = BATTER_WIDTH + 1.8; // m — the flag test reaches this far beyond corridor halfW: the carve now cuts a sloped wall out to halfW + BATTER_WIDTH (plus ~1.8 m cell extent / bilinear smear), so roads over the trench SKIRT/batter also need decks

const DRIVABLE_TUNNEL_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
]);

const mercToLatLon = (mx, mz) => ({
  lon: (mx / R_EARTH) * (180 / Math.PI),
  lat: (2 * Math.atan(Math.exp(mz / R_EARTH)) - Math.PI / 2) * (180 / Math.PI),
});
const latLonToMerc = (lat, lon) => ({
  x: (lon * Math.PI / 180) * R_EARTH,
  z: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R_EARTH,
});

/**
 * Build the global trench-corridor segment list. Call ONCE, after ramp resolution and
 * DEM load, BEFORE the per-tile loop (road points still hold the pre-drape layer profile).
 * @param {Array} allRoads - global simplified roads (points = [mercX, yUp, mercZ, profile?])
 * @param {{sampleElevation: (lat,lon)=>number|null}} demSampler
 * @returns {Array<{ax,az,bx,bz,minX,maxX,minZ,maxZ,eA,eB,halfW}>} merc-space segments; eA/eB = ABSOLUTE road Y
 */
export function buildTrenchCorridors(allRoads, demSampler) {
  const corridors = [];
  let roadsTouched = 0;
  for (const road of allRoads) {
    if (!road.tunnel || !road.points || road.points.length < 2) continue;
    if (!DRIVABLE_TUNNEL_TYPES.has(road.highwayType)) continue;
    if (!(road.layer != null && road.layer < 0)) continue; // layer-0 tunnel oddities out of scope (design §5)

    const halfW = ((Number.isFinite(road.width) && road.width > 0 ? road.width : 4) / 2) + TRENCH_MARGIN;
    const pts = road.points;
    // absolute Y + profile per point (profile = p[3] if present, else p[1]; both pre-drape layer-relative)
    const abs = new Array(pts.length);
    const prof = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      prof[i] = p.length >= 4 && Number.isFinite(p[3]) ? p[3] : p[1];
      const ll = mercToLatLon(p[0], p[2]);
      const g = demSampler.sampleElevation(ll.lat, ll.lon);
      abs[i] = (g != null && Number.isFinite(g) ? g : 0) + (Number.isFinite(prof[i]) ? prof[i] : 0);
    }

    // Emit a corridor for every below-grade span of the road (profile < −MIN_CUT, lerped
    // crossings). The per-cell forbidden-band rule in carveTrenchesIntoGrid decides
    // trench-vs-roof from ACTUAL grid cover, so no covered/open classification here.
    let emitted = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const pA = prof[i], pB = prof[i + 1];
      const belowA = pA < -MIN_CUT, belowB = pB < -MIN_CUT;
      if (!belowA && !belowB) continue;
      const span = pB - pA;
      let t0 = 0, t1 = 1;
      if (!belowA && Math.abs(span) > 1e-9) t0 = Math.max(0, Math.min(1, (-MIN_CUT - pA) / span));
      if (!belowB && Math.abs(span) > 1e-9) t1 = Math.max(0, Math.min(1, (-MIN_CUT - pA) / span));
      if (t1 <= t0) continue;

      const ax = pts[i][0] + t0 * (pts[i + 1][0] - pts[i][0]);
      const az = pts[i][2] + t0 * (pts[i + 1][2] - pts[i][2]);
      const bx = pts[i][0] + t1 * (pts[i + 1][0] - pts[i][0]);
      const bz = pts[i][2] + t1 * (pts[i + 1][2] - pts[i][2]);
      const eA = abs[i] + t0 * (abs[i + 1] - abs[i]);
      const eB = abs[i] + t1 * (abs[i + 1] - abs[i]);
      const marginMerc = ((halfW + BATTER_WIDTH) / K_UNSTRETCH) + 4; // AABB prefilter pad — MUST reach halfW+BATTER (the carve cuts that far) or wide-batter cells fall outside the cell window
      corridors.push({
        ax, az, bx, bz, eA, eB, halfW,
        minX: Math.min(ax, bx) - marginMerc, maxX: Math.max(ax, bx) + marginMerc,
        minZ: Math.min(az, bz) - marginMerc, maxZ: Math.max(az, bz) + marginMerc,
      });
      emitted = true;
    }
    if (emitted) roadsTouched++;
  }
  console.log(`[Trench] authored corridors: ${corridors.length} segments from ${roadsTouched} drivable tunnel roads (MARGIN=${TRENCH_MARGIN} FLOOR_BELOW=${FLOOR_BELOW_ROAD} OPTION-L open end-to-end)`);
  return corridors;
}

/**
 * OPTION L companion: flag drivable NON-tunnel roads that cross ABOVE a trench corridor.
 * Flagged roads get deck colliders at runtime (the existing structural-flags bridge
 * mechanism) so the street over a daylighted tunnel stays drivable. Their VISUAL elevation
 * is already correct: road drape samples the DEM (not the trenched grid), so they float
 * across the cut like the bridges they structurally are.
 * Mutates road.crossesTrench on the GLOBAL list (deepCloneRoad copies it per tile).
 * @returns {number} count of flagged roads
 */
export function flagTrenchCrossings(allRoads, corridors, demSampler) {
  if (!corridors.length || !demSampler) return { flagged: 0, shoulders: [] };
  // spatial hash over true-metre corridor AABBs
  const CELL = 32;
  const index = new Map();
  const keyOf = (x, z) => `${Math.floor(x / CELL)}|${Math.floor(z / CELL)}`;
  for (const c of corridors) {
    const minX = c.minX * K_UNSTRETCH, maxX = c.maxX * K_UNSTRETCH;
    const minZ = c.minZ * K_UNSTRETCH, maxZ = c.maxZ * K_UNSTRETCH;
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const k = `${cx}|${cz}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      }
  }
  let flagged = 0;
  const shoulders = [];
  for (const road of allRoads) {
    if (road.tunnel || !road.points || road.points.length < 2) continue;
    if (!DRIVABLE_TUNNEL_TYPES.has(road.highwayType)) continue; // same drivable whitelist
    let hit = false;
    const nearSegs = new Set(); // segment indices anywhere near a corridor (for shoulder cuts)
    const absAt = new Map();    // cached endpoint absolute Y
    const pf = (p) => (p.length >= 4 && Number.isFinite(p[3]) ? p[3] : p[1]) || 0;
    const absOf = (i) => {
      if (absAt.has(i)) return absAt.get(i);
      const p = road.points[i];
      const ll = mercToLatLon(p[0], p[2]);
      const g = demSampler.sampleElevation(ll.lat, ll.lon);
      const v = (g != null && Number.isFinite(g) ? g : 0) + pf(p);
      absAt.set(i, v);
      return v;
    };
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[2] - a[2]) * K_UNSTRETCH;
      const n = Math.max(1, Math.round(segLen / 3));
      for (let s = 0; s <= n; s++) {
        const f = s / n;
        const mx = a[0] + f * (b[0] - a[0]), mz = a[2] + f * (b[2] - a[2]);
        const cands = index.get(keyOf(mx * K_UNSTRETCH, mz * K_UNSTRETCH));
        if (!cands) continue;
        const roadAbsY = absOf(i) + f * (absOf(i + 1) - absOf(i));
        for (const c of cands) {
          const dx = c.bx - c.ax, dz = c.bz - c.az;
          const len2 = dx * dx + dz * dz;
          if (len2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((mx - c.ax) * dx + (mz - c.az) * dz) / len2));
          const px = c.ax + t * dx, pz = c.az + t * dz;
          if (Math.hypot(mx - px, mz - pz) * K_UNSTRETCH > c.halfW + CROSSING_FLAG_PAD) continue;
          nearSegs.add(i); // near the trench zone — shoulder-cut this span regardless of rise
          const corridorRoadY = c.eA + t * (c.eB - c.eA);
          if (roadAbsY > corridorRoadY + CROSSING_MIN_RISE) hit = true;
          break;
        }
      }
    }
    if (hit) { road.crossesTrench = true; flagged++; }
    // SHOULDER CUTS: for near-trench spans of drivable surface roads, carve the grid to
    // the road's OWN level − 0.15 (min-only: deeper trench beneath bridges is untouched).
    // Un-buries roads the trench wall sliced through (half-covered-in-terrain artifact)
    // and pushes the sawtooth wall off road edges onto a bench beside them.
    if (nearSegs.size) {
      const shHalfW = ((Number.isFinite(road.width) && road.width > 0 ? road.width : 6) / 2) + 1.5;
      for (const i of nearSegs) {
        const a = road.points[i], b = road.points[i + 1];
        const eA = absOf(i), eB = absOf(i + 1);
        const marginMerc = (shHalfW / K_UNSTRETCH) + 8;
        shoulders.push({
          ax: a[0], az: a[2], bx: b[0], bz: b[2], eA, eB, halfW: shHalfW,
          minX: Math.min(a[0], b[0]) - marginMerc, maxX: Math.max(a[0], b[0]) + marginMerc,
          minZ: Math.min(a[2], b[2]) - marginMerc, maxZ: Math.max(a[2], b[2]) + marginMerc,
        });
      }
    }
  }
  console.log(`[Trench] crossesTrench flagged: ${flagged} drivable surface roads; shoulder-cut segments: ${shoulders.length}`);
  return { flagged, shoulders };
}

/**
 * Closure pass: flag any remaining drivable surface road that will FLOAT > CROSSING_MIN_RISE
 * over the FINAL carved surface (corridors + shoulder cuts). Catches the cascade the
 * primary flag pass can't see (shoulder benches extend beyond the corridor flag zone).
 * Closed-form: the carved surface is fully determined by `cutters` before the tile loop,
 * so one analytic pass suffices — no iteration.
 */
export function flagFloatersOverCarve(allRoads, cutters, demSampler) {
  if (!cutters.length || !demSampler) return 0;
  const CELL = 32;
  const index = new Map();
  const keyOf = (x, z) => `${Math.floor(x / CELL)}|${Math.floor(z / CELL)}`;
  for (const c of cutters) {
    const minX = c.minX * K_UNSTRETCH, maxX = c.maxX * K_UNSTRETCH;
    const minZ = c.minZ * K_UNSTRETCH, maxZ = c.maxZ * K_UNSTRETCH;
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const k = `${cx}|${cz}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      }
  }
  // pad: the carve now reaches halfW + BATTER_WIDTH (sloped wall). Mirror that reach here so a
  // road over the batter band is tested against the SAME eased surface the carve produces, plus
  // a bilinear-smear cell. Was 5.5 m (pre-batter cliff); must be ≥ BATTER_WIDTH now.
  const SKIRT = BATTER_WIDTH + 1.8;
  let flagged = 0;
  for (const road of allRoads) {
    if (road.tunnel || road.crossesTrench || !road.points || road.points.length < 2) continue;
    if (!DRIVABLE_TUNNEL_TYPES.has(road.highwayType)) continue;
    const pf = (p) => (p.length >= 4 && Number.isFinite(p[3]) ? p[3] : p[1]) || 0;
    let hit = false;
    for (let i = 0; i < road.points.length - 1 && !hit; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[2] - a[2]) * K_UNSTRETCH;
      const n = Math.max(1, Math.round(segLen / 3));
      for (let s = 0; s <= n && !hit; s++) {
        const f = s / n;
        const mx = a[0] + f * (b[0] - a[0]), mz = a[2] + f * (b[2] - a[2]);
        const cands = index.get(keyOf(mx * K_UNSTRETCH, mz * K_UNSTRETCH));
        if (!cands) continue;
        const ll = mercToLatLon(mx, mz);
        const g = demSampler.sampleElevation(ll.lat, ll.lon);
        const roadAbsY = (g != null && Number.isFinite(g) ? g : 0) + (pf(a) + f * (pf(b) - pf(a)));
        let carved = g != null && Number.isFinite(g) ? g : 0;
        for (const c of cands) {
          const dx = c.bx - c.ax, dz = c.bz - c.az;
          const len2 = dx * dx + dz * dz;
          if (len2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((mx - c.ax) * dx + (mz - c.az) * dz) / len2));
          const px = c.ax + t * dx, pz = c.az + t * dz;
          const dist = Math.hypot(mx - px, mz - pz) * K_UNSTRETCH;
          if (dist > c.halfW + SKIRT) continue;
          const floorY = c.eA + t * (c.eB - c.eA) - FLOOR_BELOW_ROAD;
          // mirror carveTrenchesIntoGrid's batter: full floor within halfW, SMOOTHSTEP-eased beyond it
          let target = floorY;
          if (dist > c.halfW) target = floorY + smoothstep((dist - c.halfW) / BATTER_WIDTH) * (carved - floorY);
          if (target < carved) carved = target;
        }
        if (roadAbsY - carved > CROSSING_MIN_RISE) hit = true;
      }
    }
    if (hit) { road.crossesTrench = true; flagged++; }
  }
  console.log(`[Trench] closure pass: ${flagged} additional roads flagged (floating over shoulder benches/skirts)`);
  return flagged;
}

/**
 * Carve the trench corridors into one tile's elevation grid. Mutates `data` (min-only:
 * never raises terrain). Run as the LAST grid mutation (after water sink + road drape).
 * @param {number[]} data - row-major TERRAIN_GRID×TERRAIN_GRID elevations (raw metres)
 * @param {{south,west,north,east,grid}} bounds - tile bbox + grid size
 * @param {Array} corridors - from buildTrenchCorridors
 * @param {Set<number>} [sunkCells] - water-sunk cell indices; trench skips them LOUDLY
 * @returns {{cellsCut:number, maxCut:number, waterConflicts:number}}
 */
export function carveTrenchesIntoGrid(data, bounds, corridors, sunkCells) {
  const { south, west, north, east, grid } = bounds;
  const sw = latLonToMerc(south, west);
  const ne = latLonToMerc(north, east);
  let cellsCut = 0, maxCut = 0, waterConflicts = 0;

  for (const c of corridors) {
    if (c.maxX < sw.x || c.minX > ne.x || c.maxZ < sw.z || c.minZ > ne.z) continue;
    // candidate cell window from the corridor's lat/lon AABB
    const llMin = mercToLatLon(c.minX, c.minZ);
    const llMax = mercToLatLon(c.maxX, c.maxZ);
    const r0 = Math.max(0, Math.floor(((llMin.lat - south) / (north - south)) * (grid - 1)));
    const r1 = Math.min(grid - 1, Math.ceil(((llMax.lat - south) / (north - south)) * (grid - 1)));
    const c0 = Math.max(0, Math.floor(((llMin.lon - west) / (east - west)) * (grid - 1)));
    const c1 = Math.min(grid - 1, Math.ceil(((llMax.lon - west) / (east - west)) * (grid - 1)));
    const dx = c.bx - c.ax, dz = c.bz - c.az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;

    for (let r = r0; r <= r1; r++) {
      const lat = south + (north - south) * (r / (grid - 1));
      for (let cc = c0; cc <= c1; cc++) {
        const lon = west + (east - west) * (cc / (grid - 1));
        const m = latLonToMerc(lat, lon);
        const t = Math.max(0, Math.min(1, ((m.x - c.ax) * dx + (m.z - c.az) * dz) / len2));
        const px = c.ax + t * dx, pz = c.az + t * dz;
        const distTrue = Math.hypot(m.x - px, m.z - pz) * K_UNSTRETCH;
        if (distTrue > c.halfW + BATTER_WIDTH) continue;
        const idx = r * grid + cc;
        if (sunkCells && sunkCells.has(idx)) { waterConflicts++; continue; }
        const floorY = c.eA + t * (c.eB - c.eA) - FLOOR_BELOW_ROAD;
        const cur = data[idx];
        if (!Number.isFinite(cur)) continue;
        // OPTION L: corridor open end-to-end — every corridor cell above the floor is cut
        // (no roof exception; see header). Within halfW → full floor; in the BATTER band
        // beyond it the target eases linearly from floor up to natural terrain, turning the
        // one-cell cliff into a sloped wall. min-only: never raise terrain.
        let targetY = floorY;
        if (distTrue > c.halfW) {
          const frac = (distTrue - c.halfW) / BATTER_WIDTH;  // 0 at halfW → 1 at outer edge
          targetY = floorY + smoothstep(frac) * (cur - floorY); // S-curve: smooth join to floor AND natural
        }
        if (cur > targetY) {
          data[idx] = targetY;
          cellsCut++;
          if (cur - targetY > maxCut) maxCut = cur - targetY;
        }
      }
    }
  }
  if (waterConflicts > 0) {
    console.error(`[Trench] LOUD WARNING: ${waterConflicts} trench cells overlap water-sunk cells — skipped (tunnels under water are out of scope v1; slice ③ validator makes this fail the bake)`);
  }
  return { cellsCut, maxCut, waterConflicts };
}

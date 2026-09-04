/**
 * coastline.js — the ONE shared Mediterranean coastline for Barcelona.
 *
 * Why this exists: the baked data has no open-sea signal at all. There are no OSM water polygons
 * for the sea (only enclosed basins), and the DEM is unusable — Copernicus GLO-30 is a surface
 * model that bakes the sea at 2–5.8 m here (measured in tiles 33168/24478…), overlapping the
 * city's real street elevations. So the sea is defined by this hand-traced shoreline, consumed by
 * BOTH the custom map (sea fill) and the 3D terrain painter (sea/sand tint) so they always agree.
 *
 * Points are NE→SW along the shore. The sea polygon closes far offshore (east +X / south −Z).
 * Accuracy is ~±100 m; nudge points when a screenshot shows the waterline off. The PROPER fix is
 * bake-side: stitch OSM natural=coastline and sink sea cells in the elevation grid (queued).
 */
import { latLonToWorld } from '../projection.js';

/**
 * ⚠ THE NE HALF OF THIS TRACE WAS MEASURED, NOT EYEBALLED (2026-09-04).
 *
 * User screenshot at Passeig Marítim de la Mar Bella: the sea covering the Diagonal Mar street grid.
 * The file's own instruction — "nudge points when a screenshot shows the waterline off" — is how it
 * got wrong, so instead `backend/tools/coastlineProbe.mjs` read `natural=coastline` straight out of
 * the baked tiles (34.65 km across 32 ways in 48 tiles — the data was there all along) and printed
 * the distance from each hand point to the real shore:
 *
 *     41.4210,2.2300 → 1204 m      41.3985,2.2060 → 432 m      41.3810,2.1945 →  22 m
 *     41.4110,2.2210 →  503 m      41.3935,2.2020 → 310 m      41.3765,2.1920 →   8 m
 *     41.4040,2.2120 →  386 m      41.3878,2.1990 → 116 m
 *
 * The Besòs→Nova Icària run was 310-500 m INLAND of the true shore, which is precisely the stretch
 * that flooded; south of Port Olímpic the trace was already within ~150 m. So the NE points below
 * are the probe's measured coastline vertices, and the southern ones are left alone.
 *
 * Re-run the probe rather than nudging by eye: `node backend/tools/coastlineProbe.mjs`.
 */
export const SEA_COAST_LATLON = [
  // ── NE end: extrapolated seaward along the measured bearing, so the polygon covers the bake's
  //    NE corner (maxLat 41.4130 / maxLon 2.2230). OSM's coastline stops at 41.4104,2.2272.
  [41.4215, 2.2420],
  [41.4104, 2.2272],                                        // Besòs / Llevant — MEASURED
  [41.4021, 2.2158],                                        // Mar Bella      — MEASURED (was 386 m inland)
  [41.3953, 2.2089],                                        // Bogatell       — MEASURED (was 432 m inland)
  [41.3915, 2.2045],                                        // Nova Icària    — MEASURED (was 310 m inland)
  [41.3869, 2.1983], [41.3843, 2.1975],                     // Port Olímpic breakwater — MEASURED
  [41.3809, 2.1947], [41.3765, 2.1919],                     // Somorrostro / Barceloneta beach
  [41.3721, 2.1896], [41.3696, 2.1902],                     // Sant Sebastià → W-hotel spit tip
  [41.3669, 2.1867], [41.3658, 2.1808],                     // wrap the peninsula tip seaward side
  [41.3639, 2.1749], [41.3586, 2.1699],                     // outer commercial-port breakwater
  // ⚠ OSM's coastline ENDS at 41.3382,2.1695 — the probe finds nothing within 0.9-3.9 km of the four
  // points below, so they are unverified hand guesses covering the port and Zona Franca. Nobody has
  // reported a problem there and there is no data to correct them WITH; do not "fix" them by eye.
  [41.3510, 2.1610], [41.3420, 2.1530],
  [41.3300, 2.1430], [41.3180, 2.1320],                     // Zona Franca end
];

let _shore = null;   // active shore polyline in world coords [{x,z}]
let _sea = null;     // closed sea polygon (shore + far-offshore closure)
let _version = 0;    // bumped when the OSM coastline replaces the hand trace (consumers re-cache)
let _osmShore = null;

/** Version counter — consumers that cache the sea polygon re-read when this changes. */
export function coastVersion() { return _version; }

/**
 * ── LAND ANCHORS: the sea must not swallow the city ───────────────────────────────────────────
 *
 * ⚠ THE BUG THIS EXISTS FOR (user screenshot, Carrer del Gas, 2026-09-04): the Mediterranean was
 * drawn over several blocks of Poblenou, with buildings and streets standing in blue water and a
 * dead-straight diagonal waterline running through them.
 *
 * Cause: `ingestCoastline` was first-tile-wins — it stitched whatever `natural=coastline` ways
 * happened to be in the FIRST tile that carried any, and `noClipTileStrategy` hands a tile the full
 * geometry of every way touching it, so one tile can clear the 3 km sanity check with a chain that
 * still covers a fraction of the coast. The sea polygon then closes 30 km offshore FROM THAT
 * CHAIN'S TWO ENDS — and if the chain stops mid-city, the closure edge is a straight line through
 * the city with "sea" on one side of it. That is exactly the diagonal in the screenshot.
 *
 * A longer chain is the fix, but "long enough" is not something a length threshold can decide. So
 * the candidate is tested against the thing that actually matters: known INLAND places must not
 * come out as sea. A polygon that floods Sagrada Família is rejected however many kilometres it is.
 */
const LAND_ANCHORS = [
  [41.3870, 2.1700],  // Plaça Catalunya
  [41.4036, 2.1744],  // Sagrada Família
  [41.3809, 2.1228],  // Camp Nou
  [41.3754, 2.1490],  // Plaça d'Espanya
  [41.4145, 2.1527],  // Park Güell
  [41.4030, 2.1870],  // Glòries
  [41.4100, 2.2170],  // Diagonal Mar — ~850 m inland of the measured shore
  [41.4040, 2.2100],  // Mar Bella blocks — the grid that was under water in the report
];
const SEA_ANCHORS = [
  [41.3350, 2.2450],  // well out in the Mediterranean
  [41.3750, 2.2100],  // off Barceloneta
];

function pointInPoly(poly, px, pz) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Close a shore chain into a sea polygon on the seaward side.
 * @returns {{poly:{x:number,z:number}[], seaCross:number}|null}
 */
function closeSea(shore) {
  const OFF = 30000;
  const a = shore[0], b = shore[shore.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const dl = Math.hypot(dx, dz) || 1;
  const test = latLonToWorld(SEA_ANCHORS[0][0], SEA_ANCHORS[0][1]);
  for (const sgn of [1, -1]) {
    const nx = (dz / dl) * OFF * sgn, nz = (-dx / dl) * OFF * sgn;
    const poly = [...shore, { x: b.x + nx, z: b.z + nz }, { x: a.x + nx, z: a.z + nz }];
    // seaward normal n = sgn·(dz,−dx)/dl ⇒ cross(dir, n) = −sgn·dl ⇒ sea-side cross sign = −sgn
    if (pointInPoly(poly, test.x, test.z) || sgn === -1) return { poly, seaCross: -sgn };
  }
  return null;
}

/** Would this shore chain produce a sea that behaves like the sea? */
function seaIsSane(shore) {
  const closed = closeSea(shore);
  if (!closed) return false;
  for (const [lat, lon] of LAND_ANCHORS) {
    const w = latLonToWorld(lat, lon);
    if (pointInPoly(closed.poly, w.x, w.z)) return false;   // the city is under water — reject
  }
  for (const [lat, lon] of SEA_ANCHORS) {
    const w = latLonToWorld(lat, lon);
    if (!pointInPoly(closed.poly, w.x, w.z)) return false;  // the sea is not sea — reject
  }
  return true;
}

// Coastline ways ACCUMULATE across tiles. One tile is a fragment of the coast; the chain gets
// longer as the player drives along it, and a longer chain is adopted whenever it still passes
// seaIsSane(). Deduped by endpoint pair, because noClipTileStrategy hands the same way to every
// tile it touches.
const _segs = [];
const _segKeys = new Set();
let _adoptedLen = 0;

/**
 * Feed `natural=coastline` polylines from a freshly parsed tile. Cheap and idempotent: the work
 * only runs when a tile actually brought new segments.
 */
export function ingestCoastline(waterFeatures) {
  if (!waterFeatures?.length) return;
  let added = 0;
  for (const w of waterFeatures) {
    if (w.type !== 'coastline' || !w.polygon || w.polygon.length < 2) continue;
    const seg = w.polygon.map((p) => ({ x: p.x, z: p.y }));   // parser convention: y = world Z
    const a = seg[0], b = seg[seg.length - 1];
    const k = `${Math.round(a.x)}_${Math.round(a.z)}_${Math.round(b.x)}_${Math.round(b.z)}_${seg.length}`;
    if (_segKeys.has(k)) continue;
    _segKeys.add(k);
    _segs.push(seg);
    added++;
  }
  if (!added || _segs.length < 2) return;

  // Stitch segments into chains by matching endpoints (2 m tolerance, quantized key).
  const key = (p) => `${Math.round(p.x / 2)}_${Math.round(p.z / 2)}`;
  const segs = _segs;
  const used = new Array(segs.length).fill(false);
  const byEnd = new Map();   // endpoint key -> [{i, atStart}]
  for (let i = 0; i < segs.length; i++) {
    for (const [p, atStart] of [[segs[i][0], true], [segs[i][segs[i].length - 1], false]]) {
      const k = key(p);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push({ i, atStart });
    }
  }
  const chains = [];
  for (let s2 = 0; s2 < segs.length; s2++) {
    if (used[s2]) continue;
    used[s2] = true;
    const chain = [...segs[s2]];
    let grew = true;
    while (grew) {
      grew = false;
      const tail = chain[chain.length - 1];
      for (const c of byEnd.get(key(tail)) || []) {
        if (used[c.i]) continue;
        const seg = c.atStart ? segs[c.i] : [...segs[c.i]].reverse();
        if (Math.hypot(seg[0].x - tail.x, seg[0].z - tail.z) > 4) continue;
        used[c.i] = true;
        chain.push(...seg.slice(1));
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  const lengthOf = (c) => { let l = 0; for (let i = 1; i < c.length; i++) l += Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z); return l; };
  chains.sort((a, b) => lengthOf(b) - lengthOf(a));
  const main = chains[0];
  if (!main) return;
  const mainLen = lengthOf(main);
  // A SANITY FLOOR ONLY. The length gate cannot decide this — a wrong 15 km chain floods the city
  // just as well as a wrong 3 km one — so `seaIsSane()` below is the real test and this is just
  // "don't bother with scraps". 12 km was too strict: the tiles' longest single coastline way is
  // 6.19 km (probe), so a chain that fails to stitch would never be considered at all.
  if (mainLen < 5000 || mainLen <= _adoptedLen * 1.02) return;

  // Decimate to ~3 m tolerance (RDP would be nicer; every-other-point at OSM density is plenty).
  const shore = [];
  for (let i = 0; i < main.length; i++) {
    const p = main[i];
    if (!shore.length || i === main.length - 1
        || Math.hypot(p.x - shore[shore.length - 1].x, p.z - shore[shore.length - 1].z) > 3) shore.push(p);
  }

  // ⚠ ADOPT ONLY IF IT BEHAVES LIKE THE SEA. Falling back to the hand trace is a slightly wrong
  // waterline; adopting a bad chain is the city under water. Those are not comparable failures.
  if (!seaIsSane(shore)) {
    if (!_warnedBadShore) {
      _warnedBadShore = true;
      console.warn(`[coastline] stitched OSM shore (${(mainLen / 1000).toFixed(1)} km, ${_segs.length} segs) `
        + 'floods a known inland landmark — keeping the hand trace. More tiles may fix it.');
    }
    return;
  }

  _adoptedLen = mainLen;
  _osmShore = shore;
  _shore = null; _sea = null; _coarseSea = null; _shoreGrid = null;   // rebuild lazily
  _version++;
}
let _warnedBadShore = false;

let _coarseSea = null;   // decimated sea polygon for far-from-shore point tests
let _seaCross = 1;       // sign of cross((b−a),(p−a)) on the SEA side of shore segments

function build() {
  if (_shore) return;
  _shore = _osmShore || SEA_COAST_LATLON.map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, z: w.z }; });
  // Close on the SEAWARD side — shared with the ingest-time validation so the polygon that gets
  // TESTED is the polygon that gets USED. Two implementations of this would be two chances to be
  // wrong about which side the water is on.
  const closed = closeSea(_shore);
  const a = _shore[0], b = _shore[_shore.length - 1];
  _sea = closed.poly;
  _seaCross = closed.seaCross;
  // Coarse polygon (≥60 m point spacing) for cheap far-field point-in-sea tests — the fine chain
  // can be thousands of points and PIP per terrain vertex would crawl.
  const coarseShore = [];
  for (let i = 0; i < _shore.length; i++) {
    const p = _shore[i];
    if (!coarseShore.length || i === _shore.length - 1
        || Math.hypot(p.x - coarseShore[coarseShore.length - 1].x, p.z - coarseShore[coarseShore.length - 1].z) > 60) coarseShore.push(p);
  }
  const ca = coarseShore[0], cb = coarseShore[coarseShore.length - 1];
  const last2 = _sea[_sea.length - 2], last1 = _sea[_sea.length - 1];
  _coarseSea = [...coarseShore, { x: cb.x + (last2.x - b.x), z: cb.z + (last2.z - b.z) }, { x: ca.x + (last1.x - a.x), z: ca.z + (last1.z - a.z) }];
}

/** Traced shore polyline in world coords (for map drawing / distance tests). */
export function shorePoints() { build(); return _shore; }

/** Closed sea polygon in world coords (shore + offshore closure). */
export function seaPolygonWorld() { build(); return _sea; }

/**
 * One lookup per point: { sea, dist }. Near the shore (a segment within the 64 m grid) the side of
 * the NEAREST segment decides sea/land exactly; far from shore the coarse polygon decides. This is
 * what the terrain painter calls per vertex — one grid query answers both classification and the
 * sand/wet band distance.
 */
export function coastSample(wx, wz) {
  const grid = shoreGrid();
  const gx = Math.floor(wx / SHORE_CELL), gz = Math.floor(wz / SHORE_CELL);
  let best = Infinity, bi = -1, bt = 0;
  for (let dxc = -1; dxc <= 1; dxc++) {
    for (let dzc = -1; dzc <= 1; dzc++) {
      const list = grid.get((gx + dxc) * 100003 + (gz + dzc));
      if (!list) continue;
      for (const i of list) {
        const ax = _shore[i].x, az = _shore[i].z, bx = _shore[i + 1].x, bz = _shore[i + 1].z;
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((wx - ax) * dx + (wz - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ddx = wx - (ax + t * dx), ddz = wz - (az + t * dz);
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < best) { best = d2; bi = i; bt = t; }
      }
    }
  }
  if (bi >= 0) {
    const ax = _shore[bi].x, az = _shore[bi].z, bx = _shore[bi + 1].x, bz = _shore[bi + 1].z;
    const cross = (bx - ax) * (wz - az) - (bz - az) * (wx - ax);
    return { sea: Math.sign(cross) === _seaCross && cross !== 0, dist: Math.sqrt(best) };
  }
  // Far field: coarse polygon PIP.
  let inside = false;
  for (let i = 0, j = _coarseSea.length - 1; i < _coarseSea.length; j = i++) {
    const xi = _coarseSea[i].x, zi = _coarseSea[i].z, xj = _coarseSea[j].x, zj = _coarseSea[j].z;
    if ((zi > wz) !== (zj > wz) && wx < ((xj - xi) * (wz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return { sea: inside, dist: Infinity };
}

/** Is this world XZ in the open sea? */
export function isSeaAt(wx, wz) { return coastSample(wx, wz).sea; }

/**
 * Distance (m) from world XZ to the shoreline (coast segments only, not the closure), capped at
 * ~one grid cell: the OSM shore has thousands of segments, so lookups go through a 64 m hash grid
 * (3×3 cells ≈ anything within ~64 m is exact; farther returns Infinity — callers only use small
 * distances for the sand/wet bands).
 */
const SHORE_CELL = 64;
let _shoreGrid = null, _shoreGridVer = -1;
function shoreGrid() {
  build();
  if (_shoreGrid && _shoreGridVer === _version) return _shoreGrid;
  _shoreGrid = new Map();
  for (let i = 0; i < _shore.length - 1; i++) {
    const a = _shore[i], b = _shore[i + 1];
    const c0x = Math.floor(Math.min(a.x, b.x) / SHORE_CELL), c1x = Math.floor(Math.max(a.x, b.x) / SHORE_CELL);
    const c0z = Math.floor(Math.min(a.z, b.z) / SHORE_CELL), c1z = Math.floor(Math.max(a.z, b.z) / SHORE_CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const k = cx * 100003 + cz;
        if (!_shoreGrid.has(k)) _shoreGrid.set(k, []);
        _shoreGrid.get(k).push(i);
      }
    }
  }
  _shoreGridVer = _version;
  return _shoreGrid;
}

export function shoreDistM(wx, wz) {
  const grid = shoreGrid();
  const gx = Math.floor(wx / SHORE_CELL), gz = Math.floor(wz / SHORE_CELL);
  let best = Infinity;
  for (let dxc = -1; dxc <= 1; dxc++) {
    for (let dzc = -1; dzc <= 1; dzc++) {
      const list = grid.get((gx + dxc) * 100003 + (gz + dzc));
      if (!list) continue;
      for (const i of list) {
        const ax = _shore[i].x, az = _shore[i].z, bx = _shore[i + 1].x, bz = _shore[i + 1].z;
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((wx - ax) * dx + (wz - az) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ddx = wx - (ax + t * dx), ddz = wz - (az + t * dz);
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < best) best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

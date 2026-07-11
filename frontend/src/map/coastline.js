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

export const SEA_COAST_LATLON = [
  [41.4210, 2.2300],                                        // Besòs end
  [41.4110, 2.2210], [41.4040, 2.2120],                     // Llevant / Mar Bella
  [41.3985, 2.2060], [41.3935, 2.2020],                     // Bogatell / Nova Icària
  [41.3878, 2.1990], [41.3855, 2.1965],                     // Port Olímpic breakwater
  [41.3810, 2.1945], [41.3765, 2.1920],                     // Somorrostro / Barceloneta beach
  [41.3722, 2.1905], [41.3688, 2.1898],                     // Sant Sebastià → W-hotel spit tip
  [41.3672, 2.1870], [41.3665, 2.1820],                     // wrap the peninsula tip seaward side
  [41.3630, 2.1750], [41.3585, 2.1690],                     // outer commercial-port breakwater
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
 * Upgrade the hand trace to the REAL OSM coastline. The baked tiles carry natural=coastline as
 * polyline water features (type 'coastline'); the first processed tile hands them here, we stitch
 * the segments into the mainland chain and it becomes the sea boundary everywhere. Runs once.
 */
export function ingestCoastline(waterFeatures) {
  if (_osmShore || !waterFeatures?.length) return;
  const segs = [];
  for (const w of waterFeatures) {
    if (w.type !== 'coastline' || !w.polygon || w.polygon.length < 2) continue;
    segs.push(w.polygon.map((p) => ({ x: p.x, z: p.y })));   // parser convention: y = world Z
  }
  if (segs.length < 2) return;

  // Stitch segments into chains by matching endpoints (2 m tolerance, quantized key).
  const key = (p) => `${Math.round(p.x / 2)}_${Math.round(p.z / 2)}`;
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
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const chain = [...segs[s]];
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
  if (!main || lengthOf(main) < 3000) return;   // sanity: the mainland coast is many km

  // Decimate to ~3 m tolerance (RDP would be nicer; every-other-point at OSM density is plenty).
  const shore = [];
  for (let i = 0; i < main.length; i++) {
    const p = main[i];
    if (!shore.length || i === main.length - 1
        || Math.hypot(p.x - shore[shore.length - 1].x, p.z - shore[shore.length - 1].z) > 3) shore.push(p);
  }

  _osmShore = shore;
  _shore = null; _sea = null;   // rebuild lazily with the new source
  _version++;
}

let _coarseSea = null;   // decimated sea polygon for far-from-shore point tests
let _seaCross = 1;       // sign of cross((b−a),(p−a)) on the SEA side of shore segments

function build() {
  if (_shore) return;
  _shore = _osmShore || SEA_COAST_LATLON.map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, z: w.z }; });
  const OFF = 30000;
  const a = _shore[0], b = _shore[_shore.length - 1];
  // Close on the SEAWARD side: try one perpendicular of the overall chain direction; if a known
  // far-offshore point isn't inside the resulting polygon, flip. (OSM's water-on-the-right rule
  // makes this deterministic, but segment stitching may reverse ways — the test is bulletproof.)
  const dx = b.x - a.x, dz = b.z - a.z;
  const dl = Math.hypot(dx, dz) || 1;
  const test = latLonToWorld(41.335, 2.245);   // well out in the Mediterranean
  for (const sgn of [1, -1]) {
    const nx = (dz / dl) * OFF * sgn, nz = (-dx / dl) * OFF * sgn;
    const poly = [..._shore, { x: b.x + nx, z: b.z + nz }, { x: a.x + nx, z: a.z + nz }];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
      if ((zi > test.z) !== (zj > test.z) && test.x < ((xj - xi) * (test.z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside || sgn === -1) {
      _sea = poly;
      // seaward normal n = sgn·(dz,−dx)/dl ⇒ cross(dir, n) = −sgn·dl ⇒ sea-side cross sign = −sgn
      _seaCross = -sgn;
      break;
    }
  }
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

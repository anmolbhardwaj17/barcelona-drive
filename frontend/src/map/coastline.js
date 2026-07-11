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

let _shore = null;   // traced shore in world coords [{x,z}]
let _sea = null;     // closed sea polygon (shore + far-offshore closure)

function build() {
  if (_shore) return;
  _shore = SEA_COAST_LATLON.map(([lat, lon]) => { const w = latLonToWorld(lat, lon); return { x: w.x, z: w.z }; });
  const OFF = 30000;
  const sw = _shore[_shore.length - 1], ne = _shore[0];
  _sea = [..._shore, { x: sw.x + OFF, z: sw.z - OFF }, { x: ne.x + OFF, z: ne.z - OFF }];
}

/** Traced shore polyline in world coords (for map drawing / distance tests). */
export function shorePoints() { build(); return _shore; }

/** Closed sea polygon in world coords (shore + offshore closure). */
export function seaPolygonWorld() { build(); return _sea; }

/** Is this world XZ in the open sea? (Point-in-polygon on the closed sea shape.) */
export function isSeaAt(wx, wz) {
  build();
  let inside = false;
  for (let i = 0, j = _sea.length - 1; i < _sea.length; j = i++) {
    const xi = _sea[i].x, zi = _sea[i].z, xj = _sea[j].x, zj = _sea[j].z;
    if ((zi > wz) !== (zj > wz) && wx < ((xj - xi) * (wz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (m) from world XZ to the traced shoreline (the coast segments only, not the closure). */
export function shoreDistM(wx, wz) {
  build();
  let best = Infinity;
  for (let i = 0; i < _shore.length - 1; i++) {
    const ax = _shore[i].x, az = _shore[i].z, bx = _shore[i + 1].x, bz = _shore[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((wx - ax) * dx + (wz - az) * dz) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ddx = wx - (ax + t * dx), ddz = wz - (az + t * dz);
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

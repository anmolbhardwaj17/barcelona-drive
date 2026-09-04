const R = 6378137;
// Mercator projection origin — SW of the Barcelona region bbox.
// World coords throughout Barcelona stay in 0–12 km range → float32 precision ≈ 1.2 mm.
// MUST match ORIGIN_LAT/ORIGIN_LON in:
//   backend/projection.js, frontend/src/workers/vegetationWorker.js,
//   frontend/src/workers/buildingWorker.js
// EXPORTED so the workers can import them instead of re-declaring them. They used to carry their
// own copies under a "MUST match frontend/src/projection.js" comment, which is a request, not a
// guarantee — nothing checked, and a projection origin that drifts between the main thread and a
// worker moves geometry silently. `projection.js` has no imports of its own (it is a leaf, no
// three.js), so there was never a technical reason for the copies: the workers already import
// `map/roadWidths.js`. K-1.
export const ORIGIN_LAT = 41.350;
export const ORIGIN_LON = 2.115;

// Unstretch-X (vertical-model-foundation-spec §3): Web Mercator stretches XZ by 1/cos(lat).
// Multiply (mercator − origin) by cos(ORIGIN_LAT) so 1 world unit = 1 real metre on every axis.
// Single-factor; bbox scale variance 0.085% (ADR D-11). This IS the projection-level unit factor —
// not a downstream correction. MUST match the identical constant inlined in the other 5 projection
// paths: backend/projection.js, tileParserWorker.js, vegetationWorker.js, buildingWorker.js, fastElevation.js.
export const MERCATOR_UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);

export const TILE_ZOOM = 16;

let _originMercator = null;
export function getOriginMercator() {
  if (_originMercator) return _originMercator;
  _originMercator = latLonToMercator(ORIGIN_LAT, ORIGIN_LON);
  return _originMercator;
}

export function latLonToMercator(lat, lon) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const x = R * lonRad;
  const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return { x, y };
}

export function mercatorToLatLon(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const latRad = 2 * Math.atan(Math.exp(y / R)) - Math.PI / 2;
  const lat = latRad * (180 / Math.PI);
  return { lat, lon };
}

export function mercatorToWorld(mx, my) {
  const o = getOriginMercator();
  return { x: (mx - o.x) * MERCATOR_UNSTRETCH, z: (my - o.y) * MERCATOR_UNSTRETCH };
}

export function worldToMercator(wx, wz) {
  const o = getOriginMercator();
  return { x: wx / MERCATOR_UNSTRETCH + o.x, y: wz / MERCATOR_UNSTRETCH + o.y };
}

export function worldToLatLon(wx, wz) {
  const m = worldToMercator(wx, wz);
  return mercatorToLatLon(m.x, m.y);
}

export function latLonToWorld(lat, lon) {
  const m = latLonToMercator(lat, lon);
  return mercatorToWorld(m.x, m.y);
}

export function latLonToTile(lat, lon, zoom) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
  return { zoom, x, y };
}

export function tileToBBox(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lon1 = (x / n) * 360 - 180;
  const lon2 = ((x + 1) / n) * 360 - 180;
  const toDeg = 180 / Math.PI;
  const lat1 = toDeg * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat2 = toDeg * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return {
    south: lat2,
    west: lon1,
    north: lat1,
    east: lon2,
  };
}

export function worldToSlippyTile(wx, wz) {
  const { lat, lon } = worldToLatLon(wx, wz);
  const { x, y } = latLonToTile(lat, lon, TILE_ZOOM);
  return { x, y };
}

export function tileCenterToWorld(x, y, zoom) {
  const bbox = tileToBBox(x, y, zoom);
  const lat = (bbox.south + bbox.north) / 2;
  const lon = (bbox.west + bbox.east) / 2;
  return latLonToWorld(lat, lon);
}

export function getTileBboxLatLon(x, y, zoom = TILE_ZOOM) {
  return tileToBBox(x, y, zoom);
}

export function worldToTile(wx, wz, tileSize = 500) {
  return {
    tx: Math.floor(wx / tileSize),
    ty: Math.floor(wz / tileSize),
  };
}

// START_LAT / START_LON moved to spawnConfig.js — import from there.
// Kept here as re-exports so any stale import still resolves during migration.
export { START_LAT, START_LON } from './spawnConfig.js';

export function getTileIdFromLatLon(lat, lon) {
  const { zoom, x, y } = latLonToTile(lat, lon, TILE_ZOOM);
  return `${zoom}_${x}_${y}`;
}


// ── K-1: WHICH SPACE IS THIS? ─────────────────────────────────────────────────────────────────
//
// Every coordinate bug this project has paid for was a SPACE bug, not an arithmetic one. The
// world→physics negation (`px = -(wx - originX)`) is written out at nine call sites and is correct
// at all nine — it is well known and well commented. What keeps going wrong is data arriving in a
// different space from the one the reader assumed:
//
//   • N-25 (2026-09-05) — the bake emitted 316,063 vegetation positions in WORLD while the reader
//     converted them as MERCATOR. Every tree and bush in every park landed 3,800 km away. Silent.
//   • The same file's vegetation MASK rasterised Mercator roads into a world-bounded grid, so its
//     road guard blocked nothing, ever.
//   • P-6 (same day) — an audit compared raw shop positions (world) against raw road points
//     (Mercator) and reported a median gap of 5,069,611 m: the Mercator northing itself.
//
// The two spaces are three orders of magnitude apart, so a magnitude check separates them with no
// ambiguity. Barcelona world coords run roughly -1 km to 20 km; Mercator eastings here are ~235-250k
// and northings ~5.07M. Nothing legitimate sits in between.

/** True if `x` looks like an absolute Mercator easting rather than a world metre. */
export function looksMercator(x) {
  return Number.isFinite(x) && Math.abs(x) > 100000;
}

const _spaceWarned = new Set();
/**
 * Warn ONCE if a coordinate is not in the space the caller expects.
 *
 * WARNS rather than throws, deliberately. This runs in the tile parser: throwing would abort a tile
 * load and take out a chunk of the city over a diagnostic. The BAKE is the opposite case, and
 * `vegetationBaker.assertVegSpace` throws there — a bad bake must not be written to disk.
 *
 * @param {string} label  what is being checked, e.g. 'readBakedVegetation.treePositions'
 * @param {number} sample one representative x/easting
 * @param {boolean} wantMercator
 * @returns {boolean} true if it matched
 */
export function checkSpace(label, sample, wantMercator) {
  if (!Number.isFinite(sample)) return true;      // nothing to judge; not a failure
  const is = looksMercator(sample);
  if (is === wantMercator) return true;
  if (!_spaceWarned.has(label)) {
    _spaceWarned.add(label);
    console.error(
      `[space] ${label} is in ${is ? 'MERCATOR' : 'WORLD'} space but ${wantMercator ? 'MERCATOR' : 'WORLD'} was expected `
      + `(sample x=${sample}). Geometry from this source is in the wrong place.\n`
      + `  MOST LIKELY CAUSE: a stale browser tile cache after a re-bake. Run window._clearTileCache() `
      + `and hard-reload. If it persists on a clean load, the BAKE is wrong — this is the N-25 class `
      + `of bug and it does not otherwise report itself.`);
  }
  return false;
}

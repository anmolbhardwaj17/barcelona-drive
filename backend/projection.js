/**
 * Web Mercator (EPSG:3857) projection utilities.
 * Converts WGS84 lat/lon to meters (x = easting, y = northing).
 * Slippy map tiles use standard Web Mercator tile math (zoom 15).
 */
const R = 6378137; // WGS84 equatorial radius in meters
// MUST match frontend/src/projection.js ORIGIN_LAT/ORIGIN_LON.
// SW of Barcelona bbox — world coords for the region stay in 0–12 km range.
const ORIGIN_LAT = 41.350;
const ORIGIN_LON = 2.115;

// Unstretch-X (vertical-model-foundation-spec §3): multiply (mercator − origin) by
// cos(ORIGIN_LAT) so 1 world unit = 1 real metre. MUST match frontend/src/projection.js
// MERCATOR_UNSTRETCH and the inlined worker copies.
const MERCATOR_UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);

/** Fixed zoom level for tile system (~500m tiles at zoom 16). */
export const TILE_ZOOM = 16;

let _originMercator = null;
export function getOriginMercator() {
  if (_originMercator) return _originMercator;
  _originMercator = latLonToMercator(ORIGIN_LAT, ORIGIN_LON);
  return _originMercator;
}

/**
 * Convert Web Mercator meters to world-relative (x, z) for rendering.
 * Same origin as frontend (ORIGIN_LAT, ORIGIN_LON).
 * @param {number} mx - Mercator easting
 * @param {number} my - Mercator northing
 * @returns {{ x: number, z: number }}
 */
export function mercatorToWorld(mx, my) {
  const o = getOriginMercator();
  return { x: (mx - o.x) * MERCATOR_UNSTRETCH, z: (my - o.y) * MERCATOR_UNSTRETCH };
}

/**
 * Inverse of mercatorToWorld (Unstretch-X): world (real-metre) → absolute Mercator.
 * Used by tile-assignment round-trips (centroid → mercator → lat/lon → tile). Must divide by
 * MERCATOR_UNSTRETCH or features land in the wrong tile once world coords are real metres.
 * @returns {{ x: number, y: number }}
 */
export function worldToMercator(wx, wz) {
  const o = getOriginMercator();
  return { x: wx / MERCATOR_UNSTRETCH + o.x, y: wz / MERCATOR_UNSTRETCH + o.y };
}

/**
 * Convert latitude/longitude (WGS84 degrees) to Web Mercator meters.
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @returns {{ x: number, y: number }} - x = easting, y = northing in meters
 */
export function latLonToMercator(lat, lon) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const x = R * lonRad;
  const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return { x, y };
}

/**
 * Convert Web Mercator meters to latitude/longitude (WGS84 degrees).
 * @param {number} x - Easting in meters
 * @param {number} y - Northing in meters
 * @returns {{ lat: number, lon: number }}
 */
export function mercatorToLatLon(x, y) {
  const lon = (x / R) * (180 / Math.PI);
  const latRad = 2 * Math.atan(Math.exp(y / R)) - Math.PI / 2;
  const lat = latRad * (180 / Math.PI);
  return { lat, lon };
}

/**
 * Slippy map: lat/lon to tile indices at given zoom.
 * @returns {{ zoom: number, x: number, y: number }}
 */
export function latLonToTile(lat, lon, zoom) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
  return { zoom, x, y };
}

/**
 * Slippy map: tile (x, y) at zoom to WGS84 bbox.
 * @returns {{ south: number, west: number, north: number, east: number }}
 */
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

/**
 * Get WGS84 bbox for a tile (tx, ty). Tile size 500 m. Matches frontend projection.
 * @deprecated Prefer tileToBBox(x, y, zoom) for slippy tiles.
 * @returns {{ south: number, west: number, north: number, east: number }}
 */
export function getTileBboxLatLon(tx, ty, tileSize = 500) {
  const ox = tx * tileSize;
  const oz = ty * tileSize;
  const o = getOriginMercator();
  const mx1 = ox + o.x;
  const my1 = oz + o.y;
  const mx2 = mx1 + tileSize;
  const my2 = my1 + tileSize;
  const sw = mercatorToLatLon(mx1, my1);
  const ne = mercatorToLatLon(mx2, my2);
  return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
}

/**
 * Get tile indices (tx, ty) for a bbox center.
 * @deprecated Prefer latLonToTile for slippy tiles.
 */
export function bboxToTile(south, west, north, east, tileSize = 500) {
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  const m = latLonToMercator(centerLat, centerLon);
  const o = getOriginMercator();
  const tx = Math.floor((m.x - o.x) / tileSize);
  const ty = Math.floor((m.y - o.y) / tileSize);
  return { tx, ty };
}

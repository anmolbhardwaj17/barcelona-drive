/**
 * Fast world-coordinate elevation lookup.
 *
 * The standard path (worldToLatLon → getElevationFromGrid) does trig + 2
 * object allocations per call.  For 18k+ vegetation/grass lookups per tile
 * this is the #1 CPU bottleneck.
 *
 * This module precomputes linear mapping coefficients from world (wx, wz)
 * directly to grid (row, col) so each lookup is just two multiply-adds +
 * bilinear interpolation — no trig, no object allocation.
 *
 * Usage:
 *   const fastElev = createFastElevation(elevation, offset);
 *   const y = fastElev(wx, wz);          // same result as getElevationAt(lat,lon)
 */

import { getOriginMercator, MERCATOR_UNSTRETCH } from '../projection.js';

const R = 6378137;

/**
 * Create a fast elevation sampler from world coords.
 *
 * @param {object} elevation - tile elevation data (south/west/north/east, gridRows, gridCols, elevations)
 * @param {number} offset - elevation offset subtracted (same as in terrainRenderer getElevationAt)
 * @returns {(wx: number, wz: number) => number}
 */
export function createFastElevation(elevation, offset) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) {
    return () => 0;
  }

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  const o = getOriginMercator();

  // Precompute mercator bounds from lat/lon bounds (same math as latLonToMercator, done once)
  const southRad = south * Math.PI / 180;
  const northRad = north * Math.PI / 180;
  const mySouth = R * Math.log(Math.tan(Math.PI / 4 + southRad / 2));
  const myNorth = R * Math.log(Math.tan(Math.PI / 4 + northRad / 2));
  const mxWest  = R * (west * Math.PI / 180);
  const mxEast  = R * (east * Math.PI / 180);

  // World coords = (mercator - origin) × MERCATOR_UNSTRETCH (Unstretch-X: world XZ = real metres)
  const wSouth = (mySouth - o.y) * MERCATOR_UNSTRETCH;   // world Z for south edge
  const wNorth = (myNorth - o.y) * MERCATOR_UNSTRETCH;   // world Z for north edge
  const wWest  = (mxWest  - o.x) * MERCATOR_UNSTRETCH;   // world X for west edge
  const wEast  = (mxEast  - o.x) * MERCATOR_UNSTRETCH;   // world X for east edge

  // Linear coefficients: row = rowA * wz + rowB,  col = colA * wx + colB
  // row corresponds to lat (south→north = row 0→gridRows-1), mapped from wz
  const rowSpan = wNorth - wSouth;
  const colSpan = wEast - wWest;
  const rowScale = rowSpan > 1e-10 ? (gridRows - 1) / rowSpan : 0;
  const colScale = colSpan > 1e-10 ? (gridCols - 1) / colSpan : 0;
  const rowOff   = -wSouth * rowScale;
  const colOff   = -wWest  * colScale;
  const maxRow   = gridRows - 1;
  const maxCol   = gridCols - 1;

  // Note: mercator Y is not perfectly linear with latitude, but over a single
  // tile (~540m) the error is < 0.01m — negligible for vegetation placement.

  return function fastElevationAt(wx, wz) {
    // World → grid (no trig, no allocation)
    let rowF = wz * rowScale + rowOff;
    let colF = wx * colScale + colOff;

    // Clamp
    if (rowF < 0) rowF = 0; else if (rowF > maxRow) rowF = maxRow;
    if (colF < 0) colF = 0; else if (colF > maxCol) colF = maxCol;

    // Bilinear interpolation (inlined)
    const r0 = rowF | 0;  // fast floor
    const c0 = colF | 0;
    const r1 = r0 < maxRow ? r0 + 1 : r0;
    const c1 = c0 < maxCol ? c0 + 1 : c0;
    const tr = rowF - r0;
    const tc = colF - c0;

    const v00 = elevations[r0 * gridCols + c0];
    const v10 = elevations[r1 * gridCols + c0];
    const v01 = elevations[r0 * gridCols + c1];
    const v11 = elevations[r1 * gridCols + c1];

    const raw = (1 - tr) * ((1 - tc) * v00 + tc * v01) + tr * ((1 - tc) * v10 + tc * v11);
    return raw - offset;
  };
}

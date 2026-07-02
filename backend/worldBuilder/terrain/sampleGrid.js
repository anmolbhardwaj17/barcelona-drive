/** Catmull-Rom cubic: f(t) between p1 and p2, t in [0,1], using p0..p3. */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function safeGet(grid, r, c, rows, cols) {
  const rr = Math.max(0, Math.min(rows - 1, r));
  const cc = Math.max(0, Math.min(cols - 1, c));
  const v = grid[rr * cols + cc];
  return v != null && Number.isFinite(v) ? v : 0;
}

/**
 * Bicubic elevation sampling (Catmull-Rom) from 4x4 neighborhood.
 * Grid: row 0 = south, col 0 = west; row-major.
 */
export function sampleElevationBicubic(bbox, grid, gridRows, gridCols, lat, lon) {
  const { south, west, north, east } = bbox;
  const latClamp = Math.max(south, Math.min(north, lat));
  const lonClamp = Math.max(west, Math.min(east, lon));
  const rowF = gridRows <= 1 ? 0 : ((latClamp - south) / (north - south)) * (gridRows - 1);
  const colF = gridCols <= 1 ? 0 : ((lonClamp - west) / (east - west)) * (gridCols - 1);
  const r0 = Math.max(0, Math.min(gridRows - 1, Math.floor(rowF)));
  const c0 = Math.max(0, Math.min(gridCols - 1, Math.floor(colF)));
  const tr = rowF - r0;
  const tc = colF - c0;
  const rows = [r0 - 1, r0, r0 + 1, r0 + 2];
  const cols = [c0 - 1, c0, c0 + 1, c0 + 2];
  const vals = [];
  for (let i = 0; i < 4; i++) {
    const rowVals = cols.map((cc) => safeGet(grid, rows[i], cc, gridRows, gridCols));
    vals.push(catmullRom(rowVals[0], rowVals[1], rowVals[2], rowVals[3], tc));
  }
  return catmullRom(vals[0], vals[1], vals[2], vals[3], tr);
}

/**
 * Sample elevation at (lat, lon) from tile elevation grid (bilinear interpolation).
 * Grid: row 0 = south, col 0 = west; row-major.
 * @param {object} bbox - { south, west, north, east }
 * @param {number[]} grid - row-major elevation data
 * @param {number} gridRows
 * @param {number} gridCols
 * @param {number} lat
 * @param {number} lon
 * @returns {number}
 */
export function sampleElevationFromGrid(bbox, grid, gridRows, gridCols, lat, lon) {
  const { south, west, north, east } = bbox;
  const latClamp = Math.max(south, Math.min(north, lat));
  const lonClamp = Math.max(west, Math.min(east, lon));
  const rowF = gridRows <= 1 ? 0 : ((latClamp - south) / (north - south)) * (gridRows - 1);
  const colF = gridCols <= 1 ? 0 : ((lonClamp - west) / (east - west)) * (gridCols - 1);
  const r0 = Math.max(0, Math.min(gridRows - 1, Math.floor(rowF)));
  const c0 = Math.max(0, Math.min(gridCols - 1, Math.floor(colF)));
  const r1 = Math.min(r0 + 1, gridRows - 1);
  const c1 = Math.min(c0 + 1, gridCols - 1);
  const tr = rowF - r0;
  const tc = colF - c0;
  const i00 = r0 * gridCols + c0;
  const i10 = r1 * gridCols + c0;
  const i01 = r0 * gridCols + c1;
  const i11 = r1 * gridCols + c1;
  const v00 = grid[i00] != null && Number.isFinite(grid[i00]) ? grid[i00] : 0;
  const v10 = grid[i10] != null && Number.isFinite(grid[i10]) ? grid[i10] : 0;
  const v01 = grid[i01] != null && Number.isFinite(grid[i01]) ? grid[i01] : 0;
  const v11 = grid[i11] != null && Number.isFinite(grid[i11]) ? grid[i11] : 0;
  return (1 - tr) * (1 - tc) * v00 + tr * (1 - tc) * v10 + (1 - tr) * tc * v01 + tr * tc * v11;
}

/**
 * Load multiple GeoTIFF DEM tiles and sample elevation at (lat, lon).
 * No network; all data from local files. Uses geotiff only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromArrayBuffer } from 'geotiff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Array<{ tieX: number, tieY: number, scaleX: number, scaleY: number, minLon: number, minLat: number, maxLon: number, maxLat: number, width: number, height: number, data: any, noData: number | null }>} */
let _demTiles = [];
let _boundsLonMin = null;
let _boundsLonMax = null;
let _boundsLatMin = null;
let _boundsLatMax = null;
let _outOfBoundsCount = 0;

/**
 * Smooth a DEM raster with a separable box blur (NoData-aware). Applied once to the GLOBAL DEM at load,
 * so every tile samples the same smoothed grid → gentle hills AND seamless tile edges (slippy edges share
 * lat/lon, so a global pre-smooth keeps neighbouring tiles matched — no per-tile edge work). Both the visual
 * terrain mesh and the physics heightfield read this grid via sampleElevation(), so they stay co-framed.
 * Tunable without code edits: DEM_SMOOTH_RADIUS (px, default 2), DEM_SMOOTH_ITERS (default 2). Set radius or
 * iters to 0 to disable. NoData / non-finite cells are excluded from the kernel and preserved verbatim, so
 * sea/void edges don't bleed into land and sampleElevation's noData test still works.
 * @returns {Float32Array} smoothed copy (or the original `data` if smoothing disabled)
 */
function smoothRaster(data, width, height, noData) {
  const radius = Math.max(0, parseInt(process.env.DEM_SMOOTH_RADIUS ?? '2', 10) || 0);
  const iters  = Math.max(0, parseInt(process.env.DEM_SMOOTH_ITERS  ?? '2', 10) || 0);
  if (radius < 1 || iters < 1) return data;
  const n = width * height;
  const isBad = (v) => v == null || !Number.isFinite(Number(v)) || (noData != null && Number.isFinite(noData) && Number(v) === noData);
  let src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = isBad(data[i]) ? NaN : Number(data[i]); // NaN = excluded from kernel
  let dst = new Float32Array(n);
  const blur1D = (horizontal) => {
    for (let a = 0; a < (horizontal ? height : width); a++) {
      for (let b = 0; b < (horizontal ? width : height); b++) {
        const idx = horizontal ? a * width + b : b * width + a;
        const c = src[idx];
        if (Number.isNaN(c)) { dst[idx] = NaN; continue; }
        let sum = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const bb = b + k;
          if (bb < 0 || bb >= (horizontal ? width : height)) continue;
          const v = src[horizontal ? a * width + bb : bb * width + a];
          if (Number.isNaN(v)) continue;
          sum += v; cnt++;
        }
        dst[idx] = cnt ? sum / cnt : c;
      }
    }
    const tmp = src; src = dst; dst = tmp;
  };
  for (let it = 0; it < iters; it++) { blur1D(true); blur1D(false); }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = isBad(data[i]) ? Number(data[i]) : (Number.isNaN(src[i]) ? Number(data[i]) : src[i]);
  return out;
}

/**
 * SELECTIVE terrain smoothing (Phase 1 of the terrain-tunnel rework): honor BIG relief, kill small relief.
 * The plain box blur above smooths everything UNIFORMLY — it softens Montjuïc exactly as much as sub-meter
 * street wiggle. This pass is amplitude- AND wavelength-selective via a two-scale frequency split:
 *
 *   base    = blur(src,  TERRAIN_BASE_RADIUS_PX)      // splits off short wavelengths (default ~300 m)
 *   bigBase = blur(base, TERRAIN_FLATTEN_RADIUS_PX)   // splits off mid wavelengths   (default ~900 m)
 *   out     = bigBase                                  // long wavelengths: Montjuïc, coast descent — UNTOUCHED
 *           + shrink(base − bigBase, TERRAIN_FLATTEN_THRESHOLD)  // mid relief under threshold → flat (Eixample)
 *           + shrink(src  − base,    TERRAIN_RELIEF_FLOOR)       // short relief under floor → gone (wiggle)
 *
 *   shrink(d, t) = sign(d) · max(0, |d| − t)   — soft shrinkage: continuous (no terraces), zeroes |d| ≤ t,
 *   larger features survive reduced by t (a 40 m hill flank loses 3 m, a 2 m bump vanishes).
 *
 * KNOBS (env, like DEM_SMOOTH_*): the two PRIMARY knobs are in metres and are tuned BY DRIVING:
 *   TERRAIN_RELIEF_FLOOR       (default 2.5 m) — short-wavelength amplitude below this is removed
 *   TERRAIN_FLATTEN_THRESHOLD  (default 3 m)   — mid-wavelength amplitude below this is removed
 * Secondary (wavelength splits, px — 1 px ≈ 25–30 m here):
 *   TERRAIN_BASE_RADIUS_PX     (default 10)    — "short" cutoff
 *   TERRAIN_FLATTEN_RADIUS_PX  (default 30)    — "mid" cutoff
 * Set BOTH primary knobs to 0 to disable the pass entirely (previous behaviour).
 * NoData/non-finite cells are excluded from all kernels and preserved verbatim.
 * Applied ONCE to the global raster at load (before any sampling) so every consumer — terrain grid,
 * road drape, water, physics, vegetation — inherits it and tile edges stay seamless.
 */
function selectiveSmoothRaster(data, width, height, noData) {
  const reliefFloor = Math.max(0, parseFloat(process.env.TERRAIN_RELIEF_FLOOR ?? '2.5') || 0);
  const flattenThr  = Math.max(0, parseFloat(process.env.TERRAIN_FLATTEN_THRESHOLD ?? '3') || 0);
  const baseRadius  = Math.max(1, parseInt(process.env.TERRAIN_BASE_RADIUS_PX ?? '10', 10) || 10);
  const flatRadius  = Math.max(1, parseInt(process.env.TERRAIN_FLATTEN_RADIUS_PX ?? '30', 10) || 30);
  if (reliefFloor <= 0 && flattenThr <= 0) {
    console.log('  Selective terrain smoothing: DISABLED (both knobs 0)');
    return data;
  }
  const n = width * height;
  const isBad = (v) => v == null || !Number.isFinite(Number(v)) || (noData != null && Number.isFinite(noData) && Number(v) === noData);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = isBad(data[i]) ? NaN : Number(data[i]);

  // NoData-aware separable box blur (running-sum, O(n) per axis). NaN cells excluded and preserved.
  const blurRS = (input, radius, iters) => {
    let cur = Float32Array.from(input);
    let next = new Float32Array(n);
    const pass = (horizontal) => {
      const outer = horizontal ? height : width;
      const inner = horizontal ? width : height;
      for (let a = 0; a < outer; a++) {
        const idxOf = horizontal ? (b) => a * width + b : (b) => b * width + a;
        let sum = 0, cnt = 0;
        // prime window [0, radius]
        for (let b = 0; b <= Math.min(radius, inner - 1); b++) {
          const v = cur[idxOf(b)];
          if (!Number.isNaN(v)) { sum += v; cnt++; }
        }
        for (let b = 0; b < inner; b++) {
          const i = idxOf(b);
          next[i] = Number.isNaN(cur[i]) ? NaN : (cnt ? sum / cnt : cur[i]);
          const add = b + radius + 1, sub = b - radius;
          if (add < inner) { const v = cur[idxOf(add)]; if (!Number.isNaN(v)) { sum += v; cnt++; } }
          if (sub >= 0)    { const v = cur[idxOf(sub)]; if (!Number.isNaN(v)) { sum -= v; cnt--; } }
        }
      }
      const t = cur; cur = next; next = t;
    };
    for (let it = 0; it < iters; it++) { pass(true); pass(false); }
    return cur;
  };

  const base    = blurRS(src, baseRadius, 2);
  const bigBase = blurRS(base, flatRadius, 2);
  const shrink = (d, t) => (d > t ? d - t : d < -t ? d + t : 0);

  const out = new Float32Array(n);
  let changed = 0, maxDelta = 0, sumSq = 0, valid = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(src[i]) || Number.isNaN(base[i]) || Number.isNaN(bigBase[i])) {
      out[i] = Number(data[i]); // NoData/edge: preserve verbatim
      continue;
    }
    const v = bigBase[i]
      + shrink(base[i] - bigBase[i], flattenThr)
      + shrink(src[i] - base[i], reliefFloor);
    out[i] = v;
    const d = Math.abs(v - src[i]);
    if (d > 0.5) changed++;
    if (d > maxDelta) maxDelta = d;
    sumSq += d * d; valid++;
  }
  const rms = valid ? Math.sqrt(sumSq / valid) : 0;
  console.log(`  Selective terrain smoothing: floor=${reliefFloor}m thr=${flattenThr}m radii=${baseRadius}/${flatRadius}px | removed-relief RMS=${rms.toFixed(2)}m max=${maxDelta.toFixed(1)}m cells>0.5m=${((changed / Math.max(1, valid)) * 100).toFixed(1)}%`);
  return out;
}

/**
 * Load one GeoTIFF file. Uses tie point + ModelPixelScale (affine) for pixel conversion (Copernicus COG).
 * @param {string} demPath - Path to .tif file
 * @returns {Promise<object>} Tile descriptor with tieX, tieY, scaleX, scaleY, bounds, width, height, data, noData
 */
async function loadOneTile(demPath) {
  const resolved = path.isAbsolute(demPath) ? demPath : path.resolve(process.cwd(), demPath);
  const buffer = fs.readFileSync(resolved);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const tiePoints = image.getTiePoints();
  const tie = tiePoints[0];
  const tieX = Number(tie.x);
  const tieY = Number(tie.y);
  const scale = image.getFileDirectory().ModelPixelScale;
  const scaleX = Number(scale[0]);
  const scaleY = Number(scale[1]);
  const minLon = tieX;
  const maxLon = tieX + width * scaleX;
  const maxLat = tieY;
  const minLat = tieY - height * scaleY;
  const raster = await image.readRasters();
  const rawData = raster[0];   // single band DEM
  const fd = image.getFileDirectory();
  const noData = fd.GDAL_NODATA != null ? parseFloat(fd.GDAL_NODATA) : null;
  // Smooth the source DEM once (gentle, seamless hills — see smoothRaster). Global pre-smooth keeps tile edges matched.
  // Then the SELECTIVE pass (Phase 1): kill small relief, honor big relief — see selectiveSmoothRaster.
  const data = selectiveSmoothRaster(smoothRaster(rawData, width, height, noData), width, height, noData);
  const r = Math.max(0, parseInt(process.env.DEM_SMOOTH_RADIUS ?? '2', 10) || 0);
  const it = Math.max(0, parseInt(process.env.DEM_SMOOTH_ITERS ?? '2', 10) || 0);
  console.log(`  DEM smoothing: ${(r >= 1 && it >= 1) ? `box blur radius=${r} iters=${it}` : 'DISABLED'} (${width}x${height})`);
  return { tieX, tieY, scaleX, scaleY, minLon, minLat, maxLon, maxLat, width, height, data, noData };
}

/**
 * Compute combined bounds from demTiles (union of all tile extents).
 */
function updateCombinedBounds() {
  if (_demTiles.length === 0) {
    _boundsLonMin = _boundsLonMax = _boundsLatMin = _boundsLatMax = null;
    return;
  }
  let lonMin = Infinity, latMin = Infinity, lonMax = -Infinity, latMax = -Infinity;
  for (const t of _demTiles) {
    lonMin = Math.min(lonMin, t.minLon);
    lonMax = Math.max(lonMax, t.maxLon);
    latMin = Math.min(latMin, t.minLat);
    latMax = Math.max(latMax, t.maxLat);
  }
  _boundsLonMin = lonMin;
  _boundsLonMax = lonMax;
  _boundsLatMin = latMin;
  _boundsLatMax = latMax;
}

/**
 * Load multiple GeoTIFF DEM tiles. DEM bounding box is the union of all tiles.
 * @param {string[]} demPaths - Paths to .tif files (e.g. N28E076_10m.tif, N28E077_10m.tif)
 * @returns {Promise<{ sampleElevation: (lat: number, lon: number) => number | null, getBounds: () => object }>}
 */
export async function loadDEM(demPaths) {
  const paths = Array.isArray(demPaths) ? demPaths : [demPaths];
  _demTiles = [];
  _outOfBoundsCount = 0;

  for (const demPath of paths) {
    const tile = await loadOneTile(demPath);
    _demTiles.push(tile);
    console.log('  Tile bbox:', { minLon: tile.minLon, minLat: tile.minLat, maxLon: tile.maxLon, maxLat: tile.maxLat });
  }

  updateCombinedBounds();

  console.log('DEM tiles loaded:', _demTiles.length);
  if (_demTiles.length > 0) {
    console.log('  Combined DEM bounds:', { minLon: _boundsLonMin, minLat: _boundsLatMin, maxLon: _boundsLonMax, maxLat: _boundsLatMax });
  }

  // Sanity test: Sagrada Família, Barcelona (~10–15 m above sea level per DEM)
  const testLat = 41.4036;
  const testLon = 2.1744;
  const testElev = sampleElevation(testLat, testLon);
  console.log('  Test elevation at Sagrada Família (41.4036, 2.1744):', testElev != null ? `${testElev} m` : 'null (point outside DEM — check tile coverage)');

  return {
    sampleElevation(lat, lon) {
      return sampleElevation(lat, lon);
    },
    getBounds() {
      return {
        minLon: _boundsLonMin,
        maxLon: _boundsLonMax,
        minLat: _boundsLatMin,
        maxLat: _boundsLatMax,
      };
    },
  };
}

/**
 * Sample elevation at (lat, lon). Returns null if outside all DEM tile bounds (no silent clamp).
 * Logs out-of-bounds sampling. Assumes DEM is in WGS84 (lon, lat).
 * @param {number} lat - Latitude (degrees)
 * @param {number} lon - Longitude (degrees)
 * @returns {number | null} Elevation in meters, or null if outside all tiles / no data
 */
const EPS = 0.0001;

function sampleElevation(lat, lon) {
  if (!_demTiles.length) return null;

  for (const t of _demTiles) {
    // Fractional pixel coordinates → BILINEAR interpolation between the 4 surrounding DEM pixels.
    // Nearest-pixel (Math.floor) sampling produced visible stair-step "terraces" aligned to the coarse
    // DEM pixel grid (each fine mesh vertex snapped to one pixel → flat patches + hard steps). Bilinear
    // makes the surface continuous → natural smooth terrain that roads conform to. NoData-aware: voids
    // are excluded from the blend (fall back to the nearest valid corner) so sea/edge cells don't bleed.
    const fx = (lon - t.tieX) / t.scaleX;
    const fy = (t.tieY - lat) / t.scaleY;
    if (fx >= 0 && fx < t.width && fy >= 0 && fy < t.height) {
      const data = t.data;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, t.width - 1);
      const y1 = Math.min(y0 + 1, t.height - 1);
      const tx = fx - x0, ty = fy - y0;
      const at = (xx, yy) => {
        const v = data[yy * t.width + xx];
        if (v == null || !Number.isFinite(Number(v))) return null;
        if (t.noData != null && Number.isFinite(t.noData) && Number(v) === t.noData) return null;
        return Number(v);
      };
      const v00 = at(x0, y0), v10 = at(x1, y0), v01 = at(x0, y1), v11 = at(x1, y1);
      if (v00 == null && v10 == null && v01 == null && v11 == null) return null;
      if (v00 != null && v10 != null && v01 != null && v11 != null) {
        return (1 - tx) * (1 - ty) * v00 + tx * (1 - ty) * v10 + (1 - tx) * ty * v01 + tx * ty * v11;
      }
      return v00 ?? v10 ?? v01 ?? v11; // partial void near edge — nearest valid corner
    }
  }

  const insideCombined =
    lon >= _boundsLonMin - EPS &&
    lon <= _boundsLonMax + EPS &&
    lat >= _boundsLatMin - EPS &&
    lat <= _boundsLatMax + EPS;

  _outOfBoundsCount++;
  if (_outOfBoundsCount <= 5) {
    console.warn(`  [DEM] Out-of-bounds sample (lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}) - no tile covers this point. Returning null.`);
  } else if (_outOfBoundsCount === 6) {
    console.warn('  [DEM] Further out-of-bounds samples suppressed. Ensure road bbox is inside DEM extent.');
  }
  return null;
}

export function getOutOfBoundsCount() {
  return _outOfBoundsCount ?? 0;
}

export { sampleElevation };

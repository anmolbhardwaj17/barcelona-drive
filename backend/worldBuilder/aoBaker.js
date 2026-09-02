/**
 * aoBaker.js — bake-time hemispheric sky-visibility AO (the L3 unlock from
 * docs/context/visual-target-analysis.md §4).
 *
 * For every point of the tile's 128×128 elevation grid (SAME indices/orientation as
 * payload.elevation — row = south→north, col = west→east), compute the fraction of the sky
 * dome visible past the surrounding buildings and terrain. Narrow street canyons darken,
 * courtyards go moody, plazas and rooftops stay bright — at zero runtime cost.
 *
 * Method (2.5D horizon sampling):
 *   1. Rasterize building heights into a 2m grid covering the tile + RAY_RANGE margin
 *      (occluders pulled from the tile AND its 8 neighbours, deduped by id).
 *   2. From each sample point (ground elevation + EYE_HEIGHT), march AZIMUTHS rays outward
 *      in 2m steps to RAY_RANGE. Horizon tangent per step: (occluderTopY − eyeY) / d, where
 *      occluderTopY = terrain elevation at the step (bilinear on the tile grid, clamped at
 *      margins) + rasterized building height. Terrain-only steps contribute too, so steep
 *      ground (Montjuïc, the authored trench walls) self-shades for free.
 *   3. Slice sky visibility = cos²(horizon) = 1 / (1 + tan²)  (cosine-weighted diffuse sky).
 *      Sky-view factor = mean over azimuths → uint8 (255 = fully open sky).
 *
 * Output: Uint8Array(resolution²), row-major matching the elevation grid. The frontend
 * remaps svf → an AO multiplier with its own strength curve — this file stores PURE sky
 * visibility, no art tuning, so strength changes never need a re-bake.
 *
 * All XZ math happens in world coordinates (footprints are already world-relative metres —
 * buildingNormalize applies mercatorToWorld with Unstretch-X, 1 unit = 1 real metre).
 */

import { latLonToMercator, mercatorToWorld } from '../projection.js';

const AZIMUTHS = 16;         // horizon rays per sample point
const RAY_RANGE = 60;        // metres — occluders beyond this barely move the horizon
const RAY_STEP = 2;          // metres — matches the building raster cell size
const RASTER_CELL = 2;       // metres per building-raster cell
const EYE_HEIGHT = 1.5;      // sample the sky from head height, not the pavement

// ── CANOPY OCCLUSION ──────────────────────────────────────────────────────────────────────────
// Trees were never occluders here, which is why an avenue of plane trees leaves the road perfectly
// evenly lit — the loudest "this is not a place" tell in a daylight screenshot. They cannot be added
// via the runtime shadow pass: the vegetation pools are global BatchedMeshes with
// `frustumCulled = false` AND `perObjectFrustumCulled = false` (vegPools.js — per-instance culling
// was itself measured as a frame-killer), so a casting pool renders every LOD-visible tree rather
// than the forty near the camera. That was tried and recorded: "150k+ trees in the shadow pass
// tanked FPS (33→)".
//
// Baked, it costs nothing at runtime — the four AO shader sites already consume this attribute.
//
// ⚠ A CANOPY IS NOT A BUILDING. The march below takes a single max-tangent horizon, a binary
// sky/no-sky test that is right for masonry. Applied to leaves it would turn every avenue into a
// tunnel. So canopies march on their OWN horizon and are mixed at CANOPY_OPACITY: a ray stopped
// only by leaves keeps most of its sky.
// ⚠ 0.6 READ AS A PAINTED BLANKET, NOT AS SHADE. This term is AMBIENT occlusion — it darkens by
// how much SKY a point sees, with no direction in it. Under a continuous row of plane trees the sky
// is hidden everywhere, so a high value produces one flat dark slab with a hard edge at the crown
// line, which is what the user reported as unnatural. Real dappled shade is a DIRECTIONAL projection
// of the sun through gaps and cannot come from this term at any setting.
//
// So it is dialled to where it reads as "the air under a tree is dimmer" rather than "a shadow was
// painted here". Anything that actually dapples needs a baked directional pass at a fixed sun angle,
// which is a separate piece of work.
const CANOPY_OPACITY = 0.34; // 0 = leaves are glass, 1 = leaves are concrete
const CANOPY_MIN_H   = 3;    // m — a sapling does not shape the sky; same rule buildings get
// ⚠ OSM DOES NOT TAG TREE HEIGHT. Measured: 0 of 391 trees in the benchmark tile carry one, so the
// first run rasterised 419 cells across the whole city — about one per tile — and shaded nothing.
// The default is the signature Barcelona street tree from the card atlas manifest
// (`treeAtlas.js`, plane_pollarded: heightM 12, canopyM 9), which is also what the renderer draws,
// so the shade matches the tree instead of describing an imaginary one.
const CANOPY_DEFAULT_H = 12;
// Crown radius from trunk height. A 12 m plane tree carries roughly a 4.5 m radius crown; the clamp
// stops a mis-tagged height from painting a 20 m disc of shade.
const CANOPY_R_FRAC  = 0.38;
const CANOPY_R_MIN   = 2.0;
const CANOPY_R_MAX   = 7.0;

const _dirX = [], _dirZ = [];
for (let a = 0; a < AZIMUTHS; a++) {
  const th = (a / AZIMUTHS) * Math.PI * 2;
  _dirX.push(Math.cos(th)); _dirZ.push(Math.sin(th));
}

/** Point-in-polygon (ray cast) on a world-relative [[x,z],…] ring. */
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Bake one tile's AO grid.
 *
 * @param {object} elevation   payload.elevation ({resolution, data, south, west, north, east})
 * @param {Array}  buildings   occluder buildings (tile + neighbours, deduped) —
 *                             [{ id, footprint:[[x,z],…], height, layer }]
 * @returns {{ resolution: number, data: Uint8Array } | null}
 */
export function bakeAoGrid(elevation, buildings, trees) {
  const res = elevation?.resolution;
  const elev = elevation?.data;
  if (!res || !elev || elev.length !== res * res) return null;

  const { south, west, north, east } = elevation;

  // World corners of the tile. Mercator→world is affine and lat/lon→mercator is smooth, so a
  // per-tile linear lat/lon↔world map is exact to <0.1% over 500m — plenty for 2m AO cells.
  const toWorld = (lat, lon) => { const m = latLonToMercator(lat, lon); return mercatorToWorld(m.x, m.y); };
  const sw = toWorld(south, west), se = toWorld(south, east), nw = toWorld(north, west);
  const dWx_dLon = (se.x - sw.x) / (east - west);   // world-x per degree lon (sign carries the X-mirror)
  const dWz_dLat = (nw.z - sw.z) / (north - south); // world-z per degree lat

  // World→elevation-grid fraction (for bilinear terrain lookups along rays).
  const colOf = (wx) => ((wx - sw.x) / dWx_dLon) / (east - west) * (res - 1);
  const rowOf = (wz) => ((wz - sw.z) / dWz_dLat) / (north - south) * (res - 1);

  function elevAt(wx, wz) {
    let c = colOf(wx), r = rowOf(wz);
    if (c < 0) c = 0; else if (c > res - 1) c = res - 1;
    if (r < 0) r = 0; else if (r > res - 1) r = res - 1;
    const c0 = c | 0, r0 = r | 0;
    const c1 = c0 < res - 1 ? c0 + 1 : c0, r1 = r0 < res - 1 ? r0 + 1 : r0;
    const fc = c - c0, fr = r - r0;
    const e00 = elev[r0 * res + c0], e10 = elev[r0 * res + c1];
    const e01 = elev[r1 * res + c0], e11 = elev[r1 * res + c1];
    return (e00 * (1 - fc) + e10 * fc) * (1 - fr) + (e01 * (1 - fc) + e11 * fc) * fr;
  }

  // ── 1. Building-height raster over tile + margin ──────────────────────────
  const minWx = Math.min(sw.x, se.x) - RAY_RANGE, maxWx = Math.max(sw.x, se.x) + RAY_RANGE;
  const minWz = Math.min(sw.z, nw.z) - RAY_RANGE, maxWz = Math.max(sw.z, nw.z) + RAY_RANGE;
  const rw = Math.ceil((maxWx - minWx) / RASTER_CELL) + 1;
  const rh = Math.ceil((maxWz - minWz) / RASTER_CELL) + 1;
  const raster = new Float32Array(rw * rh); // building height above local ground; 0 = open
  const canopy = new Float32Array(rw * rh); // canopy top above local ground; 0 = open sky

  for (const b of buildings) {
    if (!b || (b.layer != null && b.layer < 0)) continue;         // underground — not an occluder
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    const h = Math.min(b.height || 0, 500);
    if (h < 3) continue;                                          // sheds don't shape the sky
    let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
    for (const p of fp) {
      if (p[0] < bMinX) bMinX = p[0]; if (p[0] > bMaxX) bMaxX = p[0];
      if (p[1] < bMinZ) bMinZ = p[1]; if (p[1] > bMaxZ) bMaxZ = p[1];
    }
    if (bMaxX < minWx || bMinX > maxWx || bMaxZ < minWz || bMinZ > maxWz) continue;
    const ci0 = Math.max(0, Math.floor((bMinX - minWx) / RASTER_CELL));
    const ci1 = Math.min(rw - 1, Math.ceil((bMaxX - minWx) / RASTER_CELL));
    const cj0 = Math.max(0, Math.floor((bMinZ - minWz) / RASTER_CELL));
    const cj1 = Math.min(rh - 1, Math.ceil((bMaxZ - minWz) / RASTER_CELL));
    for (let cj = cj0; cj <= cj1; cj++) {
      const cz = minWz + (cj + 0.5) * RASTER_CELL;
      for (let ci = ci0; ci <= ci1; ci++) {
        const cx = minWx + (ci + 0.5) * RASTER_CELL;
        if (pointInRing(cx, cz, fp)) {
          const k = cj * rw + ci;
          if (h > raster[k]) raster[k] = h;
        }
      }
    }
  }

  // ── 1b. Canopy raster — same grid, its own layer (see CANOPY_OPACITY) ─────
  let canopyCells = 0;
  for (const t of trees || []) {
    const pt = t && t.point;
    if (!pt) continue;
    const h = Math.min(Number.isFinite(t.height) && t.height > 0 ? t.height : CANOPY_DEFAULT_H, 40);
    if (h < CANOPY_MIN_H) continue;
    // Per-tree radius jitter. Every crown at exactly 0.38*h drew a row of identical discs, and the
    // union of identical discs has a mechanically even edge — half of why the band read as painted.
    // Hashed off the id so it is stable across bakes rather than random per run.
    const jit = ((Math.imul((t.id | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 8) & 0xffff) / 0xffff;
    const rad = Math.max(CANOPY_R_MIN,
      Math.min(CANOPY_R_MAX, h * CANOPY_R_FRAC * (0.72 + jit * 0.5)));
    const tx = pt[0], tz = pt[1];
    if (tx + rad < minWx || tx - rad > maxWx || tz + rad < minWz || tz - rad > maxWz) continue;
    const ci0 = Math.max(0, Math.floor((tx - rad - minWx) / RASTER_CELL));
    const ci1 = Math.min(rw - 1, Math.ceil((tx + rad - minWx) / RASTER_CELL));
    const cj0 = Math.max(0, Math.floor((tz - rad - minWz) / RASTER_CELL));
    const cj1 = Math.min(rh - 1, Math.ceil((tz + rad - minWz) / RASTER_CELL));
    const r2 = rad * rad;
    for (let cj = cj0; cj <= cj1; cj++) {
      const cz = minWz + (cj + 0.5) * RASTER_CELL;
      for (let ci = ci0; ci <= ci1; ci++) {
        const cx = minWx + (ci + 0.5) * RASTER_CELL;
        if ((cx - tx) * (cx - tx) + (cz - tz) * (cz - tz) > r2) continue;   // round crown, not its bbox
        const k = cj * rw + ci;
        if (h > canopy[k]) { if (canopy[k] === 0) canopyCells++; canopy[k] = h; }
      }
    }
  }

  // ── 2+3. Horizon march per grid point ─────────────────────────────────────
  const out = new Uint8Array(res * res);
  const steps = Math.floor(RAY_RANGE / RAY_STEP);
  for (let r = 0; r < res; r++) {
    const lat = south + (north - south) * (r / (res - 1));
    for (let c = 0; c < res; c++) {
      const lon = west + (east - west) * (c / (res - 1));
      const wx = sw.x + (lon - west) * dWx_dLon;
      const wz = sw.z + (lat - south) * dWz_dLat;
      const eyeY = elev[r * res + c] + EYE_HEIGHT;

      let svf = 0;
      for (let a = 0; a < AZIMUTHS; a++) {
        const dx = _dirX[a] * RAY_STEP, dz = _dirZ[a] * RAY_STEP;
        let px = wx, pz = wz, maxTan = 0, maxTanLeaf = 0;
        for (let s = 1; s <= steps; s++) {
          px += dx; pz += dz;
          const ci = ((px - minWx) / RASTER_CELL) | 0;
          const cj = ((pz - minWz) / RASTER_CELL) | 0;
          const inR = ci >= 0 && ci < rw && cj >= 0 && cj < rh;
          const k = inR ? cj * rw + ci : -1;
          const ground = elevAt(px, pz);
          if (k >= 0 && raster[k] > 0) {
            const t = (ground + raster[k] - eyeY) / (s * RAY_STEP);
            if (t > maxTan) maxTan = t;
          } else if (ground > eyeY) {                 // terrain-only horizon (slopes, trench walls)
            const t = (ground - eyeY) / (s * RAY_STEP);
            if (t > maxTan) maxTan = t;
          }
          // Leaves march their own horizon so they can be MIXED rather than switched.
          if (k >= 0 && canopy[k] > 0) {
            const tl = (ground + canopy[k] - eyeY) / (s * RAY_STEP);
            if (tl > maxTanLeaf) maxTanLeaf = tl;
          }
        }
        const openSolid = 1 / (1 + maxTan * maxTan);   // cos²(horizon) — cosine-weighted sky slice
        if (maxTanLeaf > maxTan) {
          const openLeaf = 1 / (1 + maxTanLeaf * maxTanLeaf);
          svf += openSolid * (1 - CANOPY_OPACITY) + openLeaf * CANOPY_OPACITY;
        } else {
          svf += openSolid;                            // masonry already closed this ray
        }
      }
      out[r * res + c] = Math.round((svf / AZIMUTHS) * 255);
    }
  }

  return { resolution: res, data: out, canopyCells };
}

/**
 * Occluder set for a tile: its own buildings + the 8 neighbours', deduped by id (buildings
 * spanning a tile edge are listed in both tiles by splitBuildingsByTile).
 */
export function gatherAoOccluders(tileId, buildingsByTile) {
  const [z, tx, ty] = tileId.split('_').map(Number);
  const seen = new Set();
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = buildingsByTile.get(`${z}_${tx + dx}_${ty + dy}`);
      if (!list) continue;
      for (const b of list) {
        const key = b.id != null ? b.id : b;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(b);
      }
    }
  }
  return out;
}

/**
 * Canopy occluders for a tile: its own trees + the 8 neighbours', deduped by id. Same 3x3 gather
 * the buildings get, and for the same reason — RAY_RANGE is 60 m, so a tree just over the tile edge
 * still shades ground inside it, and without the neighbours every tile would show a shading seam at
 * its border.
 */
export function gatherAoTrees(tileId, treesByTile) {
  const [z, tx, ty] = tileId.split('_').map(Number);
  const seen = new Set();
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = treesByTile.get(`${z}_${tx + dx}_${ty + dy}`);
      if (!list) continue;
      for (const t of list) {
        const key = t.id != null ? t.id : t;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
  }
  return out;
}

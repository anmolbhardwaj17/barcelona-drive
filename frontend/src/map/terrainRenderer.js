/**
 * Terrain mesh from DEM elevation grid and getElevationAt(lat, lon) with bilinear interpolation.
 * Uses ground_01 / ground_02 textures (40x40 repeat per tile), chosen deterministically per tile for seamless variation.
 * Vertices below SEA_LEVEL are clamped so terrain does not poke through water.
 * World elevation normalization: optional worldElevationOffset (spawn elevation) is subtracted so spawn is near Y=0.
 */
import * as THREE from 'three';
import { patchMaterial } from './materialRegistry.js';   // v3 P1-03
import * as CANNON from 'cannon-es';
import { latLonToWorld } from '../projection.js';
import { CONFIG } from '../config.js';
import { WATER_DEPTH, pointInWaterPolygon, polygonArea } from './waterRenderer.js';
const SEA_LEVEL = 0;
import { getWorldElevationOffset, assertElevationOffsetResolved } from '../elevationOffset.js';
import { createAoSampler, aoMultiplier, AO_TERRAIN_STRENGTH, bindAoScaleUniform } from './aoSampler.js';
import { coastSample, seaPolygonWorld } from './coastline.js';

// v3 P1-09: getTerrainDetailTexture() deleted — its only consumer was the non-rally shader
// branch, which is gone with the ?style=normal path. The 416 KB JPEG is no longer fetched at all.


function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function safeGet(grid, r, c, rows, cols) {
  const rr = Math.max(0, Math.min(rows - 1, r));
  const cc = Math.max(0, Math.min(cols - 1, c));
  const v = grid[rr * cols + cc];
  return v != null && Number.isFinite(v) ? v : 0;
}

function getElevationBicubic(elevation, lat, lon) {
  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
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
    const rowVals = cols.map((cc) => safeGet(elevations, rows[i], cc, gridRows, gridCols));
    vals.push(catmullRom(rowVals[0], rowVals[1], rowVals[2], rowVals[3], tc));
  }
  return catmullRom(vals[0], vals[1], vals[2], vals[3], tr);
}

function getElevationBilinear(elevation, lat, lon) {
  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
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
  const v00 = elevations[r0 * gridCols + c0] ?? 0;
  const v10 = elevations[r1 * gridCols + c0] ?? 0;
  const v01 = elevations[r0 * gridCols + c1] ?? 0;
  const v11 = elevations[r1 * gridCols + c1] ?? 0;
  return (1 - tr) * (1 - tc) * v00 + tr * (1 - tc) * v10 + (1 - tr) * tc * v01 + tr * tc * v11;
}

/**
 * Sample elevation at (lat, lon) from tile elevation grid. Bilinear or bicubic per CONFIG.terrainSamplingMode. Raw meters, no vertical exaggeration.
 * @param {object} elevation - { south, west, north, east, gridRows, gridCols, elevations: number[] }
 * @param {number} lat
 * @param {number} lon
 * @returns {number}
 */
export function getElevationFromGrid(elevation, lat, lon) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) return 0;
  const mode = CONFIG.terrainSamplingMode || 'bilinear';
  return mode === 'bicubic' ? getElevationBicubic(elevation, lat, lon) : getElevationBilinear(elevation, lat, lon);
}

/**
 * Build terrain mesh from elevation data. Grid: row 0 = south, col 0 = west; elevations row-major.
 * Uses ground_01 or ground_02 per tile (deterministic from tileKey) for seamless random variation.
 * Subtracts worldElevationOffset (spawn elevation) so spawn terrain is near Y=0.
 * @param {object} elevation - { south, west, north, east, gridRows, gridCols, elevations: number[] }
 * @param {string} [tileKey] - e.g. "0_0" for deterministic texture choice per tile
 * @returns {{ mesh: THREE.Mesh, getElevationAt: (lat: number, lon: number) => number }}
 */
/**
 * One-time log of the terrain path.
 *
 * v3 P4-01: there is only ONE path now. `bakedTerrain` is generated per tile from the elevation grid
 * in `tileParserWorker` (see `map/terrainGrid.js`), so the name is historical — it is the shape the
 * renderer consumes, not a claim that the mesh came off disk. The runtime fallback mesh, and the
 * separate water dip it applied, were deleted together: two mesh generators disagreeing about
 * water depth is the double-apply landmine P4-03 warns about.
 */
let _loggedTerrainPath = false;
export async function buildTerrainMesh(elevation, tileKey, tunnelRoads, roads, waterPolygons, yieldFn, bakedTerrain, aoGrid, beaches) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) {
    const noop = () => 0;
    return { mesh: null, getElevationAt: noop };
  }

  const offset = getWorldElevationOffset() ?? 0; // D-12: single spawn-anchored baseline; tileMinElevation gate removed
  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  // texIndex no longer used (stylized mode — no textures)
  const maxGrid = Math.min(CONFIG.TERRAIN_MAX_GRID ?? 15, 150);
  const rows = Math.min(gridRows, maxGrid);
  const cols = Math.min(gridCols, maxGrid);
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // ── Try pre-baked terrain mesh (skip vertex computation entirely) ──────
  const useBaked = bakedTerrain && bakedTerrain.gridSize === maxGrid
    && bakedTerrain.positions && bakedTerrain.normals && bakedTerrain.uvs && bakedTerrain.indices;

  // Pre-process water polygons — needed by both baked and fallback paths for vertex colors
  const waterPolys = (waterPolygons || []).filter(a => a.polygon && a.polygon.length >= 3 && polygonArea(a.polygon) >= 5000).map(a => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of a.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y;
      if (p.y > maxZ) maxZ = p.y;
    }
    return { ...a, minX, maxX, minZ, maxZ };
  });

  let geometry;
  let positions, totalVerts;

  if (useBaked) {
    // Use pre-baked arrays directly — positions, normals, uvs, indices all pre-computed
    positions = bakedTerrain.positions instanceof Float32Array
      ? bakedTerrain.positions
      : new Float32Array(bakedTerrain.positions);
    const normals = bakedTerrain.normals instanceof Float32Array
      ? bakedTerrain.normals
      : new Float32Array(bakedTerrain.normals);
    const uvs = bakedTerrain.uvs instanceof Float32Array
      ? bakedTerrain.uvs
      : new Float32Array(bakedTerrain.uvs);
    const indices = bakedTerrain.indices instanceof Uint32Array
      ? bakedTerrain.indices
      : new Uint32Array(bakedTerrain.indices);
    totalVerts = positions.length / 3;

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // v3 P4-02: stash the coarse rings on the geometry. They share this vertex buffer, so switching
    // ring is a setIndex + a draw-range change — no re-upload of positions/normals/uvs, which is the
    // whole reason LOD is done with index sets here rather than separate meshes.
    if (bakedTerrain.indicesMid && bakedTerrain.indicesFar) {
      geometry.userData.lodRings = {
        full: new THREE.BufferAttribute(indices, 1),
        mid: new THREE.BufferAttribute(bakedTerrain.indicesMid, 1),
        far: new THREE.BufferAttribute(bakedTerrain.indicesFar, 1),
      };
    }
  } else {
    // v3 P4-01: THE RUNTIME FALLBACK MESH IS GONE, and its water dip with it.
    //
    // It existed because `useBaked` could be false (bakedTerrain.gridSize !== TERRAIN_MAX_GRID).
    // Terrain is now GENERATED from the elevation grid in tileParserWorker for every tile, so the
    // only way to reach here is a tile with no readable grid AND no bake — which the guard at the
    // top of this function already turns into a null mesh.
    //
    // ⚠ THE WATER DIP HAD TO GO IN THE SAME COMMIT. This path pushed water vertices to
    // `seaLevelNorm + depthTarget` while the baker does not dip at all. Keeping a second mesh
    // generator with its own water treatment is precisely the double-apply landmine P4-03 warns
    // about: once P4-03 bakes the sea sink INTO the grid, a surviving runtime dip would subtract a
    // second time. The sea sink is P4-03's job, in the grid, once.
    console.warn('[terrain] no usable elevation grid or baked mesh for %s — skipping tile terrain', tileKey);
    return { mesh: null, getElevationAt: () => 0 };
  }

  if (yieldFn) await yieldFn();

  // ─── REMOVED 2026-08-27: the road-proximity grid was built for every tile and NEVER READ ───────
  //
  // `groundRoads`, `roadDistGrid` (a full uniform grid, one distance stamped per road segment into
  // every cell within 15 m) and the `minDistSqToRoads` / `distSqToSegment` helpers were computed on
  // every terrain build and consumed by nothing. It is the leftover of commit 3635fa6, "Remove dark
  // road-edge outline — drop the Delhi roadside dirt strip": the CONSUMER was deleted deliberately
  // (the brown roadside band was a Delhi artifact and is not wanted in Barcelona) and the producer
  // was left behind. The stale comment further down still claims "CPU vertex colors carry road-edge
  // brown", which is how this survived a reading of the file.
  //
  // Do NOT reinstate it to fix bare ground near roads — that ground is covered by the pavement, and
  // when it reads as a lawn the cause is LOD (D-72/D-74), not a missing tint.

  // Height-based and normal-based vertex colors with per-vertex noise variation.
  const posAttr = geometry.getAttribute('position');
  const normAttr = geometry.getAttribute('normal');
  const vCount = posAttr.count;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const y = posAttr.getY(i);
    if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  // Color range: ground level (Y=0) is the baseline. Negative Y = darker, positive Y = lighter.
  const yRange = Math.max(maxY - minY, 0.01);

  // Deterministic value noise — smooth, tileable, ~-1..+1 range
  function hash2(ix, iz) {
    let n = ix * 374761393 + iz * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  function smoothNoise(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + sx * (b - a) + sz * (c - a) + sx * sz * (a - b - c + d);
  }
  // Fractal noise: 2 octaves
  function terrainNoise(x, z, scale, seed) {
    const s = scale || 0.02;
    const ox = seed * 137.3, oz = seed * 259.7;
    return smoothNoise((x + ox) * s, (z + oz) * s) * 0.65
         + smoothNoise((x + ox) * s * 2.3, (z + oz) * s * 2.3) * 0.35;
  }

  const colors = new Float32Array(vCount * 3);
  // Baked sky-visibility AO (v9) → per-vertex colour multiplier. The final value (strength curve
  // already applied) lives in the attribute so the shader stays a single multiply; pre-v9 tiles
  // get a constant 1.0 (attribute always present → shared shader program).
  const svfAt = createAoSampler(aoGrid, elevation);
  const aoAttr = new Float32Array(vCount).fill(1);

  // ── Coast painting (terrain-tinted beach + sea) ──────────────────────────
  // The open sea has NO OSM water polygon (only enclosed basins like marinas do) and flat beach
  // MESHES get buried under sloping terrain — so the coast is painted INTO the terrain colours:
  // sand inside natural=beach polygons (wet band near the waterline), deep sea blue wherever the
  // raw DEM says water (SRTM bakes open sea at 0 m). aCoast masks the procedural green shader off
  // these vertices so it can't repaint them. Gated on the tile actually touching sea level or
  // carrying beach polys, so inland lowlands never trigger it.
  const SEA_RAW = 0.15;   // raw DEM metres — at/below = open water, BUT ONLY NEAR THE COAST (N-50)
  /**
   * How close to the coastline a below-sea-level vertex must be before depth alone marks it as sea.
   * Barcelona's shore is the only place real ground sits at 0 m; anything else at that height inland
   * is something we DUG — a trench carve — and painting it blue turns a road cut into a canal.
   */
  const SEA_DEPTH_NEEDS_COAST_M = 120;
  const beachPolys = (beaches || []).filter((f) => !f.isLine && f.polygon?.length >= 3).map((f) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of f.polygon) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
    }
    return { polygon: f.polygon, minX, maxX, minZ, maxZ };
  });
  // The DEM is USELESS for the open sea here (Copernicus GLO-30 bakes it at 2–5.8 m — measured),
  // so the authoritative sea signal is the shared traced coastline (coastline.js — same polygon
  // the map draws). Elevation-based detection stays only for SUNK harbour basins (baked to −2.5).
  let seaTileGate = false;
  {
    const c1 = latLonToWorld(elevation.south, elevation.west);
    const c2 = latLonToWorld(elevation.north, elevation.east);
    const sp = seaPolygonWorld();
    let sMinX = Infinity, sMaxX = -Infinity, sMinZ = Infinity, sMaxZ = -Infinity;
    for (const p of sp) {
      if (p.x < sMinX) sMinX = p.x; if (p.x > sMaxX) sMaxX = p.x;
      if (p.z < sMinZ) sMinZ = p.z; if (p.z > sMaxZ) sMaxZ = p.z;
    }
    const tMinX = Math.min(c1.x, c2.x), tMaxX = Math.max(c1.x, c2.x);
    const tMinZ = Math.min(c1.z, c2.z), tMaxZ = Math.max(c1.z, c2.z);
    seaTileGate = tMaxX >= sMinX && tMinX <= sMaxX && tMaxZ >= sMinZ && tMinZ <= sMaxZ;
  }
  const coastEnabled = seaTileGate || beachPolys.length > 0 || (Number.isFinite(elevation.min) && elevation.min <= SEA_RAW);
  const coastAttr = new Float32Array(vCount);

  // Distance-to-sea grid (in cells) for the AUTO-BEACH band: OSM beach polygons are sparse, so any
  // low-lying land within ~16 m of open sea gets sand even without a polygon (user call — "be
  // smart, have some beach next to sea"). 5-pass dilation over the 128×128 grid, ~4 m/cell.
  const SEA_DIST_MAX = 5;
  const SEA_FLOOD = 0.9;   // metres — the DEM box-blur lifts near-shore sea cells above SEA_RAW, so
                           // the sea FLOOD-FILLS through the blurred band up to this height. Only
                           // cells CONNECTED to definite sea flood — inland low pockets stay land.
  let seaDist = null, distRC = null;
  if (coastEnabled && Number.isFinite(elevation.min) && elevation.min <= SEA_RAW) {
    const res = elevation.gridCols, resR = elevation.gridRows;
    const src = elevation.elevations;
    seaDist = new Uint8Array(resR * res).fill(255);
    // Seeds: definite sea (raw ≤ SEA_RAW) anywhere, plus low TILE-EDGE cells (< SEA_FLOOD) so a
    // tile whose entire shore band was blur-lifted still receives the sea from its neighbour.
    const queue = [];
    for (let i = 0; i < seaDist.length; i++) {
      if (src[i] == null || !Number.isFinite(src[i])) continue;
      const rr = (i / res) | 0, cc = i % res;
      const edge = rr === 0 || rr === resR - 1 || cc === 0 || cc === res - 1;
      if (src[i] <= SEA_RAW || (edge && src[i] < SEA_FLOOD)) { seaDist[i] = 0; queue.push(i); }
    }
    // BFS flood through the blurred shore band.
    for (let qi = 0; qi < queue.length; qi++) {
      const k = queue[qi];
      const rr = (k / res) | 0, cc = k % res;
      const nbrs = [rr > 0 ? k - res : -1, rr < resR - 1 ? k + res : -1, cc > 0 ? k - 1 : -1, cc < res - 1 ? k + 1 : -1];
      for (const nk of nbrs) {
        if (nk < 0 || seaDist[nk] === 0) continue;
        const e = src[nk];
        if (e != null && Number.isFinite(e) && e < SEA_FLOOD) { seaDist[nk] = 0; queue.push(nk); }
      }
    }
    // Distance-from-sea dilation (for the auto-beach band).
    for (let pass = 1; pass <= SEA_DIST_MAX; pass++) {
      for (let rr = 0; rr < resR; rr++) {
        for (let cc = 0; cc < res; cc++) {
          const k = rr * res + cc;
          if (seaDist[k] !== 255) continue;
          const n0 = rr > 0 ? seaDist[k - res] : 255, n1 = rr < resR - 1 ? seaDist[k + res] : 255;
          const n2 = cc > 0 ? seaDist[k - 1] : 255, n3 = cc < res - 1 ? seaDist[k + 1] : 255;
          if (Math.min(n0, n1, n2, n3) === pass - 1) seaDist[k] = pass;
        }
      }
    }
    // world → grid (row, col) affine — same linearization as aoSampler (exact to <0.1% per tile).
    const swW = latLonToWorld(elevation.south, elevation.west);
    const seW = latLonToWorld(elevation.south, elevation.east);
    const nwW = latLonToWorld(elevation.north, elevation.west);
    const colPerX = (res - 1) / (seW.x - swW.x);
    const rowPerZ = (resR - 1) / (nwW.z - swW.z);
    distRC = (wx, wz) => {
      let c = (wx - swW.x) * colPerX, r = (wz - swW.z) * rowPerZ;
      if (c < 0) c = 0; else if (c > res - 1) c = res - 1;
      if (r < 0) r = 0; else if (r > resR - 1) r = resR - 1;
      return seaDist[Math.round(r) * res + Math.round(c)];
    };
  }
  const inBeachPoly = (x, z) => {
    for (const bp of beachPolys) {
      if (x < bp.minX || x > bp.maxX || z < bp.minZ || z > bp.maxZ) continue;
      let inside = false;
      const poly = bp.polygon;
      for (let pi = 0, pj = poly.length - 1; pi < poly.length; pj = pi++) {
        const xi = poly[pi].x, zi = poly[pi].y, xj = poly[pj].x, zj = poly[pj].y;
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };

  const COLOR_BATCH = 2048;
  for (let i = 0; i < vCount; i++) {
    if (yieldFn && i > 0 && i % COLOR_BATCH === 0) await yieldFn();
    const y = posAttr.getY(i);
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    if (svfAt) {
      // Guard: some vertices carry NaN positions (G-06 elevation grid holes) — NaN would ride the
      // attribute into the shader and black out triangles. Fall back to "no AO".
      // SLOPE SCALE: steep faces (trench walls along the Rondas, Montjuïc cuts) are already
      // side-lit dark by Lambert — full AO on top read as broad chocolate bands flanking the
      // trenched carriageways (the long "dark border lines" hunt). Walls get ~35% of the AO.
      const svf = svfAt(vx, vz);
      if (Number.isFinite(svf)) {
        // (read the normal directly — `ny` is declared further down this loop, TDZ trap)
        let nyAO = normAttr ? normAttr.getY(i) : 1;
        // Baked sea tiles carry ONE EDGE ROW of NaN normals (degenerate flat triangles at the
        // seam). Math.max(0, NaN) = NaN → poisoned aAO → NaN renders WHITE: this was the giant
        // white wall over the sea (_findWhiteTiles: aAO NaN×128 on 4 tiles = one grid row each).
        // Sanitize the normal itself too — NaN normals also corrupt Lambert lighting.
        if (!Number.isFinite(nyAO)) {
          nyAO = 1;
          if (normAttr) { normAttr.setXYZ(i, 0, 1, 0); normAttr.needsUpdate = true; }
        }
        const slopeK = 0.35 + 0.65 * Math.max(0, nyAO);   // 1 = flat ground gets full AO
        const v = 1 - (1 - aoMultiplier(svf, AO_TERRAIN_STRENGTH)) * slopeK;
        aoAttr[i] = Number.isFinite(v) ? v : 1;           // belt & braces — NaN must never reach the GPU
      } else {
        aoAttr[i] = 1;
      }
    }
    const ny = normAttr ? normAttr.getY(i) : 1;
    // t: 0 at ground (Y=0), negative below, positive above
    const t = y / Math.max(Math.abs(minY), Math.abs(maxY), 0.01);
    const normalFactor = 0.85 + 0.15 * Math.max(0, ny);

    // ── Large soft grass color patches (4 colors blended via low-freq noise) ──
    // Cooler, fresher greens (was dusty warm Delhi olive → read yellowish/weird against the art-of-rally palette).
    const GRASS_A = [0.21, 0.41, 0.21]; // fresh green (deep — warm sun + ACES washes lighter values yellow)
    const GRASS_B = [0.17, 0.35, 0.18]; // mid green
    const GRASS_C = [0.13, 0.29, 0.15]; // darker green
    const GRASS_D = [0.19, 0.38, 0.20]; // sage green

    // Very low frequency noise → large blobs (~30-60m patches)
    const patchNoise1 = terrainNoise(vx, vz, 0.007, 3.0);  // huge patches
    const patchNoise2 = terrainNoise(vx, vz, 0.018, 4.0);  // medium patches
    // Combine into 0-1 range
    const pn = (patchNoise1 * 0.6 + patchNoise2 * 0.4) * 0.5 + 0.5; // 0..1

    // Blend between 4 grass colors using the patch noise
    let r, g, b;
    if (pn < 0.25) {
      const s = pn / 0.25;
      r = GRASS_C[0] + s * (GRASS_B[0] - GRASS_C[0]);
      g = GRASS_C[1] + s * (GRASS_B[1] - GRASS_C[1]);
      b = GRASS_C[2] + s * (GRASS_B[2] - GRASS_C[2]);
    } else if (pn < 0.5) {
      const s = (pn - 0.25) / 0.25;
      r = GRASS_B[0] + s * (GRASS_D[0] - GRASS_B[0]);
      g = GRASS_B[1] + s * (GRASS_D[1] - GRASS_B[1]);
      b = GRASS_B[2] + s * (GRASS_D[2] - GRASS_B[2]);
    } else if (pn < 0.75) {
      const s = (pn - 0.5) / 0.25;
      r = GRASS_D[0] + s * (GRASS_A[0] - GRASS_D[0]);
      g = GRASS_D[1] + s * (GRASS_A[1] - GRASS_D[1]);
      b = GRASS_D[2] + s * (GRASS_A[2] - GRASS_D[2]);
    } else {
      const s = (pn - 0.75) / 0.25;
      r = GRASS_A[0] + s * (GRASS_B[0] - GRASS_A[0]);
      g = GRASS_A[1] + s * (GRASS_B[1] - GRASS_A[1]);
      b = GRASS_A[2] + s * (GRASS_B[2] - GRASS_A[2]);
    }

    // Height influence: darken below ground, lighten at elevation
    if (t < 0) {
      const s = Math.min(1, -t) * 0.3;
      r -= s * 0.10; g -= s * 0.14; b -= s * 0.08;
    } else if (t > 0.3) {
      const s = Math.min(1, (t - 0.3) / 0.7) * 0.15;
      r += s * 0.08; g += s * 0.06; b += s * 0.10;
    }

    // Small detail noise for micro-variation
    const detailNoise = terrainNoise(vx, vz, 0.06, 2.0);
    r += detailNoise * 0.025;
    g += detailNoise * 0.035;
    b += detailNoise * 0.015;

    // Normal-based shading
    r = Math.max(0, Math.min(1, r * normalFactor));
    g = Math.max(0, Math.min(1, g * normalFactor));
    b = Math.max(0, Math.min(1, b * normalFactor));

    // Dirt patches — irregular worn soil areas using a separate noise layer
    const dirtNoise = terrainNoise(vx, vz, 0.08, 5.0); // ~4-10m patches
    if (dirtNoise > 0.2) {
      const dirtStrength = Math.min(1, (dirtNoise - 0.2) / 0.30) * 0.2; // subtler (was 0.38) — less tan wash
      r = r * (1 - dirtStrength) + 0.40 * dirtStrength; // cooler, greyer soil (was warm tan 0.48/0.42/0.30)
      g = g * (1 - dirtStrength) + 0.40 * dirtStrength;
      b = b * (1 - dirtStrength) + 0.32 * dirtStrength;
    }

    // Roadside dark-dirt strip REMOVED — it painted a dark-brown band (heaviest right at the edge)
    // along every road, which read as an unwanted thin dark outline in Barcelona. Terrain now meets
    // roads cleanly with no edge line. (The shader dark-tint amplify only fires on already-dark verts
    // like tree shadows, so with no road-edge darkening there's nothing to amplify at road edges.)

    // Sandy/dusty shore near water bodies (12m band, smooth falloff)
    if (waterPolys.length > 0) {
      let minWaterDist = Infinity;
      for (const area of waterPolys) {
        // Quick bbox check with margin
        if (vx < area.minX - 15 || vx > area.maxX + 15 || vz < area.minZ - 15 || vz > area.maxZ + 15) continue;
        const poly = area.polygon;
        for (let pi = 0, pj = poly.length - 1; pi < poly.length; pj = pi++) {
          const ax = poly[pi].x, az = poly[pi].y;
          const bx = poly[pj].x, bz = poly[pj].y;
          const edx = bx - ax, edz = bz - az;
          const lenSq = edx * edx + edz * edz;
          let et = lenSq > 0 ? ((vx - ax) * edx + (vz - az) * edz) / lenSq : 0;
          et = Math.max(0, Math.min(1, et));
          const d = Math.hypot(vx - (ax + et * edx), vz - (az + et * edz));
          if (d < minWaterDist) minWaterDist = d;
        }
      }
      if (minWaterDist < 12) {
        const t = 1 - minWaterDist / 12;
        const shoreNoise = terrainNoise(vx, vz, 0.12, 7.0) * 0.3;
        const strength = (t * t) * (0.6 + shoreNoise); // sandy band with noise variation
        // Sandy brown: (0.62, 0.54, 0.38)
        r = r * (1 - strength) + 0.62 * strength;
        g = g * (1 - strength) + 0.54 * strength;
        b = b * (1 - strength) + 0.38 * strength;
      }
    }

    // ── Coast override: sea / beach sand / bare shoreline (see block above the loop) ──
    if (coastEnabled) {
      // Raw DEM metres. Generated and baked positions both carry raw Y — vertExag and the offset
      // are folded into the mesh transform below, never into the vertices (v3 P4-01: the fallback
      // path that pre-applied them is gone, so this no longer branches).
      const raw = y;
      const dSea = distRC ? distRC(vx, vz) : 255;
      const inBeach = inBeachPoly(vx, vz);
      const cs = seaTileGate ? coastSample(vx, vz) : null;
      const shoreD = cs ? cs.dist : Infinity;
      // ── N-50 · BELOW SEA LEVEL IS NOT THE SEA ─────────────────────────────────────────────────
      // `raw <= SEA_RAW` used to be enough on its own, which reads as "any ground at or under 0.15 m
      // is open water". That was safe while the terrain was only ever the DEM. It stopped being safe
      // when the trench carve started digging road cuts INTO the grid: a tunnel at layer −4 puts the
      // carved floor below zero, and the whole cut then painted as deep Mediterranean blue. The user
      // photographed it twice at Glòries — a road trench rendering as a canal.
      //
      // Sea is a PLACE, not an altitude. So the bare depth test now also has to be near the coast;
      // the coastline and sea-polygon tests above are unchanged and still carry the real waterline.
      const deepAndCoastal = raw <= SEA_RAW && dSea <= SEA_DEPTH_NEEDS_COAST_M;
      if ((cs && cs.sea && !inBeach) || dSea === 0 || deepAndCoastal) {
        // Open sea — deep desaturated Mediterranean blue (mid-dark: the grade brightens), with a
        // whisper of large-scale variation so it doesn't read as one flat poster fill.
        const sn = terrainNoise(vx, vz, 0.012, 13.0) * 0.03;
        let sr = 0.050 + sn * 0.5;
        let sg = 0.165 + sn;
        let sb = 0.270 + sn;
        // Smooth waterline (user report: hard per-vertex cut read as a sawtooth): the first ~10 m
        // of water blends from wet sand into full sea instead of switching in one vertex.
        const t = Math.min(1, shoreD / 10);
        r = 0.400 * (1 - t) + sr * t;
        g = 0.345 * (1 - t) + sg * t;
        b = 0.245 * (1 - t) + sb * t;
        coastAttr[i] = 1;
      } else if (inBeach || shoreD <= 32 || (raw < 2.2 && dSea <= 4)) {
        // Sand coverage 0..1 with SOFT edges — the binary in/out test read as a stepped cutout
        // against the grass (user report). Beach-polygon edges use 5-point coverage sampling;
        // the shore band fades out over ~8 m with a noise-jittered boundary so the grass line
        // wanders organically instead of tracing the polygon.
        let sandF = 0;
        if (inBeach) {
          let hits = 1;
          if (inBeachPoly(vx + 3.5, vz)) hits++;
          if (inBeachPoly(vx - 3.5, vz)) hits++;
          if (inBeachPoly(vx, vz + 3.5)) hits++;
          if (inBeachPoly(vx, vz - 3.5)) hits++;
          sandF = hits / 5;
        }
        const edgeJitter = terrainNoise(vx, vz, 0.05, 17.0) * 5;
        if (shoreD < 26 + edgeJitter) {
          sandF = Math.max(sandF, Math.min(1, (26 + edgeJitter - shoreD) / 8));
        }
        if (!sandF && raw < 2.2 && dSea <= 4) sandF = 1;   // sunk-basin band (harbours)
        if (sandF > 0) {
          const wet = Math.max(
            raw < 1.0 ? 1 - (raw - SEA_RAW) / (1.0 - SEA_RAW) : 0,
            shoreD < 24 ? 1 - shoreD / 24 : 0,
          );
          const sn = terrainNoise(vx, vz, 0.09, 11.0) * 0.045;
          const dr = 0.545 + sn, dg = 0.480 + sn * 0.8, db = 0.335 + sn * 0.5;
          const sr = dr * (1 - wet) + 0.400 * wet;
          const sg2 = dg * (1 - wet) + 0.345 * wet;
          const sb2 = db * (1 - wet) + 0.245 * wet;
          r = r * (1 - sandF) + sr * sandF;
          g = g * (1 - sandF) + sg2 * sandF;
          b = b * (1 - sandF) + sb2 * sandF;
          coastAttr[i] = sandF;
        }
      } else if (raw < SEA_RAW + 0.6) {
        // Non-beach waterline (port aprons, breakwaters) — partial wet-grey blend so the sea
        // doesn't butt straight into bright green.
        const s2 = (1 - (raw - SEA_RAW) / 0.6) * 0.7;
        r = r * (1 - s2) + 0.38 * s2;
        g = g * (1 - s2) + 0.36 * s2;
        b = b * (1 - s2) + 0.30 * s2;
        coastAttr[i] = s2;
      }
    }

    colors[i * 3]     = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aAO', new THREE.BufferAttribute(aoAttr, 1));
  geometry.setAttribute('aCoast', new THREE.BufferAttribute(coastAttr, 1));
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.FrontSide, // terrain is viewed from above — cull the rear-facing half (was DoubleSide, doubled fragment cost)
    depthWrite: true,
    fog: true,
    flatShading: true, // faceted low-poly hills — each DEM triangle a distinct shade (v3 P1-09)
  });

  // Inject world-space procedural terrain coloring + texture detail into shader.
  // Vertex colors provide coarse base; the shader adds per-pixel Delhi-style
  // macro patches, micro variation, soil blotches, and fiber texture detail
  // all sampled in world space for seamless cross-tile continuity.
  // v3 P1-03: the base cache key must be set BEFORE patchMaterial, which captures it and appends
  // its patch tags. Assigning it AFTER (as this did) clobbers the composed key — the same
  // last-writer-wins bug the registry exists to stop, just in the cache key instead of the shader.
  material.customProgramCacheKey = () => 'terrainBcnLush';
  patchMaterial(material, (shader) => {
    shader.uniforms.detailScale = { value: 0.07 };
    bindAoScaleUniform(shader);

    // --- Vertex: pass world position + baked AO + coast mask to fragment ---
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      attribute float aAO;
      attribute float aCoast;
      varying float vAo;
      varying float vCoast;
      varying vec3 vWorldPos;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vAo = aAO;
      vCoast = aCoast;
      vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

    // --- Fragment: procedural terrain color + fiber texture ---
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying float vAo;
      varying float vCoast;
      varying vec3 vWorldPos;
      uniform float uAoScale;
      uniform float detailScale;

      // GPU hash noise — matches CPU terrainNoise for consistency
      float hash2f(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float smoothNoise2D(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash2f(i);
        float b = hash2f(i + vec2(1.0, 0.0));
        float c = hash2f(i + vec2(0.0, 1.0));
        float d = hash2f(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      // Fractal noise, 0..1 range. Rally uses ONE octave (half the ALU) — the ground is flat-shaded and
      // clean in rally, so the 2nd-octave fine detail isn't visible; the biome-patch STRUCTURE (all 5
      // layers below) is unchanged, just slightly smoother within each patch. Non-rally keeps 2 octaves.
      float terrainFBM(vec2 p) {
        return smoothNoise2D(p);   // v3 P1-09: rally path, now unconditional
      }`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>

      vec2 wPos = vWorldPos.xz;

      // ── Lush Mediterranean park palette (replaces the DELHI dust palette — its khaki/dry-straw at 75%
      //    dominance over vertex colours WAS the persistent yellow ground; no CPU-side green survived it) ──
      // RICH saturated greens (low-poly reference: olive-lime highlights → deep forest shadow) —
      // green channel dominant, red/blue suppressed. Plain uniform darkening just read as dimmed.
      vec3 lushGrass = vec3(0.20, 0.42, 0.13);
      vec3 midGreen  = vec3(0.15, 0.34, 0.11);
      vec3 deepGreen = vec3(0.09, 0.24, 0.08);
      vec3 sageGreen = vec3(0.25, 0.39, 0.13);   // olive-lime accent
      vec3 drySoil   = vec3(0.36, 0.31, 0.205);  // sparse worn patches only
      vec3 roadDirt  = vec3(0.32, 0.29, 0.205);

      // ── 1. Macro: large 80-150m patches — deep vs lush green ──
      float macroN = terrainFBM(wPos * 0.007 + 17.0);
      float macroHard = smoothstep(0.30, 0.42, macroN);
      vec3 terrainBase = mix(deepGreen, lushGrass, macroHard);
      // Second macro layer: sage variation
      float macro2 = terrainFBM(wPos * 0.004 + 43.0);
      float sageHard = smoothstep(0.35, 0.50, macro2);
      terrainBase = mix(terrainBase, sageGreen, sageHard * 0.5);

      // ── 2. Medium patches: 20-40m — mid-green mottling ──
      float medN = terrainFBM(wPos * 0.03 + 71.0);
      float medHard = smoothstep(0.35, 0.55, medN);
      terrainBase = mix(terrainBase, midGreen, medHard * 0.6);

      // ── 3. Micro variation: 5-10m patchiness (gentle — lawns, not scrubland) ──
      float microN = terrainFBM(wPos * 0.10 + 53.0);
      terrainBase *= 0.88 + microN * 0.24;

      // ── 4. Sparse worn-soil blotches ──
      float soilN = terrainFBM(wPos * 0.018 + 91.0);
      float soilBlend = smoothstep(0.55, 0.75, soilN) * 0.22;
      terrainBase = mix(terrainBase, drySoil, soilBlend);

      // ── 5. Blend with vertex colors — procedural dominates at 75% ──
      // CPU vertex colors carry tree shadow and water shore. (They no longer carry "road-edge
      // brown" — that consumer was deleted in 3635fa6 with the Delhi dirt strip, and this line
      // claiming otherwise is why its dead producer survived until 2026-08-27. See the note above.)
      // vCoast masks the greens OFF sand/sea vertices — the coast is CPU-painted (beach polys +
      // sea-level detection) and the procedural pass must not repaint it.
      diffuseColor.rgb = mix(diffuseColor.rgb, terrainBase, 0.75 * (1.0 - vCoast));

      // ── 6. Detect CPU road-edge dark tint and amplify (softened) ──
      // Gated off the coast too — the deep sea blue is dark and would muddy toward roadDirt.
      float vertLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
      float darkBlend = smoothstep(0.40, 0.28, vertLuma) * 0.35 * (1.0 - vCoast);
      diffuseColor.rgb = mix(diffuseColor.rgb, roadDirt, darkBlend);

      // ── 7. Ground micro-detail ── v3 P1-09: the shipped look uses a constant dim instead of a
      //    per-pixel fiber fetch, which saves one texture sample over ALL ground. The alternative
      //    branch that did the fetch is deleted with the non-rally path (decisions.md D-20), and
      //    with it the 416 KB JPEG it sampled. P3 replaces this constant with a real tiling
      //    terrain material from the art library.
      diffuseColor.rgb *= 0.98;

      // ── 8. Baked sky-visibility AO (v9) — street canyons darken, plazas stay bright ──
      // vAo is a MULTIPLIER (1 = open sky); uAoScale softens it under the night rig.
      diffuseColor.rgb *= (1.0 - (1.0 - vAo) * uAoScale);`
    );
  }, 'terrain');

  const mesh = new THREE.Mesh(geometry, material);
  if (useBaked) {
    // Stage-2 co-frame. Baked VISUAL positions are raw-absolute DEM (vertExag/offset NOT applied at bake —
    // terrainBaker.js:71). Shift the whole mesh so rendered Y matches the physics trimesh
    // (tileManager.js:838 → (y-offset)*vertExag) and the normalized roads:
    //   scale.y folds in vertExag, position.y folds in the spawn-anchored offset
    //   → rendered Y = bakedRawDEM·vertExag − offset·vertExag = (rawDEM − offset)·vertExag.
    // The tile build is GATED on the resolved offset (processTileData → whenElevationOffsetReady), so the
    // value is correct the first time — set ONCE, no self-heal callback. assert = fail-fast if the gate broke.
    const off = assertElevationOffsetResolved('terrainRenderer.buildTerrainMesh(useBaked)');
    mesh.scale.y = vertExag;
    mesh.position.y = -off * vertExag;
    if (!_loggedTerrainPath) { _loggedTerrainPath = true; console.log(`[Terrain] gridSize=${bakedTerrain.gridSize}, offset=${off.toFixed(1)} — mesh generated from the elevation grid (v3 P4-01)`); }
  }
  mesh.castShadow = false;
  mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
  mesh.frustumCulled = true;

  // ── Baked-terrain sampler ────────────────────────────────────────────────────────────────────────
  // getElevationAt must return the SAME height the ground is rendered + simulated at. The baked mesh
  // positions carry the DEM *with tunnel carving + water dips applied*; the raw `elevation` grid does
  // NOT — so reading the grid made buildings/colliders/scenery FLOAT over any carved or dipped area
  // (the big floating-building bug). Sample the baked positions directly instead.
  // Layout (terrainBaker): vi = r*cols + c, x linear in column (xWest + c*xStep), z constant per row.
  let _bakedSample = null;
  if (useBaked && positions && positions.length >= 12) {
    const n = positions.length / 3;
    const z0 = positions[2];
    let cols = 1;
    while (cols < n && positions[cols * 3 + 2] === z0) cols++;
    const rows = (cols >= 2 && n % cols === 0) ? n / cols : 0;
    const xStep = rows >= 2 ? (positions[(cols - 1) * 3] - positions[0]) / (cols - 1) : 0;
    if (rows >= 2 && Math.abs(xStep) > 1e-9) {
      const xW = positions[0];
      const zRow = new Float64Array(rows);
      for (let r = 0; r < rows; r++) zRow[r] = positions[(r * cols) * 3 + 2];
      const zAsc = zRow[rows - 1] >= zRow[0];
      _bakedSample = (wx, wz) => {
        let fc = (wx - xW) / xStep;
        if (fc < 0) fc = 0; else if (fc > cols - 1) fc = cols - 1;
        const c0 = fc | 0, c1 = c0 + 1 < cols ? c0 + 1 : c0, cf = fc - c0;
        let lo = 0, hi = rows - 1;                        // binary-search the row band (zRow monotonic)
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((zRow[mid] <= wz) === zAsc) lo = mid; else hi = mid; }
        const zSpan = zRow[hi] - zRow[lo];
        let rf = zSpan !== 0 ? (wz - zRow[lo]) / zSpan : 0;
        if (rf < 0) rf = 0; else if (rf > 1) rf = 1;
        const y00 = positions[(lo * cols + c0) * 3 + 1], y01 = positions[(lo * cols + c1) * 3 + 1];
        const y10 = positions[(hi * cols + c0) * 3 + 1], y11 = positions[(hi * cols + c1) * 3 + 1];
        const yT = y00 + (y01 - y00) * cf, yB = y10 + (y11 - y10) * cf;
        return yT + (yB - yT) * rf;
      };
    }
  }

  /** Normalized elevation (DEM - worldElevationOffset). Sampled from the BAKED mesh (carving + water
   *  baked in) so buildings/colliders sit on the ACTUAL ground; falls back to the raw grid. */
  function getElevationAt(lat, lon) {
    if (_bakedSample) {
      const w = latLonToWorld(lat, lon);
      const y = _bakedSample(w.x, w.z);
      if (Number.isFinite(y)) return y - offset;
    }
    const raw = getElevationFromGrid(elevation, lat, lon);
    return raw - offset;
  }

  return { mesh, getElevationAt };
}

/**
 * Build a Cannon heightfield body for a tile's DEM. Same grid and coordinate space as buildTerrainMesh.
 * Used for physics so RaycastVehicle wheels raycast against terrain. No mesh colliders.
 * @param {object} elevation - { south, west, north, east, gridRows, gridCols, elevations: number[] }
 * @param {string} [tileKey] - unused, for API consistency
 * @returns {{ body: CANNON.Body } | null}
 */
export async function buildTerrainHeightfield(elevation, tileKey, yieldFn) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) return null;
  const offset = getWorldElevationOffset() ?? 0; // D-12: single spawn-anchored baseline; tileMinElevation gate removed
  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  // FULL source grid — no downsampling. The old `min(gridRows, TERRAIN_MAX_GRID)` clamp kept
  // 64-range indices but the index math below reads `meshRow * gridCols + colSrc` against the
  // 128-wide source grid, which sampled only the SW QUADRANT of the tile stretched across the
  // whole tile — the actual "heightfield trapped the car below ground" bug behind the D-16
  // physics revert. Full grid = identical data to the visual mesh, co-framed by construction.
  const rows = gridRows;
  const cols = gridCols;
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  // If tunnel carving produced negative elevations, lower the floor so they aren't clamped
  let hfMinElev = 0;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (v != null && Number.isFinite(v) && v < hfMinElev) hfMinElev = v;
  }
  const seaLevelNorm = hfMinElev < 0 ? (hfMinElev - offset) * vertExag : SEA_LEVEL - offset * vertExag;

  // Same normalization as buildTerrainMesh: (raw - offset) * vertExag so heightfield world Y matches terrain mesh vertex Y.
  // Height matrix: data[xi][yi] with xi = x_index (col), yi = z_index (row) -> elevation at (x,z).
  // Cannon Heightfield: data[xi][yi] -> local (xi*elementSize, yi*elementSize); -PI/2 X rotation -> local +Y = world -Z.
  // Mesh: r=0 = south (min Z), r=rows-1 = north (max Z). Row 0 of matrix at body origin.
  //
  // IMPORTANT: Columns are REVERSED (east→west) so the heightfield extends in +local_X
  // which maps to +world_X, matching the physics coordinate system where X is negated
  // (car X = -(worldX - originX)). Body position is set to the east-side world X so
  // that after negation in tileManager the heightfield covers the correct range.
  const data = [];
  // Stats folded into this loop (was a SECOND full 16k pass) + budget yields every 16 columns —
  // this build was part of the "p1 physics" chunk tag.
  let hfMin = Infinity, hfMax = -Infinity, hfNeg = 0;
  for (let c = 0; c < cols; c++) {
    data[c] = [];
    const colSrc = cols - 1 - c; // reversed: data[0] = east, data[cols-1] = west
    for (let r = 0; r < rows; r++) {
      const meshRow = rows - 1 - r;
      const idx = meshRow * gridCols + colSrc;
      let y = elevations[idx] != null && Number.isFinite(elevations[idx]) ? elevations[idx] : 0;
      y = (y - offset) * vertExag;
      y = Math.max(y, seaLevelNorm);
      data[c][r] = y;
      if (y < hfMin) hfMin = y;
      if (y > hfMax) hfMax = y;
      if (y < -0.1) hfNeg++;
    }
    if (yieldFn && (c & 15) === 15) await yieldFn();
  }
  const westSouth = latLonToWorld(south, west);
  const eastSouth = latLonToWorld(south, east);
  const westNorth = latLonToWorld(north, west);
  const worldWidthX = Math.abs(eastSouth.x - westSouth.x);
  const worldWidthZ = Math.abs(westNorth.z - westSouth.z);
  const stepX = cols > 1 ? worldWidthX / (cols - 1) : worldWidthX;
  const stepZ = rows > 1 ? worldWidthZ / (rows - 1) : worldWidthZ;
  const elementSize = (stepX + stepZ) / 2;

  // (stats folded into the build loop above)

  const heightfieldShape = new CANNON.Heightfield(data, { elementSize });
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(heightfieldShape);
  // Position at east-side X (will be negated in tileManager to match car coords)
  body.position.set(eastSouth.x, 0, westNorth.z);
  // Rotation applied AFTER addShape. Cannon Heightfield: local XY plane, Z = height. Y-up world: local Z -> world Y.
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);

  return { body };
}

/**
 * Compute world AABB for a body whose first shape is a Heightfield (Cannon's Heightfield.calculateWorldAABB is infinite).
 * @param {CANNON.Body} body - body with shapes[0] = Heightfield
 * @returns {{ lowerBound: CANNON.Vec3, upperBound: CANNON.Vec3 } | null}
 */
export function getHeightfieldWorldAABB(body) {
  if (!body?.shapes?.length) return null;
  const shape = body.shapes[0];
  if (shape.type !== CANNON.Shape.types.HEIGHTFIELD) return null;
  const data = shape.data;
  const elementSize = shape.elementSize;
  const width = (data.length - 1) * elementSize;
  const depth = (data[0].length - 1) * elementSize;
  const minH = shape.minValue ?? 0;
  const maxH = shape.maxValue ?? 0;
  const offset = body.shapeOffsets?.[0]
    ? new CANNON.Vec3(body.shapeOffsets[0].x, body.shapeOffsets[0].y, body.shapeOffsets[0].z)
    : new CANNON.Vec3(0, 0, 0);
  const corners = [
    new CANNON.Vec3(offset.x, offset.y, minH),
    new CANNON.Vec3(offset.x + width, offset.y, minH),
    new CANNON.Vec3(offset.x, offset.y + depth, minH),
    new CANNON.Vec3(offset.x + width, offset.y + depth, minH),
    new CANNON.Vec3(offset.x, offset.y, maxH),
    new CANNON.Vec3(offset.x + width, offset.y, maxH),
    new CANNON.Vec3(offset.x, offset.y + depth, maxH),
    new CANNON.Vec3(offset.x + width, offset.y + depth, maxH),
  ];
  const world = new CANNON.Vec3();
  let lx = Infinity; let ly = Infinity; let lz = Infinity;
  let ux = -Infinity; let uy = -Infinity; let uz = -Infinity;
  for (const p of corners) {
    body.quaternion.vmult(p, world);
    world.vadd(body.position, world);
    lx = Math.min(lx, world.x); ly = Math.min(ly, world.y); lz = Math.min(lz, world.z);
    ux = Math.max(ux, world.x); uy = Math.max(uy, world.y); uz = Math.max(uz, world.z);
  }
  return {
    lowerBound: new CANNON.Vec3(lx, ly, lz),
    upperBound: new CANNON.Vec3(ux, uy, uz),
  };
}

/**
 * Darken terrain vertices near tree positions (ground shadow patches).
 * Called after vegetation phase when tree positions are known.
 */
export function darkenTerrainAroundTrees(mesh, treePositions) {
  if (!mesh || !treePositions?.length) return;
  const geo = mesh.geometry;
  const posAttr = geo.getAttribute('position');
  const colorAttr = geo.getAttribute('color');
  if (!posAttr || !colorAttr) return;

  const RADIUS = 6;
  const RADIUS_SQ = RADIUS * RADIUS;

  // Simple spatial hash for tree positions (cell size = RADIUS)
  const cellSize = RADIUS;
  const treeGrid = new Map();
  for (const tp of treePositions) {
    const cx = Math.floor(tp.x / cellSize);
    const cz = Math.floor(tp.z / cellSize);
    const key = `${cx},${cz}`;
    if (!treeGrid.has(key)) treeGrid.set(key, []);
    treeGrid.get(key).push(tp);
  }

  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i), vz = posAttr.getZ(i);
    const cx = Math.floor(vx / cellSize);
    const cz = Math.floor(vz / cellSize);

    let closest = Infinity;
    // Check 3x3 neighborhood
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = treeGrid.get(`${cx + dx},${cz + dz}`);
        if (!cell) continue;
        for (const tp of cell) {
          const d = (vx - tp.x) ** 2 + (vz - tp.z) ** 2;
          if (d < closest) closest = d;
        }
      }
    }

    if (closest < RADIUS_SQ) {
      const t = 1 - Math.sqrt(closest / RADIUS_SQ);
      const strength = t * t * 0.50; // quadratic falloff, max 50% blend
      const cr = colorAttr.getX(i), cg = colorAttr.getY(i), cb = colorAttr.getZ(i);
      // Brownish earth tone under trees — leaf litter / exposed soil
      colorAttr.setXYZ(i,
        cr * (1 - strength) + 0.45 * strength,
        cg * (1 - strength) + 0.38 * strength,
        cb * (1 - strength) + 0.25 * strength);
    }
  }
  colorAttr.needsUpdate = true;
}








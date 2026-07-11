/**
 * Terrain mesh from DEM elevation grid and getElevationAt(lat, lon) with bilinear interpolation.
 * Uses ground_01 / ground_02 textures (40x40 repeat per tile), chosen deterministically per tile for seamless variation.
 * Vertices below SEA_LEVEL are clamped so terrain does not poke through water.
 * World elevation normalization: optional worldElevationOffset (spawn elevation) is subtracted so spawn is near Y=0.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { latLonToWorld } from '../projection.js';
import { CONFIG } from '../config.js';
import { WATER_DEPTH, pointInWaterPolygon, polygonArea } from './waterRenderer.js';
const SEA_LEVEL = 0;
import { getWorldElevationOffset, assertElevationOffsetResolved } from '../elevationOffset.js';
import { isRallyStyle } from '../rallyStyle.js';
import { createAoSampler, aoMultiplier, AO_TERRAIN_STRENGTH, bindAoScaleUniform } from './aoSampler.js';

/** No-op stubs kept for API compatibility. */
export function loadTerrainGroundTextures() { return Promise.resolve([]); }
export function getTerrainTextureIndexForTile() { return 0; }

// World-space terrain detail texture — grayscale fiber for fine ground detail over vertex colors
let _terrainDetailTex = null;
function getTerrainDetailTexture() {
  if (_terrainDetailTex) return _terrainDetailTex;
  _terrainDetailTex = new THREE.TextureLoader().load('/textures/terrain/grass.15f2422c.jpg');
  _terrainDetailTex.wrapS = THREE.RepeatWrapping;
  _terrainDetailTex.wrapT = THREE.RepeatWrapping;
  _terrainDetailTex.minFilter = THREE.LinearMipmapLinearFilter;
  _terrainDetailTex.magFilter = THREE.LinearFilter;
  _terrainDetailTex.anisotropy = 4;
  return _terrainDetailTex;
}


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
// --- Helpers for road-proximity terrain coloring ---
function distSqToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 0.001) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + t * dx, cz = az + t * dz;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

function minDistSqToRoads(roads, x, z) {
  let best = Infinity;
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distSqToSegment(x, z, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d < best) best = d;
      if (best < 1) return best; // early exit
    }
  }
  return best;
}

/** One-time log of which terrain path is live (useBaked = pre-baked mesh vs runtime fallback). */
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
  } else {
  // ── Fallback: compute terrain mesh at runtime ─────────────────────────
  // If tunnel carving produced negative elevations, lower the floor so they aren't clamped
  let minElev = 0;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (v != null && Number.isFinite(v) && v < minElev) minElev = v;
  }
  const seaLevelNorm = minElev < 0 ? (minElev - offset) * vertExag : SEA_LEVEL - offset * vertExag;

  // --- Optimized world-coordinate computation ---
  // x is exactly linear in longitude (Mercator x = R * lonRad).
  // z is nonlinear in latitude — precompute one per row (128 trig calls instead of 16,384).
  const { x: xWest, z: zWest } = latLonToWorld(south, west);
  const { x: xEast } = latLonToWorld(south, east);
  const xStep = cols > 1 ? (xEast - xWest) / (cols - 1) : 0;
  const zPerRow = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const lat = south + (north - south) * (rows <= 1 ? 0.5 : r / (rows - 1));
    zPerRow[r] = latLonToWorld(lat, west).z;
  }

  totalVerts = rows * cols;
  positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const ROW_BATCH = 16; // yield every 16 rows
  for (let r = 0; r < rows; r++) {
    const z = zPerRow[r];
    for (let c = 0; c < cols; c++) {
      const x = xWest + c * xStep;
      const vi = (r * cols + c);
      // Map downsampled grid (rows×cols) back to source grid (gridRows×gridCols)
      const srcR = rows >= gridRows ? r : Math.min(gridRows - 1, Math.round(r / (rows - 1) * (gridRows - 1)));
      const srcC = cols >= gridCols ? c : Math.min(gridCols - 1, Math.round(c / (cols - 1) * (gridCols - 1)));
      const idx = srcR * gridCols + srcC;
      let y = elevations[idx] != null && Number.isFinite(elevations[idx]) ? elevations[idx] : 0;
      y = (y - offset) * vertExag;
      y = Math.max(y, seaLevelNorm);
      // Depress terrain under water bodies with smooth edge falloff
      if (waterPolys.length > 0) {
        for (const area of waterPolys) {
          // Fast bounding box rejection
          if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) continue;
          if (pointInWaterPolygon(x, z, area.polygon)) {
            // Find distance to nearest polygon edge for smooth falloff
            const poly = area.polygon;
            let minEdgeDist = Infinity;
            for (let pi = 0, pj = poly.length - 1; pi < poly.length; pj = pi++) {
              const ax = poly[pi].x, az = poly[pi].y;
              const bx = poly[pj].x, bz = poly[pj].y;
              const dx = bx - ax, dz = bz - az;
              const lenSq = dx * dx + dz * dz;
              let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
              t = Math.max(0, Math.min(1, t));
              const px = ax + t * dx, pz = az + t * dz;
              const d = Math.hypot(x - px, z - pz);
              if (d < minEdgeDist) minEdgeDist = d;
            }
            // Single smooth curve from edge to full depth — avoids grid staircase artifacts
            const MAX_DEPTH = -2.0;
            const DEPTH_ZONE = 20; // full depth reached 20m from edge — wide enough to hide grid steps
            const t = Math.min(1, minEdgeDist / DEPTH_ZONE);
            const smooth = t * t * (3 - 2 * t); // smoothstep
            const depthTarget = MAX_DEPTH * smooth;
            // Relative to the NORMALIZED sea level, NOT absolute. The old `y = depthTarget` forced water
            // vertices to ~-2 absolute while land sat at (grid-offset)≈-60 → ~72m up-cones (El Raval).
            // seaLevelNorm = (0-offset)*vertExag, so water dips just below normalized sea, flush with coast.
            y = seaLevelNorm + depthTarget;
            break;
          }
        }
      }
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = cols <= 1 ? 0.5 : c / (cols - 1);
      uvs[vi * 2 + 1] = rows <= 1 ? 0.5 : 1 - r / (rows - 1);
    }
    if (yieldFn && (r + 1) % ROW_BATCH === 0) await yieldFn();
  }

  // FALLBACK PATH (runtime mesh). Exercised ONLY when useBaked is false (bakedTerrain.gridSize !==
  // CONFIG.TERRAIN_MAX_GRID). With TERRAIN_MAX_GRID=64 matching the bake's gridSize, useBaked is now
  // TRUE and this path is bypassed (the pre-baked mesh renders). Historically this path WAS live
  // (gridSize 64 ≠ TERRAIN_MAX_GRID 32) and its absolute water-depth (see below, ~line 246) produced
  // the El Raval water cones. Terrain hole-punching is baked in terrainBaker.js for the useBaked path.
  // Keep this path correct (water depth is offset-relative) so it is not a latent landmine if re-enabled.
  //
  // Punch terrain holes at TRUE portal transition points only — where a surface approach road
  // descends into the tunnel. Using tunnel road endpoints caused holes at EVERY mid-tunnel
  // segment junction (the Ronda Litoral has ~15 segments = ~30 scattered holes).
  //
  // Hole radius: halfW + PORTAL_WING + HOLE_OVERLAP to match portal frame geometry.
  // Constants must stay in sync with tunnelRenderer.js (PORTAL_WING=3, WALL_EXTRA_WIDTH=1).
  const PORTAL_WING  = 3;    // sync: tunnelRenderer.js PORTAL_WING
  const WALL_EXTRA   = 1;    // sync: tunnelRenderer.js WALL_EXTRA_WIDTH
  const HOLE_OVERLAP = 0.5;
  const tunnelMouths = [];

  // approachRoads is passed via the tunnelRoads param (tileManager passes combined list)
  // but we only want holes at approach road deep endpoints — derive from combined list:
  if (tunnelRoads && tunnelRoads.length > 0) {
    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const hw = (road.width || 4) / 2 + WALL_EXTRA;
      const r  = hw + PORTAL_WING + HOLE_OVERLAP;
      const eFirst = pts[0].elevation ?? -6;
      const eLast  = pts[pts.length - 1].elevation ?? -6;
      // Approach roads have one end near surface (≥-0.5m) and one end deep (<-2m).
      // The deep end is the portal mouth — punch hole there.
      // Pure mid-tunnel roads have BOTH ends at -6m → skip (no surface hole needed).
      const hasShallowEnd = eFirst >= -0.5 || eLast >= -0.5;
      if (!hasShallowEnd) continue; // pure mid-tunnel segment — no portal hole
      // Punch hole at the deep end (portal transition into enclosed tunnel)
      if (eFirst < -1.5) tunnelMouths.push({ x: pts[0].x, z: pts[0].y, r });
      if (eLast  < -1.5) tunnelMouths.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, r });
    }
  }
  function inTunnelZone(wx, wz) {
    for (const m of tunnelMouths) {
      if (Math.hypot(wx - m.x, wz - m.z) < m.r) return true;
    }
    return false;
  }

  const indices = [];
  const DEGEN_EPS = 1e-10;
  const hasTunnels = tunnelMouths.length > 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const c1 = (r + 1) * cols + c;
      const d = c1 + 1;
      const triArea = (i0, i1, i2) => {
        const ax = positions[i0 * 3] - positions[i1 * 3], az = positions[i0 * 3 + 2] - positions[i1 * 3 + 2];
        const bx = positions[i2 * 3] - positions[i1 * 3], bz = positions[i2 * 3 + 2] - positions[i1 * 3 + 2];
        return Math.abs(ax * bz - az * bx) * 0.5;
      };
      if (triArea(a, c1, b) > DEGEN_EPS) {
        if (hasTunnels) {
          const cx1 = (positions[a*3] + positions[c1*3] + positions[b*3]) / 3;
          const cz1 = (positions[a*3+2] + positions[c1*3+2] + positions[b*3+2]) / 3;
          if (!inTunnelZone(cx1, cz1)) indices.push(a, c1, b);
        } else {
          indices.push(a, c1, b);
        }
      }
      if (triArea(b, c1, d) > DEGEN_EPS) {
        if (hasTunnels) {
          const cx2 = (positions[b*3] + positions[c1*3] + positions[d*3]) / 3;
          const cz2 = (positions[b*3+2] + positions[c1*3+2] + positions[d*3+2]) / 3;
          if (!inTunnelZone(cx2, cz2)) indices.push(b, c1, d);
        } else {
          indices.push(b, c1, d);
        }
      }
    }
  }

  if (yieldFn) await yieldFn();

  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  } // end fallback

  if (yieldFn) await yieldFn();

  // Filter roads to ground-level only (exclude tunnels and elevated)
  const groundRoads = roads?.filter(r =>
    !r.tunnel && (r.layer == 0 || r.layer == null)
  ) || null;

  // --- Build spatial grid for fast road-proximity lookups ---
  // Replaces O(V × S) brute-force with O(V × ~4 nearby segments)
  let roadDistGrid = null;
  let rdgMinX, rdgMinZ, rdgCols, rdgRows, rdgCellSize;
  if (groundRoads && groundRoads.length > 0) {
    rdgCellSize = 8; // metres per cell
    rdgMinX = positions[0]; rdgMinZ = positions[2];
    let rdgMaxX = rdgMinX, rdgMaxZ = rdgMinZ;
    for (let i = 0; i < totalVerts; i++) {
      const px = positions[i * 3], pz = positions[i * 3 + 2];
      if (px < rdgMinX) rdgMinX = px; if (px > rdgMaxX) rdgMaxX = px;
      if (pz < rdgMinZ) rdgMinZ = pz; if (pz > rdgMaxZ) rdgMaxZ = pz;
    }
    rdgMinX -= 1; rdgMinZ -= 1; rdgMaxX += 1; rdgMaxZ += 1;
    rdgCols = Math.ceil((rdgMaxX - rdgMinX) / rdgCellSize) + 1;
    rdgRows = Math.ceil((rdgMaxZ - rdgMinZ) / rdgCellSize) + 1;
    roadDistGrid = new Float32Array(rdgCols * rdgRows);
    roadDistGrid.fill(Infinity);

    // For each road segment, stamp minimum distance into nearby grid cells
    const OUTER_SQ = 15 * 15; // only care about distances < 15m
    for (const road of groundRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      for (let si = 0; si < pts.length - 1; si++) {
        const ax = pts[si].x, az = pts[si].y, bx = pts[si + 1].x, bz = pts[si + 1].y;
        const sMinX = Math.min(ax, bx) - 15, sMaxX = Math.max(ax, bx) + 15;
        const sMinZ = Math.min(az, bz) - 15, sMaxZ = Math.max(az, bz) + 15;
        const c0 = Math.max(0, Math.floor((sMinX - rdgMinX) / rdgCellSize));
        const c1 = Math.min(rdgCols - 1, Math.floor((sMaxX - rdgMinX) / rdgCellSize));
        const r0 = Math.max(0, Math.floor((sMinZ - rdgMinZ) / rdgCellSize));
        const r1 = Math.min(rdgRows - 1, Math.floor((sMaxZ - rdgMinZ) / rdgCellSize));
        for (let gr = r0; gr <= r1; gr++) {
          for (let gc = c0; gc <= c1; gc++) {
            const gx = rdgMinX + (gc + 0.5) * rdgCellSize;
            const gz = rdgMinZ + (gr + 0.5) * rdgCellSize;
            const dSq = distSqToSegment(gx, gz, ax, az, bx, bz);
            const gi = gr * rdgCols + gc;
            if (dSq < roadDistGrid[gi]) roadDistGrid[gi] = dSq;
          }
        }
      }
    }
  }

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
  const SEA_RAW = 0.15;   // raw DEM metres — at/below = open water
  const beachPolys = (beaches || []).filter((f) => !f.isLine && f.polygon?.length >= 3).map((f) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of f.polygon) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
    }
    return { polygon: f.polygon, minX, maxX, minZ, maxZ };
  });
  const coastEnabled = beachPolys.length > 0 || (Number.isFinite(elevation.min) && elevation.min <= SEA_RAW);
  const coastAttr = new Float32Array(vCount);
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
      const svf = svfAt(vx, vz);
      aoAttr[i] = Number.isFinite(svf) ? aoMultiplier(svf, AO_TERRAIN_STRENGTH) : 1;
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
      // Raw DEM metres: baked positions carry raw Y; the fallback path already applied offset+exag.
      const raw = useBaked ? y : (y / vertExag + offset);
      if (raw <= SEA_RAW) {
        // Open sea — deep desaturated Mediterranean blue (mid-dark: the grade brightens), with a
        // whisper of large-scale variation so it doesn't read as one flat poster fill.
        const sn = terrainNoise(vx, vz, 0.012, 13.0) * 0.03;
        r = 0.050 + sn * 0.5;
        g = 0.165 + sn;
        b = 0.270 + sn;
        coastAttr[i] = 1;
      } else if (inBeachPoly(vx, vz)) {
        // Dry sand, blending toward wet sand as it approaches the waterline.
        const wet = raw < 1.0 ? 1 - (raw - SEA_RAW) / (1.0 - SEA_RAW) : 0;
        const sn = terrainNoise(vx, vz, 0.09, 11.0) * 0.045;
        const dr = 0.545 + sn, dg = 0.480 + sn * 0.8, db = 0.335 + sn * 0.5;
        r = dr * (1 - wet) + 0.400 * wet;
        g = dg * (1 - wet) + 0.345 * wet;
        b = db * (1 - wet) + 0.245 * wet;
        coastAttr[i] = 1;
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

  const terrainDetailTex = getTerrainDetailTexture();
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.FrontSide, // terrain is viewed from above — cull the rear-facing half (was DoubleSide, doubled fragment cost)
    depthWrite: true,
    fog: true,
    flatShading: isRallyStyle(), // rally: faceted low-poly hills (each DEM triangle a distinct shade)
  });

  // Inject world-space procedural terrain coloring + texture detail into shader.
  // Vertex colors provide coarse base; the shader adds per-pixel Delhi-style
  // macro patches, micro variation, soil blotches, and fiber texture detail
  // all sampled in world space for seamless cross-tile continuity.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.terrainDetailTex = { value: terrainDetailTex };
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
      uniform sampler2D terrainDetailTex;
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
        return ${isRallyStyle() ? 'smoothNoise2D(p)' : 'smoothNoise2D(p) * 0.65 + smoothNoise2D(p * 2.3) * 0.35'};
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
      // CPU vertex colors carry road-edge brown, tree shadow, water shore.
      // vCoast masks the greens OFF sand/sea vertices — the coast is CPU-painted (beach polys +
      // sea-level detection) and the procedural pass must not repaint it.
      diffuseColor.rgb = mix(diffuseColor.rgb, terrainBase, 0.75 * (1.0 - vCoast));

      // ── 6. Detect CPU road-edge dark tint and amplify (softened) ──
      // Gated off the coast too — the deep sea blue is dark and would muddy toward roadDirt.
      float vertLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
      float darkBlend = smoothstep(0.40, 0.28, vertLuma) * 0.35 * (1.0 - vCoast);
      diffuseColor.rgb = mix(diffuseColor.rgb, roadDirt, darkBlend);

      // ── 7. Fiber texture micro-detail ── (rally keeps the ground flat/clean, so skip the per-pixel
      //    texture fetch entirely and use a constant dim ≈ the old average — saves a sample over all ground)
      ${isRallyStyle()
        ? 'diffuseColor.rgb *= 0.98;'
        : `vec2 fiberUV = wPos * detailScale;
           float fiber = texture2D(terrainDetailTex, fiberUV).r;
           diffuseColor.rgb *= 0.70 + fiber * 0.52;`}

      // ── 8. Baked sky-visibility AO (v9) — street canyons darken, plazas stay bright ──
      // vAo is a MULTIPLIER (1 = open sky); uAoScale softens it under the night rig.
      diffuseColor.rgb *= (1.0 - (1.0 - vAo) * uAoScale);`
    );
  };
  material.customProgramCacheKey = () => 'terrainBcnLush' + (isRallyStyle() ? '_rally' : '');

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
    if (!_loggedTerrainPath) { _loggedTerrainPath = true; console.log(`[Terrain] useBaked=TRUE — rendering pre-baked mesh (gridSize=${bakedTerrain.gridSize}, offset=${off.toFixed(1)})`); }
  } else {
    // Fallback (runtime-computed) path already bakes (raw-offset)*vertExag into positions — keep at origin.
    mesh.position.set(0, 0, 0);
    if (!_loggedTerrainPath) { _loggedTerrainPath = true; console.warn(`[Terrain] useBaked=FALSE — runtime FALLBACK mesh (bakedTerrain.gridSize=${bakedTerrain?.gridSize} ≠ maxGrid=${maxGrid}); water cones possible.`); }
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
export function buildTerrainHeightfield(elevation, tileKey) {
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
    }
  }
  const westSouth = latLonToWorld(south, west);
  const eastSouth = latLonToWorld(south, east);
  const westNorth = latLonToWorld(north, west);
  const worldWidthX = Math.abs(eastSouth.x - westSouth.x);
  const worldWidthZ = Math.abs(westNorth.z - westSouth.z);
  const stepX = cols > 1 ? worldWidthX / (cols - 1) : worldWidthX;
  const stepZ = rows > 1 ? worldWidthZ / (rows - 1) : worldWidthZ;
  const elementSize = (stepX + stepZ) / 2;

  // Log heightfield data stats
  let hfMin = Infinity, hfMax = -Infinity, hfNeg = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = data[c][r];
      if (v < hfMin) hfMin = v;
      if (v > hfMax) hfMax = v;
      if (v < -0.1) hfNeg++;
    }
  }

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








/**
 * terrainBaker.js
 *
 * Pre-bakes terrain mesh geometry and physics collision mesh at build time.
 * Ported from frontend terrainRenderer.js (buildTerrainMesh) and
 * tileManager.js (createTerrainTrimesh) — same algorithms, no Three.js/CANNON deps.
 */
import { latLonToMercator, mercatorToWorld, mercatorToLatLon } from '../projection.js';

// BCN_DIMS.APPROACH_RAMP_CUT_MARGIN — synced from frontend/src/map/barcelona-constants.js.
// Extra width beyond road half-width excluded from terrain mesh along approach ramps.
// 2.5m gives clearance for 0.4m retaining walls + geometry margin.
const APPROACH_RAMP_CUT_MARGIN = 1.5; // corridor halfW = road.width/2 + this (was 2.5 → hole much wider than road)

/**
 * Convert lat/lon to world coordinates (same as frontend latLonToWorld).
 */
function latLonToWorld(lat, lon) {
  const m = latLonToMercator(lat, lon);
  return mercatorToWorld(m.x, m.y);
}

// ─── Visual terrain mesh (64×64) ─────────────────────────────────────────────

/**
 * Pre-compute a 64×64 terrain visual mesh from elevation data.
 *
 * @param {object} elevation - { south, west, north, east, gridRows, gridCols, elevations: number[] }
 * @param {object[]} [tunnelRoads] - roads with tunnel=true, points as [[x, yUp, z], ...]
 * @param {object[]} [waterPolygons] - water polygons (unused for now, reserved)
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array, gridSize: number, vertExag: number }}
 */
export function bakeTerrainMesh(elevation, tunnelRoads, waterPolygons, approachRoads, crossTileApproaches) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) {
    return null;
  }

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  // 128 = the full bake elevation grid (TERRAIN_GRID) → NO downsample, so the visual mesh equals the DEM
  // grid the roads bake against (demSampler) → roads conform (no "road inside terrain" in dips). Must match
  // CONFIG.TERRAIN_MAX_GRID (the useBaked gate is bakedTerrain.gridSize === maxGrid). Extras off → budget free.
  const GRID_SIZE = 128;
  const rows = Math.min(gridRows, GRID_SIZE);
  const cols = Math.min(gridCols, GRID_SIZE);
  const vertExag = 1.0;

  // Optimized world-coordinate computation (same as frontend):
  // x is linear in longitude, z is nonlinear in latitude — precompute per row.
  const swWorld = latLonToWorld(south, west);
  const seWorld = latLonToWorld(south, east);
  const xWest = swWorld.x;
  const xStep = cols > 1 ? (seWorld.x - xWest) / (cols - 1) : 0;

  const zPerRow = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const lat = south + (north - south) * (rows <= 1 ? 0.5 : r / (rows - 1));
    zPerRow[r] = latLonToWorld(lat, west).z;
  }

  const totalVerts = rows * cols;
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);

  for (let r = 0; r < rows; r++) {
    const z = zPerRow[r];
    for (let c = 0; c < cols; c++) {
      const x = xWest + c * xStep;
      const vi = r * cols + c;

      // Map downsampled grid back to source grid for elevation sampling
      const srcR = rows <= 1 ? 0 : Math.min(gridRows - 1, Math.round(r / (rows - 1) * (gridRows - 1)));
      const srcC = cols <= 1 ? 0 : Math.min(gridCols - 1, Math.round(c / (cols - 1) * (gridCols - 1)));
      const idx = srcR * gridCols + srcC;
      let y = elevations[idx] != null && Number.isFinite(elevations[idx]) ? elevations[idx] : 0;
      y = y * vertExag;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;

      uvs[vi * 2] = cols <= 1 ? 0.5 : c / (cols - 1);
      uvs[vi * 2 + 1] = rows <= 1 ? 0.5 : 1 - r / (rows - 1);
    }
  }

  // Tunnel mouth punching — circular holes at PORTAL endpoints only.
  // Previously punched at ALL tunnel endpoints (including mid-tunnel junctions).
  // Punching at junctions creates terrain holes that expose underground portal frame
  // geometry as "random gates" visible from inside the tunnel.
  // Fix: reuse the same portal-detection logic (endpoint count=1) that Source A uses.
  const MOUTH_RADIUS = 1;
  const JUNCTION_TOL_MOUTH = 3; // same as Source A JUNCTION_TOL
  const tunnelMouths = [];
  if (tunnelRoads && tunnelRoads.length > 0) {
    // Pre-compute endpoint counts to identify true portals vs mid-tunnel junctions
    const _mouthHashEp = (x, z) =>
      `${Math.round(x / JUNCTION_TOL_MOUTH)},${Math.round(z / JUNCTION_TOL_MOUTH)}`;
    const _mouthEpCount = new Map();
    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const fp = mercatorToWorld(pts[0][0], pts[0][2]);
      const lp = mercatorToWorld(pts[pts.length - 1][0], pts[pts.length - 1][2]);
      const hf = _mouthHashEp(fp.x, fp.z), hl = _mouthHashEp(lp.x, lp.z);
      _mouthEpCount.set(hf, (_mouthEpCount.get(hf) || 0) + 1);
      _mouthEpCount.set(hl, (_mouthEpCount.get(hl) || 0) + 1);
    }
    const _isMouthPortal = (x, z) => (_mouthEpCount.get(_mouthHashEp(x, z)) || 0) === 1;

    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const hw = (road.width || 4) / 2 + 1;
      const fp = mercatorToWorld(pts[0][0], pts[0][2]);
      const lp = mercatorToWorld(pts[pts.length - 1][0], pts[pts.length - 1][2]);
      // Only punch mouth circles at TRUE PORTAL endpoints (count=1), not interior junctions
      if (_isMouthPortal(fp.x, fp.z)) tunnelMouths.push({ x: fp.x, z: fp.z, r: hw + MOUTH_RADIUS });
      if (_isMouthPortal(lp.x, lp.z)) tunnelMouths.push({ x: lp.x, z: lp.z, r: hw + MOUTH_RADIUS });
    }
  }

  function inTunnelZone(wx, wz) {
    for (const m of tunnelMouths) {
      if (Math.hypot(wx - m.x, wz - m.z) < m.r) return true;
    }
    return false;
  }

  // Approach ramp terrain corridor strips.
  // Two sources of corridor segments, combined:
  //
  // Source A — Tunnel portal corridors (primary, handles all tunnel types including OSM tunnels
  //   with no explicit approach ramp way). For each TRUE portal endpoint (not shared with
  //   another tunnel segment = not a mid-tunnel junction), generate an 80m corridor outward.
  //   "True portal" = endpoint that appears in exactly ONE tunnel road = surface transition.
  //
  // Source B — Explicit approach roads with negative elevation (for tunnels that DO have a
  //   dedicated ramp road in OSM tagged with elevation data). Covers both descent and ascent.
  //   Note: Barcelona coastal tunnels mostly use Source A (no OSM ramp road, abrupt transition).

  const TRENCH_LEN = 25; // metres of terrain cut from each portal face (was 80 → cut ran far past the ramp). Tight mouth; the tunnel then runs under continuous terrain.
  const JUNCTION_TOL = 3; // metres — endpoint snap tolerance for junction detection
  const approachSegments = [];

  // ── Phase B.3: cross-tile approach corridors from adjacent tiles ──────────
  // These are portal corridors whose owning tile is a neighbour — their 80m
  // outward cut extends INTO this tile. Feed directly into approachSegments so
  // the existing rectangular cut logic handles them without any new code path.
  // Format matches Source A segments exactly: { ax, az, bx, bz, halfW }.
  if (crossTileApproaches && crossTileApproaches.length > 0) {
    for (const cta of crossTileApproaches) {
      approachSegments.push({
        ax: cta.portalX + cta.dirX * cta.approachLen, // approach zone end (inside this tile)
        az: cta.portalZ + cta.dirZ * cta.approachLen,
        bx: cta.portalX,                               // portal face (tile boundary)
        bz: cta.portalZ,
        halfW: cta.halfW,
      });
    }
  }

  // ── DYNAMIC carve: follow the ACTUAL ramp ─────────────────────────────────
  // For every tunnel + approach road segment, carve the corridor ONLY where the road is BELOW the local
  // terrain by between CARVE_MARGIN and CARVE_COVER metres — i.e. the surface→underground transition (the
  // ramp). Above grade (depth ≥ −margin) → no cut, so the opening ends exactly where the ramp meets the
  // surface (replaces the old fixed TRENCH_LEN corridor that ran far past the ramp). Deeper than −cover →
  // no cut, so the terrain roofs over the deep tunnel. road.elevation is ABSOLUTE (DEM-added), so the
  // relative depth = road.elevation − local terrain (bilinear-sampled from the grid). The mouth circles
  // (above) still open abrupt portals where the road jumps straight to depth with no descending ramp segment.
  const CARVE_MARGIN = 0.3;  // m below terrain before opening a cut (cut ends where ramp meets surface)
  const CARVE_COVER  = 5.0;  // m below terrain past which a normal roof clears the road (covered tunnel)
  const sampleGridElev = (lat, lon) => {
    const fr = gridRows <= 1 ? 0 : ((lat - south) / (north - south)) * (gridRows - 1);
    const fc = gridCols <= 1 ? 0 : ((lon - west) / (east - west)) * (gridCols - 1);
    const r0 = Math.max(0, Math.min(gridRows - 1, Math.floor(fr)));
    const c0 = Math.max(0, Math.min(gridCols - 1, Math.floor(fc)));
    const r1 = Math.min(r0 + 1, gridRows - 1), c1 = Math.min(c0 + 1, gridCols - 1);
    const tr = fr - r0, tc = fc - c0;
    const g = (rr, cc) => { const v = elevations[rr * gridCols + cc]; return Number.isFinite(v) ? v : 0; };
    return (1 - tr) * (1 - tc) * g(r0, c0) + (1 - tr) * tc * g(r0, c1) + tr * (1 - tc) * g(r1, c0) + tr * tc * g(r1, c1);
  };
  const collectCarve = (roads) => {
    for (const road of roads || []) {
      const pts = road.points, elevArr = road.elevation;
      if (!pts || pts.length < 2 || !elevArr) continue;
      const halfW = (road.width || 6) / 2 + APPROACH_RAMP_CUT_MARGIN;
      for (let i = 0; i < pts.length - 1; i++) {
        const llA = mercatorToLatLon(pts[i][0], pts[i][2]);
        const llB = mercatorToLatLon(pts[i + 1][0], pts[i + 1][2]);
        const dA = (elevArr[i] ?? 0) - sampleGridElev(llA.lat, llA.lon);
        const dB = (elevArr[i + 1] ?? 0) - sampleGridElev(llB.lat, llB.lon);
        const inRamp = (d) => d < -CARVE_MARGIN && d > -CARVE_COVER;
        if (inRamp(dA) || inRamp(dB)) {
          const wa = mercatorToWorld(pts[i][0], pts[i][2]);
          const wb = mercatorToWorld(pts[i + 1][0], pts[i + 1][2]);
          approachSegments.push({ ax: wa.x, az: wa.z, bx: wb.x, bz: wb.z, halfW });
        }
      }
    }
  };
  collectCarve(tunnelRoads);
  collectCarve(approachRoads);

  function inApproachCorridor(wx, wz) {
    for (const s of approachSegments) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const len2 = dx*dx + dz*dz;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((wx - s.ax)*dx + (wz - s.az)*dz) / len2));
      const cx = s.ax + t*dx, cz = s.az + t*dz;
      if (Math.hypot(wx - cx, wz - cz) < s.halfW) return true;
    }
    return false;
  }

  const hasApproach = approachSegments.length > 0;

  // Build triangle indices, skipping degenerate, tunnel mouth, and approach corridor triangles
  const indicesList = [];
  const DEGEN_EPS = 1e-10;
  const hasTunnels = tunnelMouths.length > 0 || hasApproach;

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

      // Triangle 1: a, c1, b
      if (triArea(a, c1, b) > DEGEN_EPS) {
        if (hasTunnels) {
          const cx1 = (positions[a * 3] + positions[c1 * 3] + positions[b * 3]) / 3;
          const cz1 = (positions[a * 3 + 2] + positions[c1 * 3 + 2] + positions[b * 3 + 2]) / 3;
          if (!inTunnelZone(cx1, cz1) && !inApproachCorridor(cx1, cz1)) indicesList.push(a, c1, b);
        } else {
          indicesList.push(a, c1, b);
        }
      }

      // Triangle 2: b, c1, d
      if (triArea(b, c1, d) > DEGEN_EPS) {
        if (hasTunnels) {
          const cx2 = (positions[b * 3] + positions[c1 * 3] + positions[d * 3]) / 3;
          const cz2 = (positions[b * 3 + 2] + positions[c1 * 3 + 2] + positions[d * 3 + 2]) / 3;
          if (!inTunnelZone(cx2, cz2) && !inApproachCorridor(cx2, cz2)) indicesList.push(b, c1, d);
        } else {
          indicesList.push(b, c1, d);
        }
      }
    }
  }

  const indices = new Uint32Array(indicesList);

  // Compute vertex normals by averaging face normals
  const normals = new Float32Array(totalVerts * 3);

  for (let i = 0; i < indicesList.length; i += 3) {
    const i0 = indicesList[i], i1 = indicesList[i + 1], i2 = indicesList[i + 2];
    const ax = positions[i1 * 3] - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

    // Cross product
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
    normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
    normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
  }

  // Normalize
  for (let i = 0; i < totalVerts; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    } else {
      normals[i * 3 + 1] = 1; // default up
    }
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    gridSize: GRID_SIZE,
    vertExag,
  };
}

// ─── Physics terrain mesh (32×32) ────────────────────────────────────────────

/**
 * Pre-compute a 32×32 physics collision mesh from elevation data.
 * Positions stored in WORLD space — frontend applies physics coordinate transform at runtime.
 *
 * @param {object} elevation - { south, west, north, east, gridRows, gridCols, elevations: number[] }
 * @param {object[]} [tunnelRoads] - roads with tunnel=true, points as [[x, yUp, z], ...]
 * @returns {{ verts: Float32Array, indices: Uint32Array, gridSize: number, vertExag: number }}
 */
export function bakePhysicsTerrain(elevation, tunnelRoads, approachRoads, crossTileApproaches) {
  if (!elevation || !elevation.elevations || !Array.isArray(elevation.elevations)) {
    return null;
  }

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  if (!gridRows || !gridCols) return null;

  const PHYSICS_GRID = 32;
  const rows = Math.min(gridRows, PHYSICS_GRID);
  const cols = Math.min(gridCols, PHYSICS_GRID);
  const vertExag = 1.0;

  // Build vertex grid in world space
  const vertsList = [];  // flat [x, y, z, ...]
  const worldXZ = [];    // for tunnel hole test

  for (let r = 0; r < rows; r++) {
    const lat = south + (north - south) * (rows <= 1 ? 0.5 : r / (rows - 1));
    const srcR = Math.min(gridRows - 1, Math.round(r / (rows - 1) * (gridRows - 1)));

    for (let c = 0; c < cols; c++) {
      const lon = west + (east - west) * (cols <= 1 ? 0.5 : c / (cols - 1));
      const { x: wx, z: wz } = latLonToWorld(lat, lon);
      const srcC = Math.min(gridCols - 1, Math.round(c / (cols - 1) * (gridCols - 1)));
      const idx = srcR * gridCols + srcC;
      let y = elevations[idx] != null && Number.isFinite(elevations[idx]) ? elevations[idx] : 0;
      // Store RAW elevation — frontend applies (y - offset) * vertExag at load time

      // Store in world space (frontend will apply physics transform)
      vertsList.push(wx, y, wz);
      worldXZ.push(wx, wz);
    }
  }

  // Tunnel mouth punching — portal endpoints only (count=1), not interior junctions
  const MOUTH_RADIUS = 1;
  // TASK C (playbook C3): physics mouth radius = visual mouth radius + 1m, so wheel
  // raycasts never catch terrain just inside the visible mouth. Visual r = width/2 + 2;
  // physics r = width/2 + 3.
  const PHYS_MOUTH_MARGIN = 1;
  const PHYS_JTOL = 3;
  const _hashEp = (x, z) => `${Math.round(x/PHYS_JTOL)},${Math.round(z/PHYS_JTOL)}`;
  const tunnelMouths = [];
  if (tunnelRoads && tunnelRoads.length > 0) {
    const _epCount = new Map();
    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const fp = mercatorToWorld(pts[0][0], pts[0][2]);
      const lp = mercatorToWorld(pts[pts.length-1][0], pts[pts.length-1][2]);
      const hf = _hashEp(fp.x, fp.z), hl = _hashEp(lp.x, lp.z);
      _epCount.set(hf, (_epCount.get(hf)||0)+1);
      _epCount.set(hl, (_epCount.get(hl)||0)+1);
    }
    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const hw = (road.width || 4) / 2 + 1;
      const fp = mercatorToWorld(pts[0][0], pts[0][2]);
      const lp = mercatorToWorld(pts[pts.length-1][0], pts[pts.length-1][2]);
      if ((_epCount.get(_hashEp(fp.x, fp.z))||0) === 1)
        tunnelMouths.push({ x: fp.x, z: fp.z, r: hw + MOUTH_RADIUS + PHYS_MOUTH_MARGIN });
      if ((_epCount.get(_hashEp(lp.x, lp.z))||0) === 1)
        tunnelMouths.push({ x: lp.x, z: lp.z, r: hw + MOUTH_RADIUS + PHYS_MOUTH_MARGIN });
    }
  }

  // ── TASK B (playbook C5/C4b): physics terrain cuts the SAME corridor set as the
  // visual baker, so the physics opening is a guaranteed SUPERSET of the visual opening.
  // Previously the physics baker cut inward-only for ramp-fixed portals and IGNORED
  // approachRoads + crossTileApproaches entirely → visual hole over solid physics
  // (car can't descend; terrain wall at cross-tile seams). Sources now mirror
  // bakeTerrainMesh exactly:
  //   • crossTileApproaches — injected corridors from neighbour tiles
  //   • Source A — bidirectional 80m corridors at every TRUE portal endpoint
  //   • Source B — explicit approachRoads with negative DEM elevation
  // Grid-aware superset: the physics grid is coarser (32 vs visual 64), so each cut
  // region is dilated by the physics half-cell-diagonal at test time (inApproachCorridor
  // / inTunnelZone). Any physics cell whose footprint overlaps a visual-cut region is
  // removed — coarser, but never smaller than the visual opening.
  const PHYS_TRENCH = 25;                              // must match visual TRENCH_LEN
  const PHYS_CUT_MARGIN = APPROACH_RAMP_CUT_MARGIN;    // 2.5 — same corridor halfW as visual
  const physApproach = [];

  // crossTileApproaches — identical to bakeTerrainMesh cross-tile block
  if (crossTileApproaches && crossTileApproaches.length > 0) {
    for (const cta of crossTileApproaches) {
      physApproach.push({
        ax: cta.portalX + cta.dirX * cta.approachLen, az: cta.portalZ + cta.dirZ * cta.approachLen,
        bx: cta.portalX, bz: cta.portalZ, halfW: cta.halfW,
      });
    }
  }

  // DYNAMIC carve (mirror of bakeTerrainMesh) — carve where the road is below local terrain by
  // margin..cover (the ramp), so the physics opening tracks the visual one. Dilated below by the
  // half-cell-diagonal so the coarse physics grid never undershoots the visual cut.
  const PHYS_CARVE_MARGIN = 0.3, PHYS_CARVE_COVER = 5.0;
  const sampleGridElevP = (lat, lon) => {
    const fr = gridRows <= 1 ? 0 : ((lat - south) / (north - south)) * (gridRows - 1);
    const fc = gridCols <= 1 ? 0 : ((lon - west) / (east - west)) * (gridCols - 1);
    const r0 = Math.max(0, Math.min(gridRows - 1, Math.floor(fr)));
    const c0 = Math.max(0, Math.min(gridCols - 1, Math.floor(fc)));
    const r1 = Math.min(r0 + 1, gridRows - 1), c1 = Math.min(c0 + 1, gridCols - 1);
    const tr = fr - r0, tc = fc - c0;
    const g = (rr, cc) => { const v = elevations[rr * gridCols + cc]; return Number.isFinite(v) ? v : 0; };
    return (1-tr)*(1-tc)*g(r0,c0) + (1-tr)*tc*g(r0,c1) + tr*(1-tc)*g(r1,c0) + tr*tc*g(r1,c1);
  };
  const collectCarveP = (roads) => {
    for (const road of roads || []) {
      const pts = road.points, elevArr = road.elevation;
      if (!pts || pts.length < 2 || !elevArr) continue;
      const halfW = (road.width || 6) / 2 + PHYS_CUT_MARGIN;
      for (let i = 0; i < pts.length - 1; i++) {
        const llA = mercatorToLatLon(pts[i][0], pts[i][2]);
        const llB = mercatorToLatLon(pts[i + 1][0], pts[i + 1][2]);
        const dA = (elevArr[i] ?? 0) - sampleGridElevP(llA.lat, llA.lon);
        const dB = (elevArr[i + 1] ?? 0) - sampleGridElevP(llB.lat, llB.lon);
        const inRamp = (d) => d < -PHYS_CARVE_MARGIN && d > -PHYS_CARVE_COVER;
        if (inRamp(dA) || inRamp(dB)) {
          const wa = mercatorToWorld(pts[i][0], pts[i][2]);
          const wb = mercatorToWorld(pts[i + 1][0], pts[i + 1][2]);
          physApproach.push({ ax: wa.x, az: wa.z, bx: wb.x, bz: wb.z, halfW });
        }
      }
    }
  };
  collectCarveP(tunnelRoads);
  collectCarveP(approachRoads);

  // Physics half-cell-diagonal — derived from the world-space grid spacing. Dilating
  // every cut region by this guarantees the coarse 32×32 opening covers the 64×64 visual.
  let physHalfDiag = 0;
  if (worldXZ.length >= cols * 2 + 2) {
    const cw = Math.hypot(worldXZ[2] - worldXZ[0],         worldXZ[3] - worldXZ[1]);          // adjacent column
    const ch = Math.hypot(worldXZ[cols*2] - worldXZ[0],    worldXZ[cols*2+1] - worldXZ[1]);   // adjacent row
    physHalfDiag = 0.5 * Math.hypot(cw, ch);
  }

  function inApproachCorridor(wx, wz) {
    for (const s of physApproach) {
      const dx = s.bx-s.ax, dz = s.bz-s.az, len2 = dx*dx+dz*dz;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((wx-s.ax)*dx+(wz-s.az)*dz)/len2));
      if (Math.hypot(wx-(s.ax+t*dx), wz-(s.az+t*dz)) < s.halfW + physHalfDiag) return true;
    }
    return false;
  }

  function inTunnelZone(wx, wz) {
    for (const m of tunnelMouths) {
      if (Math.hypot(wx - m.x, wz - m.z) < m.r + physHalfDiag) return true;
    }
    return false;
  }

  // Build indices — winding order matches frontend createTerrainTrimesh
  const indicesList = [];
  const hasTunnels = tunnelMouths.length > 0 || physApproach.length > 0;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const c1 = (r + 1) * cols + c;
      const d = c1 + 1;

      if (hasTunnels) {
        const cx1 = (worldXZ[a*2]+worldXZ[b*2]+worldXZ[c1*2])/3;
        const cz1 = (worldXZ[a*2+1]+worldXZ[b*2+1]+worldXZ[c1*2+1])/3;
        if (!inTunnelZone(cx1,cz1) && !inApproachCorridor(cx1,cz1)) indicesList.push(a,b,c1);

        const cx2 = (worldXZ[b*2]+worldXZ[d*2]+worldXZ[c1*2])/3;
        const cz2 = (worldXZ[b*2+1]+worldXZ[d*2+1]+worldXZ[c1*2+1])/3;
        if (!inTunnelZone(cx2,cz2) && !inApproachCorridor(cx2,cz2)) indicesList.push(b,d,c1);
      } else {
        indicesList.push(a,b,c1);
        indicesList.push(b,d,c1);
      }
    }
  }

  if (indicesList.length === 0) return null;

  return {
    verts: new Float32Array(vertsList),
    indices: new Uint32Array(indicesList),
    gridSize: PHYSICS_GRID,
    vertExag,
  };
}

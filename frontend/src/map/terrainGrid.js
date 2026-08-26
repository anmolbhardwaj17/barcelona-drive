/**
 * terrainGrid.js — generate a tile's terrain mesh from its elevation grid, at load time.
 *
 * WHY THIS EXISTS (v3 P4-01). The bake shipped positions/normals/uvs/indices for every tile:
 * measured at **384.6 MB, 68.4% of the 562.2 MB tile store**, sitting beside the 55.5 MB elevation
 * grid it is entirely derived from. `backend/tools/terrainRegenProof.mjs` re-ran the real baker
 * against each tile's own stored grid and reproduced **442 of 444 tiles bit-for-bit**; the 2
 * exceptions are stale tiles baked at gridSize 64 against a 128 grid, which already fail the
 * `useBaked` gate and take a runtime path in production today.
 *
 * ⚠ **THIS IS A SECOND COPY OF `backend/worldBuilder/terrainBaker.js`'s grid path, AND IT MUST STAY
 * BIT-EQUAL TO IT.** The repo already carries this pattern for the Mercator projection (see the note
 * at `projection.js:14` listing five copies), but a comment is not enforcement — so
 * `frontend/test/terrainGrid.test.js` runs BOTH implementations over real baked tiles and asserts
 * every float and index matches. If you change the maths here, that test fails until the baker
 * agrees, and vice versa.
 *
 * WHAT IS DELIBERATELY NOT PORTED. The baker also carries tunnel-mouth punching, approach-corridor
 * culling and a water dip. None of it runs: `buildRegion.js:1571` calls
 * `bakeTerrainMesh(payload.elevation, [], null, [], null)` — every one of those inputs is empty,
 * because the legacy tunnel carve was disabled when the authored trench moved into the elevation
 * grid itself. Porting dead branches would be porting a liability. The `hasTunnels` guard is what
 * makes the baker's index loop reduce to the plain one below.
 *
 * Indices are **Uint16**, not the bake's Uint32: the grid is at most 128×128, so the maximum vertex
 * index across all 444 tiles is 16 383 — measured, not assumed.
 */

// The projection is NOT duplicated. `backend/worldBuilder/terrainBaker.js` composes its
// latLonToWorld from the shared `projection.js`, and the frontend exports the identical function —
// so the one part of this file that genuinely must agree with the baker is imported rather than
// rewritten. (Reimplementing it here is exactly the mistake this file's header warns about, and it
// produced positions[0] = 232980 against the baked -1847 before being caught by the test below:
// mercatorToWorld subtracts a global ORIGIN and unstretches X, which a from-scratch Mercator does
// not do.)
import { latLonToWorld } from '../projection.js';

/** The bake's fixed visual grid. Downsampling below the DEM would throw away baked detail. */
export const TERRAIN_GRID_SIZE = 128;

/**
 * @param {{south:number,west:number,north:number,east:number,gridRows:number,gridCols:number,
 *          elevations:ArrayLike<number>}} elevation
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array,
 *            indices:Uint16Array, gridSize:number, vertExag:number}|null}
 */
export function buildTerrainFromGrid(elevation) {
  if (!elevation || !elevation.elevations || !elevation.elevations.length) return null;
  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;

  const rows = Math.min(gridRows, TERRAIN_GRID_SIZE);
  const cols = Math.min(gridCols, TERRAIN_GRID_SIZE);
  const vertExag = 1.0;   // the baker's constant — vertical exaggeration is a RENDER-time concern

  // x is linear in longitude, z is nonlinear in latitude — so z is precomputed per row.
  const xWest = latLonToWorld(south, west).x;
  const xEast = latLonToWorld(south, east).x;
  const xStep = cols > 1 ? (xEast - xWest) / (cols - 1) : 0;

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

      // map the visual grid back onto the source grid for sampling
      const srcR = rows <= 1 ? 0 : Math.min(gridRows - 1, Math.round(r / (rows - 1) * (gridRows - 1)));
      const srcC = cols <= 1 ? 0 : Math.min(gridCols - 1, Math.round(c / (cols - 1) * (gridCols - 1)));
      const e = elevations[srcR * gridCols + srcC];
      const y = (e != null && Number.isFinite(e) ? e : 0) * vertExag;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = cols <= 1 ? 0.5 : c / (cols - 1);
      uvs[vi * 2 + 1] = rows <= 1 ? 0.5 : 1 - r / (rows - 1);
    }
  }

  // Triangles, skipping degenerates. The baker's tunnel/approach rejection collapses to this
  // because `hasTunnels` is false for every tile — see the header note.
  const idx = [];
  const DEGEN_EPS = 1e-10;
  const triArea = (i0, i1, i2) => {
    const ax = positions[i0 * 3] - positions[i1 * 3], az = positions[i0 * 3 + 2] - positions[i1 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i1 * 3], bz = positions[i2 * 3 + 2] - positions[i1 * 3 + 2];
    return Math.abs(ax * bz - az * bx) * 0.5;
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, c1 = (r + 1) * cols + c, d = c1 + 1;
      if (triArea(a, c1, b) > DEGEN_EPS) idx.push(a, c1, b);
      if (triArea(b, c1, d) > DEGEN_EPS) idx.push(b, c1, d);
    }
  }
  const indices = new Uint16Array(idx);

  // Smooth normals: accumulate un-normalized face normals per vertex, then normalize.
  const normals = new Float32Array(totalVerts * 3);
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
    const ax = positions[i1 * 3] - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
    normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
    normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
  }
  for (let i = 0; i < totalVerts; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      normals[i * 3] = nx / len; normals[i * 3 + 1] = ny / len; normals[i * 3 + 2] = nz / len;
    } else {
      normals[i * 3 + 1] = 1;   // degenerate fan — default up
    }
  }

  return { positions, normals, uvs, indices, gridSize: TERRAIN_GRID_SIZE, vertExag };
}

/**
 * roadBaker.js
 *
 * Pre-bakes road surface ribbon geometry at build time.
 * Ported from frontend roadRenderer.js — same algorithms, no Three.js deps.
 *
 * Export: bakeRoadSurfaces(payload) → { layers: [ { layer, positions, normals, uvs, halfWidths, indices } ] }
 */
import { mercatorToWorld } from '../projection.js';

// ─── Constants (must match frontend roadRenderer.js exactly) ─────────────────

const ROAD_VISUAL_ABOVE_TERRAIN = 0.05;
const ROAD_ZFIGHT_OFFSET = 0.02;
const ROAD_OFFSET = 0.05;
const ROAD_UV_REPEAT_M = 4;
const JUNCTION_TOLERANCE = 2;
const WIDTH_TAPER_DISTANCE = 20;

const ROAD_PRIORITY_Y_BUMP = {
  motorway:       0.009,
  trunk:          0.008,
  primary:        0.007,
  secondary:      0.006,
  tertiary:       0.005,
  motorway_link:  0.0085,
  trunk_link:     0.0075,
  primary_link:   0.0065,
  secondary_link: 0.0055,
  tertiary_link:  0.0045,
  residential:    0.004,
  unclassified:   0.003,
  service:        0.002,
  living_street:  0.002,
  track:          0.001,
  path:           0.001,
  footway:        0.001,
  cycleway:       0.001,
};

// R-W1: the bake's own WIDTH_BY_TYPE is gone. It was UNREACHABLE — buildRegion always set
// `road.width`, so the `(osmW > 0) ? ... : WIDTH_BY_TYPE[...]` fallback below never fired — and its
// numbers were a different scale again (motorway 30 against buildRegion's 16). The one width model
// now runs in buildRegion and its output is on the road record.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashPoint(x, z, tol) {
  const g = 1 / (tol || 1);
  return `${Math.floor(x * g)}_${Math.floor(z * g)}`;
}

/**
 * R-W1: the DRAWN asphalt ribbon is the paved surface, kerb to kerb — a parking bay is asphalt too.
 * `kerbToKerbW` is authoritative; `width` is its alias and the fallback for a road that somehow
 * reached here without the section. Service subtypes are handled inside the model now.
 */
function getRoadWidth(road) {
  const w = Number(road.kerbToKerbW ?? road.width);
  return Number.isFinite(w) && w > 0 ? w : 6;
}

// ─── Junction width map ─────────────────────────────────────────────────────

function buildJunctionWidthMap(roads, tol) {
  const byHash = new Map();
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const w = getRoadWidth(road);   // R-W1: same number the ribbon is drawn at, or the taper fights it
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const h = hashPoint(p.x, p.y, tol);
      if (!byHash.has(h)) byHash.set(h, { maxW: w, minW: w });
      const v = byHash.get(h);
      v.maxW = Math.max(v.maxW, w);
      v.minW = Math.min(v.minW, w);
    }
  }
  for (const [k, v] of byHash) {
    if (v.maxW - v.minW < 0.5) byHash.delete(k);
  }
  return byHash;
}

// ─── Width tapering ─────────────────────────────────────────────────────────

function computeTaperedWidths(road, junctionWidthMap, tol) {
  const pts = road.points;
  if (!pts || pts.length < 2) return null;
  const ownW = getRoadWidth(road);   // R-W1

  const startHash = hashPoint(pts[0].x, pts[0].y, tol);
  const endHash = hashPoint(pts[pts.length - 1].x, pts[pts.length - 1].y, tol);
  const startJ = junctionWidthMap.get(startHash);
  const endJ = junctionWidthMap.get(endHash);

  const startTarget = startJ ? startJ.maxW : ownW;
  const endTarget = endJ ? endJ.maxW : ownW;
  const needsStart = Math.abs(startTarget - ownW) >= 0.5;
  const needsEnd = Math.abs(endTarget - ownW) >= 0.5;
  if (!needsStart && !needsEnd) return null;

  const cumDist = [0];
  for (let i = 1; i < pts.length; i++) {
    cumDist[i] = cumDist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const totalLen = cumDist[pts.length - 1];
  const taper = Math.min(WIDTH_TAPER_DISTANCE, totalLen / 2);

  const widths = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const dStart = cumDist[i];
    const dEnd = totalLen - dStart;
    let w = ownW;
    if (needsStart && dStart < taper) {
      const t = dStart / taper;
      const blend = t * t * (3 - 2 * t);
      w = startTarget + blend * (ownW - startTarget);
    }
    if (needsEnd && dEnd < taper) {
      const t = dEnd / taper;
      const blend = t * t * (3 - 2 * t);
      const wEnd = endTarget + blend * (ownW - endTarget);
      w = Math.max(w, wEnd);
    }
    widths[i] = w;
  }
  return widths;
}

// ─── Ramp divergence ────────────────────────────────────────────────────────

function applyRampDivergence(roads) {
  const jMap = new Map();
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (const isStart of [true, false]) {
      const p = isStart ? pts[0] : pts[pts.length - 1];
      const h = hashPoint(p.x, p.y, JUNCTION_TOLERANCE);
      if (!jMap.has(h)) jMap.set(h, []);
      jMap.get(h).push({ ri, isStart, road });
    }
  }

  const modified = roads.map((road) => road);
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    if (!road.isRamp && !(road.highwayType && road.highwayType.endsWith('_link'))) continue;
    const pts = road.points;
    if (!pts || pts.length < 3) continue;

    const rampWidth = getRoadWidth(road);

    for (const isStart of [true, false]) {
      const ep = isStart ? pts[0] : pts[pts.length - 1];
      const h = hashPoint(ep.x, ep.y, JUNCTION_TOLERANCE);
      const group = jMap.get(h);
      if (!group || group.length < 2) continue;

      // Skip divergence trimming when both roads are elevated — no overlap to resolve
      let mainRoad = null;
      let mainWidth = 0;
      for (const entry of group) {
        if (entry.ri === ri) continue;
        const w = getRoadWidth(entry.road);
        if (w > mainWidth) {
          mainWidth = w;
          mainRoad = entry;
        }
      }
      if (!mainRoad || mainWidth <= rampWidth) continue;

      // Don't trim when both the ramp and the main road are elevated (bridge/layer>0).
      // Trimming only makes sense at ground-level junctions where the ramp overlaps
      // the main road surface. Between elevated roads, they need to connect.
      const rampIsElevated = road.bridge || (road.layer != null && road.layer > 0);
      const mainIsElevated = mainRoad.road.bridge || (mainRoad.road.layer != null && mainRoad.road.layer > 0);
      if (rampIsElevated && mainIsElevated) continue;

      const mPts = mainRoad.road.points;
      if (!mPts || mPts.length < 2) continue;
      const mStart = mainRoad.isStart;
      let mdx, mdz;
      if (mStart) {
        mdx = mPts[1].x - mPts[0].x;
        mdz = mPts[1].y - mPts[0].y;
      } else {
        const last = mPts.length - 1;
        mdx = mPts[last - 1].x - mPts[last].x;
        mdz = mPts[last - 1].y - mPts[last].y;
      }
      const mLen = Math.hypot(mdx, mdz);
      if (mLen < 0.01) continue;
      mdx /= mLen; mdz /= mLen;

      const perpX = -mdz, perpZ = mdx;
      const mainHalf = mainWidth / 2;
      const mJunc = mainRoad.isStart ? mPts[0] : mPts[mPts.length - 1];

      // Find where the ramp is still inside the main road's envelope
      let trimCount = 0;
      for (let i = 0; i < pts.length; i++) {
        const idx = isStart ? i : (pts.length - 1 - i);
        const p = pts[idx];
        const dx = p.x - mJunc.x;
        const dz = p.y - mJunc.y;
        const perpDist = Math.abs(dx * perpX + dz * perpZ);
        if (perpDist >= mainHalf * 0.85) break;
        trimCount++;
      }

      if (trimCount > 0 && trimCount < pts.length - 1) {
        const newPts = isStart
          ? pts.slice(trimCount)
          : pts.slice(0, pts.length - trimCount);
        if (newPts.length >= 2) {
          // Only apply lateral shift to _link roads (on/off ramps connecting to
          // the main road), not to the flyover/bridge ramp itself.  This pushes
          // the link road to the side so drivers can merge naturally.
          const isLinkRoad = road.highwayType && road.highwayType.endsWith('_link');
          if (isLinkRoad) {
            const firstKept = newPts[isStart ? 0 : newPts.length - 1];
            const dxK = firstKept.x - mJunc.x;
            const dzK = firstKept.y - mJunc.y;
            const side = Math.sign(dxK * perpX + dzK * perpZ) || 1;

            // Gradually push the first few kept points laterally outward from the
            // main road so the link separates smoothly instead of splitting sharply.
            const LATERAL_SHIFT_DIST = 8;  // how many points to push
            const LATERAL_SHIFT_MAX = mainHalf * 0.35; // max lateral push (metres)
            const shiftCount = Math.min(LATERAL_SHIFT_DIST, Math.floor(newPts.length * 0.4));
            for (let i = 0; i < shiftCount; i++) {
              const idx = isStart ? i : (newPts.length - 1 - i);
              const t = 1 - (i / shiftCount); // 1 at junction, 0 at far end
              const ss = t * t * (3 - 2 * t); // smoothstep
              const shift = ss * LATERAL_SHIFT_MAX * side;
              newPts[idx] = { ...newPts[idx], x: newPts[idx].x + perpX * shift, y: newPts[idx].y + perpZ * shift };
            }
          }

          modified[ri] = { ...road, points: newPts };
        }
      }
      break;
    }
  }
  return modified;
}

// ─── Road point heights (backend: no runtime elevation lookup) ──────────────

function getRoadPointHeights(road) {
  if (!road.points?.length) return null;
  const layer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
  // In backend: elevationOffset = 0, vertExag = 1
  const heights = [];
  for (const p of road.points) {
    if (p && Number.isFinite(p.elevation)) {
      // Backend baked elevation is raw: y = raw * 1 (vertExag=1, offset=0)
      const y = p.elevation;
      heights.push(y + ROAD_VISUAL_ABOVE_TERRAIN);
      continue;
    }
    heights.push(ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
  }
  return heights;
}

// ─── Core ribbon builder (ported from frontend — pure math, no Three.js) ────

function buildFlatRibbonGeometry(points, widthOrWidths, yOffsetOrHeights) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const isWidthArray = Array.isArray(widthOrWidths);
  const getHalf = isWidthArray
    ? (i) => (widthOrWidths[i] != null ? widthOrWidths[i] / 2 : 3)
    : () => widthOrWidths / 2;
  const isArray = Array.isArray(yOffsetOrHeights);
  const getY = (i) => (isArray ? (yOffsetOrHeights[i] != null ? yOffsetOrHeights[i] : 0) : yOffsetOrHeights);

  const positions = [];
  const uvs = [];
  const halfWidths = [];
  let lengthAlong = 0;

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const x = p.x;
    const z = p.y; // p.y is world Z in frontend format
    const y = getY(i) + ROAD_ZFIGHT_OFFSET;
    const half = getHalf(i);
    if (i > 0) lengthAlong += Math.hypot(x - points[i - 1].x, z - points[i - 1].y);
    const u = lengthAlong / ROAD_UV_REPEAT_M;

    let normX, normZ, miterLength;
    if (i === 0) {
      const dx = points[1].x - x;
      const dz = points[1].y - z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-12) continue;
      const len = Math.sqrt(lenSq);
      normX = -dz / len;
      normZ = dx / len;
      miterLength = half;
    } else if (i === n - 1) {
      const dx = x - points[n - 2].x;
      const dz = z - points[n - 2].y;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-12) continue;
      const len = Math.sqrt(lenSq);
      normX = -dz / len;
      normZ = dx / len;
      miterLength = half;
    } else {
      // Direction from previous to current
      let dirAX = x - points[i - 1].x;
      let dirAZ = z - points[i - 1].y;
      const lenASq = dirAX * dirAX + dirAZ * dirAZ;
      if (lenASq < 1e-12) {
        // Fallback to next segment
        const dirBX = points[i + 1].x - x;
        const dirBZ = points[i + 1].y - z;
        const lenBSq = dirBX * dirBX + dirBZ * dirBZ;
        if (lenBSq < 1e-12) continue;
        const lenB = Math.sqrt(lenBSq);
        normX = -dirBZ / lenB;
        normZ = dirBX / lenB;
        miterLength = half;
      } else {
        const dirBX = points[i + 1].x - x;
        const dirBZ = points[i + 1].y - z;
        const lenBSq = dirBX * dirBX + dirBZ * dirBZ;
        if (lenBSq < 1e-12) {
          const lenA = Math.sqrt(lenASq);
          normX = -dirAZ / lenA;
          normZ = dirAX / lenA;
          miterLength = half;
        } else {
          // Normalize direction A
          const lenA = Math.sqrt(lenASq);
          dirAX /= lenA;
          dirAZ /= lenA;
          const perpAX = -dirAZ;
          const perpAZ = dirAX;
          // Normalize direction B
          const lenB = Math.sqrt(lenBSq);
          const perpBX = -dirBZ / lenB;
          const perpBZ = dirBX / lenB;
          // Miter = average of perpendiculars
          let miterX = perpAX + perpBX;
          let miterZ = perpAZ + perpBZ;
          const mLenSq = miterX * miterX + miterZ * miterZ;
          if (mLenSq < 1e-12) continue;
          const mLen = Math.sqrt(mLenSq);
          miterX /= mLen;
          miterZ /= mLen;
          const denom = miterX * perpBX + miterZ * perpBZ;
          if (Math.abs(denom) < 0.2) {
            // Near-180 turn: fall back to simple perpendicular
            normX = perpBX;
            normZ = perpBZ;
            miterLength = half;
          } else {
            miterLength = half / denom;
            miterLength = Math.min(miterLength, half * 4);
            normX = miterX;
            normZ = miterZ;
          }
        }
      }
    }

    const leftX = x - normX * miterLength;
    const leftZ = z - normZ * miterLength;
    const rightX = x + normX * miterLength;
    const rightZ = z + normZ * miterLength;
    positions.push(leftX, y, leftZ, rightX, y, rightZ);
    uvs.push(u, 0, u, 1);
    halfWidths.push(half, half);
  }

  const numVerts = positions.length / 3;
  if (numVerts < 4) return null;
  const indices = [];
  for (let i = 0; i < numVerts / 2 - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, d, a, d, c);
  }
  return { positions, uvs, halfWidths, indices, numVerts };
}

// ─── Per-road geometry (matches frontend createRoadMesh) ────────────────────

function createRoadRibbon(road, taperedWidths) {
  let pts = road.points;
  if (!pts || pts.length < 2) return null;

  // Filter degenerate duplicate points (same position) to prevent collapsed geometry
  const filtered = [pts[0]];
  const filteredHeightsIdx = [0];
  for (let i = 1; i < pts.length; i++) {
    const prev = filtered[filtered.length - 1];
    const dx = pts[i].x - prev.x, dz = pts[i].y - prev.y;
    if (dx * dx + dz * dz > 0.001) { // > ~3cm apart
      filtered.push(pts[i]);
      filteredHeightsIdx.push(i);
    }
  }
  if (filtered.length < 2) return null;
  pts = filtered;

  const widthOrWidths = taperedWidths
    ? (filtered.length === road.points.length
        ? taperedWidths
        : filteredHeightsIdx.map(i => taperedWidths[i]))  // remap tapered widths
    : (Number.isFinite(Number(road.width))
        ? Math.max(3, Math.min(30, Number(road.width)))
        : getRoadWidth(road));

  const rawHeights = getRoadPointHeights(road);
  let finalY;
  if (Array.isArray(rawHeights)) {
    finalY = filteredHeightsIdx.map(i => rawHeights[i]); // remap heights to filtered points
  } else {
    finalY = rawHeights || ROAD_OFFSET;
  }

  const priorityBump = ROAD_PRIORITY_Y_BUMP[road.highwayType] ?? 0;
  if (priorityBump > 0) {
    if (Array.isArray(finalY)) {
      for (let i = 0; i < finalY.length; i++) finalY[i] += priorityBump;
    } else {
      finalY = finalY + priorityBump;
    }
  }
  return buildFlatRibbonGeometry(pts, widthOrWidths, finalY);
}

// ─── Merge ribbons within a layer ───────────────────────────────────────────

function mergeRibbons(ribbons) {
  let totalPositions = 0;
  let totalUvs = 0;
  let totalHalfWidths = 0;
  let totalIndices = 0;
  for (const r of ribbons) {
    totalPositions += r.positions.length;
    totalUvs += r.uvs.length;
    totalHalfWidths += r.halfWidths.length;
    totalIndices += r.indices.length;
  }

  const positions = new Float32Array(totalPositions);
  const uvs = new Float32Array(totalUvs);
  const halfWidths = new Float32Array(totalHalfWidths);
  const indices = new Uint32Array(totalIndices);

  let posOff = 0, uvOff = 0, hwOff = 0, idxOff = 0, vertexOffset = 0;
  for (const r of ribbons) {
    // Positions
    for (let i = 0; i < r.positions.length; i++) {
      positions[posOff++] = r.positions[i];
    }
    // UVs
    for (let i = 0; i < r.uvs.length; i++) {
      uvs[uvOff++] = r.uvs[i];
    }
    // Half-widths
    for (let i = 0; i < r.halfWidths.length; i++) {
      halfWidths[hwOff++] = r.halfWidths[i];
    }
    // Indices (offset by accumulated vertex count)
    for (let i = 0; i < r.indices.length; i++) {
      indices[idxOff++] = r.indices[i] + vertexOffset;
    }
    vertexOffset += r.numVerts;
  }

  return { positions, uvs, halfWidths, indices, numVerts: vertexOffset };
}

// ─── Compute vertex normals (same cross-product approach as terrainBaker) ───

function computeVertexNormals(positions, indices) {
  const numVerts = positions.length / 3;
  const normals = new Float32Array(numVerts * 3);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
    const ax = positions[i1 * 3]     - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3]     - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    normals[i0 * 3]     += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
    normals[i1 * 3]     += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
    normals[i2 * 3]     += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
  }

  // Normalize
  for (let i = 0; i < numVerts; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      normals[i * 3]     = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    } else {
      normals[i * 3 + 1] = 1; // default up
    }
  }

  return normals;
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Pre-bake road surface ribbon geometry from tile payload.
 *
 * @param {object} payload - tile payload with .roads array
 * @returns {{ layers: Array<{ layer: number, positions: Float32Array, normals: Float32Array, uvs: Float32Array, halfWidths: Float32Array, indices: Uint32Array }> }}
 */
export function bakeRoadSurfaces(payload) {
  const rawRoads = payload?.roads || [];
  if (rawRoads.length === 0) return { layers: [] };

  // Step 1: Convert road points from [mercX, yUp, mercY] to {x, y, elevation} in WORLD coords.
  // Road points from buildRoadGeometry are in Mercator coordinates, not world coords.
  // Must convert to world space (same as frontend binary parser does).
  const convertedRoads = rawRoads.map((road) => ({
    ...road,
    points: (road.points || []).map((p, i) => {
      if (Array.isArray(p)) {
        const elev = road.elevation && road.elevation[i] != null ? road.elevation[i] : p[1];
        // p[0] = Mercator X, p[2] = Mercator Y → convert to world coords
        const world = mercatorToWorld(p[0], p[2]);
        return { x: world.x, y: world.z, elevation: elev };
      }
      return p;
    }),
  }));

  // Step 2: Apply ramp divergence
  const roads = applyRampDivergence(convertedRoads);

  // Step 3: Build junction width map from original (pre-diverged) roads
  const junctionWidthMap = buildJunctionWidthMap(convertedRoads, JUNCTION_TOLERANCE);

  // Step 4: Build ribbon geometry per road, group by layer
  const byLayer = new Map();
  for (const road of roads) {
    const taperedWidths = computeTaperedWidths(road, junctionWidthMap, JUNCTION_TOLERANCE);
    const ribbon = createRoadRibbon(road, taperedWidths);
    if (!ribbon) continue;
    const layer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(ribbon);
  }

  // Step 5: Merge ribbons per layer, compute normals
  const layers = [];
  for (const [layer, ribbons] of byLayer) {
    if (ribbons.length === 0) continue;
    const merged = mergeRibbons(ribbons);
    const normals = computeVertexNormals(merged.positions, merged.indices);
    layers.push({
      layer,
      positions: merged.positions,
      normals,
      uvs: merged.uvs,
      halfWidths: merged.halfWidths,
      indices: merged.indices,
    });
  }

  return { layers };
}

/**
 * sidewalkBaker.js
 *
 * Pre-bakes Barcelona Phase-3 sidewalk (panot) + curb (granite L-profile) geometry
 * at build time. Bake-side port of the frontend runtime generators in
 * frontend/src/map/roadRenderer.js — same algorithms, no Three.js deps.
 *
 * CONTRACT:
 *   bakeSidewalks(payload) → null | {
 *     sidewalk: { positions: number[], normals: number[], uvs: number[], indices: number[] },
 *     curbTop:  { positions: number[], normals: number[], indices: number[] },
 *     curbFace: { positions: number[], normals: number[], indices: number[] },
 *   }
 *
 *   - payload is the per-tile bake payload (buildRegion.js): payload.roads with
 *     points [mercX, yUp, mercY] + elevation[] (raw DEM metres), payload.buildings
 *     with footprint already in WORLD coords ([[x,z], ...] — buildingNormalize.js).
 *   - Output coordinates are WORLD (same frame as roadBaker's bakedRoads:
 *     mercatorToWorld with Unstretch-X, 1 unit = 1 real metre).
 *   - Y values are RAW DEM elevation based (NOT normalized):
 *       sidewalk / curb top:  rawElev + CURB_HEIGHT  (+ ROAD_ZFIGHT_OFFSET inside
 *                             buildFlatRibbonGeometry, same as baked road surfaces)
 *       curb outer face:      rawElev → rawElev + CURB_HEIGHT (no zfight offset,
 *                             matching the runtime custom face geometry)
 *     The frontend normalizes on read exactly like bakedRoads:
 *       y' = (y - elevationOffset) * vertExag + ROAD_VISUAL_ABOVE_TERRAIN
 *     so ROAD_OFFSET / ROAD_VISUAL_ABOVE_TERRAIN are deliberately NOT added here
 *     (the runtime generators add them because they emit in the render frame).
 *
 * IMPORTANT: the frontend fallback path (runtime generation via buildSidewalks /
 * buildCurbs in roadRenderer.js for v7 tiles without baked sidewalk data) must
 * stay behavior-identical to this baker. Any change to eligibility, widths,
 * offsets, or junction clipping must be mirrored in both places.
 *
 * Ported source (frontend/src/map/roadRenderer.js, line refs as of this port):
 *   getJunctionPoints (~651), clipPolylineNearJunctions (~798),
 *   clampSidewalkVerticesOutsideRoads (~861), getOffsetPolyline (~906),
 *   interpolateHeightsFromSource (~1102), _NO_SIDEWALK_TYPES / inferSidewalkSide (~1534),
 *   buildSidewalks (~1554), buildCurbs (~1659).
 * Conventions/helpers from backend/worldBuilder/roadBaker.js:
 *   Mercator→world road conversion (bakeRoadSurfaces step 1, ~559),
 *   applyRampDivergence (~153), buildFlatRibbonGeometry (~293),
 *   mergeRibbons (~466), computeVertexNormals (~509).
 * Constants from frontend/src/map/barcelona-constants.js (BCN_DIMS).
 */
import { mercatorToWorld } from '../projection.js';

// ─── Constants (must match frontend exactly) ─────────────────────────────────

// Subset of BCN_DIMS — copied verbatim from frontend/src/map/barcelona-constants.js
const BCN_DIMS = {
  SIDEWALK_WIDTH_EIXAMPLE:  5.0,
  SIDEWALK_WIDTH_NARROW:    2.5,
  SIDEWALK_WIDTH_BOULEVARD: 8.0,
  CURB_WIDTH:   0.30,
  CURB_HEIGHT:  0.12,
  PANOT_TILE_SIZE: 0.20,
};

const JUNCTION_TOLERANCE = 2;      // roadRenderer.js:631
const INTERSECTION_RADIUS = 3;     // roadRenderer.js:633
const ROAD_ZFIGHT_OFFSET = 0.02;   // roadRenderer.js:25 / roadBaker.js:14
const ROAD_UV_REPEAT_M = 4;        // roadBaker.js:16 (ribbon default UVs; overwritten for sidewalk)
const SIDEWALK_CLAMP_EPSILON = 0.01; // roadRenderer.js:855

// roadRenderer.js:152 / roadBaker.js:41
const WIDTH_BY_TYPE = {
  motorway:        30,
  trunk:           26,
  primary:         20,
  secondary:       16,
  tertiary:        13,
  motorway_link:   15,
  trunk_link:      13,
  primary_link:    11,
  secondary_link:  10,
  tertiary_link:    9,
  residential:     10,
  service:          7,
  unclassified:    10,
  living_street:    8,
  track:            5,
  path:             2,
  footway:          2,
  cycleway:         2,
};

// ─── Generic helpers (ported from roadRenderer.js) ───────────────────────────

// roadRenderer.js:635
function hashPoint(x, z, tol) {
  const g = 1 / (tol || 1);
  return `${Math.floor(x * g)}_${Math.floor(z * g)}`;
}

// roadRenderer.js:640
function getRoadWidth(road) {
  const osmW = Number(road.width);
  let w = (osmW > 0) ? Math.max(4, Math.min(30, osmW)) : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
  if (road.highwayType === 'service' && road.serviceSubtype) {
    if (road.serviceSubtype === 'alley')         w = 3;
    else if (road.serviceSubtype === 'driveway') w = 3.5;
  }
  return w;
}

/**
 * Endpoints shared by at least two road segments. Returns [{ x, z, radius }]
 * where radius = max(roadWidth) at junction. Ported from roadRenderer.js:651.
 */
export function getJunctionPoints(roads, tolerance) {
  const byHash = new Map();
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const w = getRoadWidth(road);
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const h = hashPoint(p.x, p.y, tolerance);
      if (!byHash.has(h)) byHash.set(h, { x: p.x, z: p.y, count: 0, maxWidth: 0 });
      const v = byHash.get(h);
      v.count += 1;
      v.maxWidth = Math.max(v.maxWidth, w);
    }
  }
  const out = [];
  for (const v of byHash.values()) {
    if (v.count >= 2) out.push({ x: v.x, z: v.z, radius: v.maxWidth });
  }
  return out;
}

// roadRenderer.js:760
function segmentCircleIntersections(ax, az, bx, bz, jx, jz, R) {
  const dx = bx - ax;
  const dz = bz - az;
  const ox = ax - jx;
  const oz = az - jz;
  const a = dx * dx + dz * dz;
  if (a < 1e-14) return [];
  const b = 2 * (dx * ox + dz * oz);
  const c = ox * ox + oz * oz - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sqrtD = Math.sqrt(disc);
  const t1 = (-b - sqrtD) / (2 * a);
  const t2 = (-b + sqrtD) / (2 * a);
  const out = [];
  if (t1 >= 0 && t1 <= 1) out.push(t1);
  if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-8) out.push(t2);
  return out;
}

// roadRenderer.js:780
function distToPoint(x, z, jx, jz) {
  return Math.hypot(x - jx, z - jz);
}

// roadRenderer.js:785
function isOutsideJunctions(x, z, junctions, radiusOrGetter) {
  const getR = (j) => (typeof radiusOrGetter === 'function' ? radiusOrGetter(j) : radiusOrGetter);
  for (const j of junctions) {
    const r = getR(j);
    if (distToPoint(x, z, j.x, j.z) < r - 1e-6) return false;
  }
  return true;
}

/**
 * Clip polyline so no part lies inside junction circles. Returns array of polylines (runs).
 * points: [{ x, y }] with y = Z. radiusOrGetter: number or (j) => number.
 * Ported verbatim from roadRenderer.js:798.
 */
function clipPolylineNearJunctions(points, junctionPoints, radiusOrGetter) {
  if (!points || points.length < 2 || junctionPoints.length === 0) return [points];
  const junctions = junctionPoints;
  const getR = (j) => (typeof radiusOrGetter === 'function' ? radiusOrGetter(j) : radiusOrGetter);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const A = points[i];
    const B = points[i + 1];
    const ax = A.x; const az = A.y;
    const bx = B.x; const bz = B.y;
    let tValues = [0, 1];
    for (const j of junctions) {
      const r = getR(j);
      const ts = segmentCircleIntersections(ax, az, bx, bz, j.x, j.z, r);
      for (const t of ts) tValues.push(t);
    }
    tValues = [...new Set(tValues)].sort((a, b) => a - b);
    for (let k = 0; k < tValues.length - 1; k++) {
      const ta = tValues[k];
      const tb = tValues[k + 1];
      const tMid = (ta + tb) / 2;
      const mx = ax + tMid * (bx - ax);
      const mz = az + tMid * (bz - az);
      if (isOutsideJunctions(mx, mz, junctions, radiusOrGetter)) {
        const px = ax + ta * (bx - ax);
        const pz = az + ta * (bz - az);
        const qx = ax + tb * (bx - ax);
        const qz = az + tb * (bz - az);
        segments.push([{ x: px, y: pz }, { x: qx, y: qz }]);
      }
    }
  }
  if (segments.length === 0) return [];
  const eps = 1e-4;
  function eq(a, b) {
    return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
  }
  const runs = [];
  for (const seg of segments) {
    let added = false;
    for (const run of runs) {
      if (eq(run[run.length - 1], seg[0])) {
        if (!eq(run[run.length - 1], seg[1])) run.push(seg[1]);
        added = true;
        break;
      }
      if (eq(run[0], seg[1])) {
        if (!eq(run[0], seg[0])) run.unshift(seg[0]);
        added = true;
        break;
      }
    }
    if (!added) runs.push([seg[0], seg[1]]);
  }
  return runs.filter((r) => r.length >= 2);
}

/**
 * Clamp sidewalk mesh vertices so none lie inside any road (thick segment).
 * Modifies the plain positions array in place (XZ only). Use after merge.
 * Ported from roadRenderer.js:861 — adapted from a THREE position attribute
 * to a plain [x,y,z, x,y,z, ...] array.
 */
function clampSidewalkVerticesOutsideRoads(roads, positions) {
  if (!positions || positions.length === 0 || !roads?.length) return;
  const pos = positions;
  const n = pos.length / 3;
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < n; i++) {
      let x = pos[i * 3];
      let z = pos[i * 3 + 2];
      for (const road of roads) {
        const pts = road.points;
        if (!pts || pts.length < 2) continue;
        const half = getRoadWidth(road) / 2 + SIDEWALK_CLAMP_EPSILON;
        for (let j = 0; j < pts.length - 1; j++) {
          const ax = pts[j].x;
          const az = pts[j].y;
          const bx = pts[j + 1].x;
          const bz = pts[j + 1].y;
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz || 1e-12;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq));
          const qx = ax + t * dx;
          const qz = az + t * dz;
          const d = Math.hypot(x - qx, z - qz);
          if (d < half) {
            if (d < 1e-6) {
              const perpX = -dz / Math.sqrt(lenSq);
              const perpZ = dx / Math.sqrt(lenSq);
              x = qx + half * perpX;
              z = qz + half * perpZ;
            } else {
              const scale = half / d;
              x = qx + (x - qx) * scale;
              z = qz + (z - qz) * scale;
            }
          }
        }
      }
      pos[i * 3] = x;
      pos[i * 3 + 2] = z;
    }
  }
}

/**
 * Get polyline points offset by distance (positive = right, negative = left).
 * points: [{x,y}], y = Z. Ported verbatim from roadRenderer.js:906.
 */
function getOffsetPolyline(points, offset) {
  if (!points || points.length < 2) return [];
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let dx, dz;
    if (i === 0) {
      dx = points[1].x - p.x;
      dz = points[1].y - p.y;
    } else if (i === n - 1) {
      dx = p.x - points[n - 2].x;
      dz = p.y - points[n - 2].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dz = points[i + 1].y - points[i - 1].y;
    }
    const len = Math.hypot(dx, dz) || 1;
    const perpX = (-dz / len) * offset;
    const perpZ = (dx / len) * offset;
    out.push({ x: p.x + perpX, y: p.y + perpZ });
  }
  return out;
}

/**
 * For each point in targetPts, find the closest projection onto the srcPts
 * polyline and linearly interpolate from srcHeights. Works for offset,
 * clipped, or any derived polyline regardless of point count.
 * Ported verbatim from roadRenderer.js:1102.
 */
function interpolateHeightsFromSource(srcPts, srcHeights, targetPts) {
  if (!srcHeights || !srcPts || srcPts.length < 2 || !targetPts || targetPts.length === 0) return null;
  if (targetPts.length === srcHeights.length && targetPts === srcPts) return srcHeights;

  const out = new Array(targetPts.length);
  for (let ti = 0; ti < targetPts.length; ti++) {
    const px = targetPts[ti].x, pz = targetPts[ti].y;
    let bestT = 0, bestSeg = 0, bestDistSq = Infinity;
    for (let i = 0; i < srcPts.length - 1; i++) {
      const ax = srcPts[i].x, az = srcPts[i].y;
      const bx = srcPts[i + 1].x, bz = srcPts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq)) : 0;
      const cx = ax + t * dx, cz = az + t * dz;
      const dSq = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      if (dSq < bestDistSq) { bestDistSq = dSq; bestSeg = i; bestT = t; }
    }
    const hA = srcHeights[bestSeg] ?? 0;
    const hB = srcHeights[bestSeg + 1] ?? 0;
    out[ti] = hA + bestT * (hB - hA);
  }
  return out;
}

// ─── Ramp divergence (copied from roadBaker.js:153 — runtime applies it before
//     buildSidewalks/buildCurbs via renderTileRoads, roadRenderer.js:4465) ─────

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
          const isLinkRoad = road.highwayType && road.highwayType.endsWith('_link');
          if (isLinkRoad) {
            const firstKept = newPts[isStart ? 0 : newPts.length - 1];
            const dxK = firstKept.x - mJunc.x;
            const dzK = firstKept.y - mJunc.y;
            const side = Math.sign(dxK * perpX + dzK * perpZ) || 1;

            const LATERAL_SHIFT_DIST = 8;
            const LATERAL_SHIFT_MAX = mainHalf * 0.35;
            const shiftCount = Math.min(LATERAL_SHIFT_DIST, Math.floor(newPts.length * 0.4));
            for (let i = 0; i < shiftCount; i++) {
              const idx = isStart ? i : (newPts.length - 1 - i);
              const t = 1 - (i / shiftCount);
              const ss = t * t * (3 - 2 * t);
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

// ─── Core ribbon builder (copied from roadBaker.js:293 — plain arrays, no THREE).
//     Same math as frontend buildFlatRibbonGeometry (roadRenderer.js:451), incl.
//     the internal +ROAD_ZFIGHT_OFFSET on Y. ─────────────────────────────────────

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
      let dirAX = x - points[i - 1].x;
      let dirAZ = z - points[i - 1].y;
      const lenASq = dirAX * dirAX + dirAZ * dirAZ;
      if (lenASq < 1e-12) {
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
          const lenA = Math.sqrt(lenASq);
          dirAX /= lenA;
          dirAZ /= lenA;
          const perpAX = -dirAZ;
          const perpAZ = dirAX;
          const lenB = Math.sqrt(lenBSq);
          const perpBX = -dirBZ / lenB;
          const perpBZ = dirBX / lenB;
          let miterX = perpAX + perpBX;
          let miterZ = perpAZ + perpBZ;
          const mLenSq = miterX * miterX + miterZ * miterZ;
          if (mLenSq < 1e-12) continue;
          const mLen = Math.sqrt(mLenSq);
          miterX /= mLen;
          miterZ /= mLen;
          const denom = miterX * perpBX + miterZ * perpBZ;
          if (Math.abs(denom) < 0.2) {
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

// ─── Merge + normals (conventions from roadBaker.js mergeRibbons:466 /
//     computeVertexNormals:509 — output plain arrays per the bake contract) ────

function mergePlain(ribbons, withUvs) {
  const positions = [];
  const uvs = withUvs ? [] : null;
  const indices = [];
  let vertexOffset = 0;
  for (const r of ribbons) {
    for (let i = 0; i < r.positions.length; i++) positions.push(r.positions[i]);
    if (withUvs) for (let i = 0; i < r.uvs.length; i++) uvs.push(r.uvs[i]);
    for (let i = 0; i < r.indices.length; i++) indices.push(r.indices[i] + vertexOffset);
    vertexOffset += r.numVerts;
  }
  return { positions, uvs, indices };
}

// Same cross-product accumulation as roadBaker.js:509 — matches the runtime's
// merged.computeVertexNormals() (which overwrites any pre-set normals, including
// the curb face's hand-written ones, so computing here is behavior-identical).
function computeVertexNormals(positions, indices) {
  const numVerts = positions.length / 3;
  const normals = new Array(numVerts * 3).fill(0);

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

// ─── Sidewalk eligibility (ported from roadRenderer.js:1534) ─────────────────

const _NO_SIDEWALK_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'service', 'track', 'path', 'cycleway', 'footway', 'steps',
  'pedestrian', 'living_street',  // these ARE the walkable surface — no ribbon needed
]);

// roadRenderer.js:1539
function inferSidewalkSide(road) {
  const osm = road.sidewalk;
  if (osm === 'both' || osm === 'left' || osm === 'right') return osm;
  if (osm === 'no' || osm === 'none') return null;
  // No explicit OSM tag — infer from highway type
  if (_NO_SIDEWALK_TYPES.has(road.highwayType || '')) return null;
  return 'both';
}

// ─── Building proximity gate (ported from buildSidewalks, roadRenderer.js:1560) ──
// payload.buildings footprints are ALREADY world-relative [[x,z], ...]
// (buildingNormalize.js:147 maps pointsMercator through mercatorToWorld) — the
// same frame as the converted road points, so no conversion here. {x,y} point
// objects (the runtime binary-parsed shape) are accepted too, for safety.

function buildBuildingCentroids(buildings) {
  return (buildings || []).map((b) => {
    if (b.center) return { x: b.center.x, z: b.center.y };
    const fp = b.footprint || [];
    if (!fp.length) return null;
    let sx = 0, sz = 0;
    for (const p of fp) {
      if (Array.isArray(p)) { sx += p[0]; sz += p[1]; }
      else { sx += p.x; sz += p.y; }
    }
    return { x: sx / fp.length, z: sz / fp.length };
  }).filter(Boolean);
}

const BLDG_PROX_SQ = 30 * 30; // 30m building-proximity gate (roadRenderer.js:1568)

function hasBuildingNearby(pts, bldgCentroids) {
  if (!bldgCentroids.length) return false;
  for (const pt of pts) {
    for (const bc of bldgCentroids) {
      const dx = pt.x - bc.x, dz = pt.y - bc.z;
      if (dx * dx + dz * dz < BLDG_PROX_SQ) return true;
    }
  }
  return false;
}

// ─── Curb outer vertical face (ported from buildCurbs, roadRenderer.js:1765-1808) ──
// Runtime builds positions/normals/uvs, but merged.computeVertexNormals() then
// overwrites the normals and the curb material ignores the uvs' role for merging;
// here we emit positions + indices only and compute normals on the merged blob.

function buildCurbFaceGeometry(outerRun, bottomY, curbH) {
  const n = outerRun.length;
  if (n < 2) return null;
  const positions = new Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const p = outerRun[i];
    const yBottom = Array.isArray(bottomY) ? (bottomY[i] ?? bottomY[0]) : bottomY;
    const yTop = yBottom + curbH;
    const base = i * 2 * 3;
    positions[base]     = p.x; positions[base + 1] = yBottom; positions[base + 2] = p.y;
    positions[base + 3] = p.x; positions[base + 4] = yTop;    positions[base + 5] = p.y;
  }
  const indices = new Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices[i * 6]     = a; indices[i * 6 + 1] = c; indices[i * 6 + 2] = b;
    indices[i * 6 + 3] = b; indices[i * 6 + 4] = c; indices[i * 6 + 5] = d;
  }
  return { positions, indices, numVerts: n * 2 };
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Pre-bake sidewalk + curb geometry from a tile payload.
 * @param {object} payload - tile payload with .roads and .buildings
 * @returns {null | { sidewalk: {positions,normals,uvs,indices}, curbTop: {positions,normals,indices}, curbFace: {positions,normals,indices} }}
 */
export function bakeSidewalks(payload) {
  const rawRoads = payload?.roads || [];
  if (rawRoads.length === 0) return null;

  // Step 1: Convert road points from [mercX, yUp, mercY] (+ road.elevation raw-DEM
  // array) to {x, y: worldZ, elevation} in WORLD coords — same conversion as
  // roadBaker.js bakeRoadSurfaces step 1 (line 559).
  const convertedRoads = rawRoads.map((road) => ({
    ...road,
    points: (road.points || []).map((p, i) => {
      if (Array.isArray(p)) {
        const elev = road.elevation && road.elevation[i] != null ? road.elevation[i] : p[1];
        const world = mercatorToWorld(p[0], p[2]);
        return { x: world.x, y: world.z, elevation: elev };
      }
      return p;
    }),
  }));

  // Step 2: Ramp divergence — the runtime applies it to ALL roads before
  // buildSidewalks/buildCurbs (roadRenderer.js renderTileRoads:4465).
  const roads = applyRampDivergence(convertedRoads);

  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  const bldgCentroids = buildBuildingCentroids(payload?.buildings);

  const CURB_H = BCN_DIMS.CURB_HEIGHT;  // 0.12m
  const CURB_W = BCN_DIMS.CURB_WIDTH;   // 0.30m
  const SIDEWALK_Y_ABOVE = BCN_DIMS.CURB_HEIGHT; // sidewalk sits atop the curb

  const sidewalkRibbons = [];
  const curbTopRibbons = [];
  const curbFaceGeoms = [];

  for (const road of roads) {
    // Eligibility — identical for sidewalks and curbs (roadRenderer.js:1582-1589 / 1687-1694)
    const sidewalkSide = inferSidewalkSide(road);
    if (!sidewalkSide) continue;
    if (road.tunnel) continue;   // would float underground
    if (road.crossing) continue; // marked crossings live INSIDE the carriageway
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    if (!hasBuildingNearby(pts, bldgCentroids)) continue; // no adjacent urban context

    // NOTE: buildSidewalks/buildCurbs use this width formula (NOT getRoadWidth) —
    // ported verbatim from roadRenderer.js:1591 / 1696.
    // R-W1: was a NINTH width reading — `max(4, min(30, road.width || 6))`, its own clamp, disagreeing
    // with the ribbon it is supposed to sit beside. The kerb is one number now, and the sidewalk's
    // inner edge, the guard rail and the parking bay all hang off it.
    const roadWidth = Number(road.kerbToKerbW ?? road.width) || 6;
    const half = roadWidth / 2;

    // Raw DEM heights per road point (bake-side replacement for the runtime
    // getRoadPointHeights: NO ROAD_OFFSET / ROAD_VISUAL_ABOVE_TERRAIN here —
    // the frontend adds those when normalizing baked Y on read).
    const heights = pts.map((p) => (Number.isFinite(p.elevation) ? p.elevation : 0));

    const sides = sidewalkSide === 'left'  ? [-1] :
                  sidewalkSide === 'right' ? [+1] : [-1, +1];

    // ── Sidewalk ribbons (roadRenderer.js buildSidewalks:1554) ───────────────
    // R-W1: the width model states the sidewalk per road class, so use it. The roadWidth BANDS below
    // stay as the fallback for a road that reached here without a section — but note they are now
    // fed kerb-to-kerb rather than a 4 m carriageway, so they band differently than they used to.
    let swWidth = Number(road.sidewalkW);
    if (!Number.isFinite(swWidth) || swWidth <= 0) {
      if (roadWidth >= 25) swWidth = BCN_DIMS.SIDEWALK_WIDTH_BOULEVARD;
      else if (roadWidth < 12) swWidth = BCN_DIMS.SIDEWALK_WIDTH_NARROW;
      else swWidth = BCN_DIMS.SIDEWALK_WIDTH_EIXAMPLE;
    }
    if (swWidth <= 0.05) continue;   // motorways and shared surfaces have no sidewalk at all

    const baseY = heights.map((h) => h + SIDEWALK_Y_ABOVE);

    // Offset from centerline: road edge + curb + half sidewalk width
    const offsetFromCenter = half + BCN_DIMS.CURB_WIDTH + swWidth / 2;

    // Junction clip radius must exceed offsetFromCenter so the clip actually
    // reaches the offset polyline and trims the sidewalk before the intersection.
    const swJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS) + offsetFromCenter;

    for (const sign of sides) {
      const offsetPts = getOffsetPolyline(pts, sign * offsetFromCenter);
      const runs = junctionPoints.length > 0
        ? clipPolylineNearJunctions(offsetPts, junctionPoints, swJunctionRadius)
        : [offsetPts];

      for (const run of runs) {
        const runY = interpolateHeightsFromSource(pts, baseY, run);
        const g = buildFlatRibbonGeometry(run, swWidth, runY ?? baseY);
        if (!g) continue;

        // World-space UV mapping: 1 UV unit = PANOT_TILE_SIZE (0.2m).
        // Overwrite UVs using world positions (roadRenderer.js:1624-1633).
        const TILE_SCALE = 1 / BCN_DIMS.PANOT_TILE_SIZE; // 5 tiles per metre
        for (let vi = 0; vi < g.numVerts; vi++) {
          g.uvs[vi * 2]     = g.positions[vi * 3]     * TILE_SCALE;
          g.uvs[vi * 2 + 1] = g.positions[vi * 3 + 2] * TILE_SCALE;
        }
        sidewalkRibbons.push(g);
      }
    }

    // ── Curbs (roadRenderer.js buildCurbs:1659) ──────────────────────────────
    const curbOffset = half + CURB_W;
    const curbJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS) + curbOffset;

    for (const sign of sides) {
      // Curb outer edge sits at road edge (half from centerline);
      // curb inner edge is CURB_W further outward.
      const outerOffset = half;

      // Outer edge runs gate the whole curb for this side (runtime iterates
      // mid/face generation inside the outer-run loop; see deviation note in
      // the header — we emit each mid/outer run ONCE instead of once per outer
      // run, which avoids the runtime's duplicate re-emission when the outer
      // clip yields multiple runs; the rendered result is identical).
      const outerPts = getOffsetPolyline(pts, sign * outerOffset);
      const outerRuns = junctionPoints.length > 0
        ? clipPolylineNearJunctions(outerPts, junctionPoints, curbJunctionRadius)
        : [outerPts];
      if (!outerRuns.some((r) => r.length >= 2)) continue;

      // Quad A: TOP FACE — flat horizontal ribbon at curb top height,
      // centered between outer and inner edges (width = CURB_W).
      const midOffset = sign * (outerOffset + CURB_W / 2);
      const midPtsSimple = getOffsetPolyline(pts, midOffset);
      const midRunsSimple = junctionPoints.length > 0
        ? clipPolylineNearJunctions(midPtsSimple, junctionPoints, curbJunctionRadius)
        : [midPtsSimple];

      for (const midRun of midRunsSimple) {
        const roadH = interpolateHeightsFromSource(pts, heights, midRun);
        if (!roadH) continue;
        const topY = roadH.map((h) => h + CURB_H);
        const gTop = buildFlatRibbonGeometry(midRun, CURB_W, topY);
        if (gTop) curbTopRibbons.push(gTop);
      }

      // Quad B: OUTER VERTICAL FACE — vertical ribbon at road edge,
      // raw elevation → raw elevation + CURB_H (no zfight offset — matches the
      // runtime custom geometry, roadRenderer.js:1765).
      for (const outerRun of outerRuns) {
        if (outerRun.length < 2) continue;
        const bottomY = interpolateHeightsFromSource(pts, heights, outerRun);
        if (!bottomY) continue;
        const gFace = buildCurbFaceGeometry(outerRun, bottomY, CURB_H);
        if (gFace) curbFaceGeoms.push(gFace);
      }
    }
  }

  if (sidewalkRibbons.length === 0 && curbTopRibbons.length === 0 && curbFaceGeoms.length === 0) {
    return null;
  }

  // ── Merge sidewalk, clamp vertices outside roads, compute normals ──────────
  const swMerged = mergePlain(sidewalkRibbons, true);
  // Clamp AFTER merge, BEFORE normals — same ordering as the runtime pass
  // (roadRenderer.js:2437-2439). UVs keep their pre-clamp world-space values,
  // as at runtime. XZ only; baked raw Y is untouched, so the frontend's Y
  // normalization on read is unaffected.
  clampSidewalkVerticesOutsideRoads(roads, swMerged.positions);
  const swNormals = computeVertexNormals(swMerged.positions, swMerged.indices);

  const ctMerged = mergePlain(curbTopRibbons, false);
  const ctNormals = computeVertexNormals(ctMerged.positions, ctMerged.indices);

  const cfMerged = mergePlain(curbFaceGeoms, false);
  const cfNormals = computeVertexNormals(cfMerged.positions, cfMerged.indices);

  return {
    sidewalk: {
      positions: swMerged.positions,
      normals: swNormals,
      uvs: swMerged.uvs,
      indices: swMerged.indices,
    },
    curbTop: {
      positions: ctMerged.positions,
      normals: ctNormals,
      indices: ctMerged.indices,
    },
    curbFace: {
      positions: cfMerged.positions,
      normals: cfNormals,
      indices: cfMerged.indices,
    },
  };
}

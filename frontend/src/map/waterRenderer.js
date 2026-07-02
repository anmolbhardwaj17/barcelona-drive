/**
 * Water renderer: flat blue polygon for lakes/ponds/rivers from OSM water data.
 * Uses terrain elevation for proper Y positioning, Douglas-Peucker simplification.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getWorldElevationOffset } from '../elevationOffset.js';
import { CONFIG } from '../config.js';

/** How far below surrounding terrain the water surface sits (metres). */
export const WATER_DEPTH = 0.8;

/** Minimum water body area in m² — lowered to include river segments */
const MIN_WATER_AREA = 800; // ~28m × 28m

/** Compute polygon area using shoelace formula. Polygon: [{x, y}, ...] */
export function polygonArea(poly) {
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(area) / 2;
}

/** Sea level constant (used by road/railway renderers for pillar bottoms). */
export const SEA_LEVEL = 0;

/**
 * Test if a point (wx, wz) is inside a polygon [{x, y}...].
 */
export function pointInWaterPolygon(wx, wz, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].y;
    const xj = polygon[j].x, zj = polygon[j].y;
    if (((zi > wz) !== (zj > wz)) && (wx < (xj - xi) * (wz - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Douglas-Peucker simplification for water polygons ─────────────────────────

function perpDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker simplification for {x, y} polygon points.
 * @param {{x: number, y: number}[]} points
 * @param {number} tolerance - max distance in world units (metres)
 * @returns {{x: number, y: number}[]}
 */
function simplifyPolygonDP(points, tolerance = 2.0) {
  if (!points || points.length <= 4) return points; // triangle or less — keep as-is
  const n = points.length;
  // Check if closed (first === last) and handle ring simplification
  const isClosed = n >= 2 &&
    Math.abs(points[0].x - points[n - 1].x) < 1e-6 &&
    Math.abs(points[0].y - points[n - 1].y) < 1e-6;

  const pts = isClosed ? points.slice(0, -1) : points;
  if (pts.length <= 3) return points;

  // For closed rings, find the point farthest from centroid to use as split point
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;

  let maxDist = 0, splitIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - cx, pts[i].y - cy);
    if (d > maxDist) { maxDist = d; splitIdx = i; }
  }

  // Rotate so split point is at start for open-line DP
  const rotated = [...pts.slice(splitIdx), ...pts.slice(0, splitIdx)];
  const simplified = dpSimplify(rotated, tolerance);
  if (isClosed && simplified.length >= 3) {
    simplified.push({ ...simplified[0] }); // close ring
  }
  return simplified;
}

function dpSimplify(points, tolerance) {
  if (points.length <= 2) return [...points];
  let maxDist = 0, maxIdx = 0;
  const start = points[0], end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist2D(points[i].x, points[i].y, start.x, start.y, end.x, end.y);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= tolerance) return [start, end];
  const left = dpSimplify(points.slice(0, maxIdx + 1), tolerance);
  const right = dpSimplify(points.slice(maxIdx), tolerance);
  return [...left.slice(0, -1), ...right];
}

// ── Shared material — improved water appearance ──────────────────────────────

let _waterMat = null;
function getWaterMaterial() {
  if (_waterMat) return _waterMat;
  _waterMat = new THREE.MeshLambertMaterial({
    color: 0x1A7A9B,
    transparent: true,
    opacity: 0.92,
    side: THREE.FrontSide,
    depthWrite: false,      // don't write depth — prevents z-fighting at tile seams
  });
  return _waterMat;
}

let _pierMat = null;
function getPierMaterial() {
  if (_pierMat) return _pierMat;
  _pierMat = new THREE.MeshLambertMaterial({ color: 0x8a8a7a, side: THREE.DoubleSide });
  return _pierMat;
}

/** Normalized Y for sea level: (0m DEM − spawnElev) × vertExag */
function getSeaLevelY() {
  const offset = getWorldElevationOffset() ?? 0;
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION ?? 1;
  return (0 - offset) * vertExag;
}

const MARINA_TYPES = new Set(['marina', 'dock', 'basin']);
const PIER_TYPES   = new Set(['pier']);

/**
 * Build water mesh for a tile.
 * @param {object} tileData - { water: { id, polygon: {x,y}[] }[] }
 * @param {{ renderedWaterIds?: Set, getElevationAt?: Function, getWorldElevation?: Function }} [opts]
 * @returns {{ mesh: THREE.Mesh|null, embankmentMesh: THREE.Mesh|null, waterIds: (string|number)[] }}
 */
export function renderWater(tileData, opts = {}) {
  const renderedWaterIds = opts.renderedWaterIds || new Set();
  const getWorldElevation = opts.getWorldElevation || null;
  const rawAreas = tileData.water || [];
  // Marinas/docks from v7: split into water-body vs pier features
  const allMarinas = tileData.marinas || [];
  const marinaWaterPolys = allMarinas.filter(
    (m) => !m.isLine && m.polygon?.length >= 3 && MARINA_TYPES.has(m.type)
  ).map((m) => ({ id: `_m${m.id}`, polygon: m.polygon, type: m.type, isMarina: true }));
  const pierPolys = allMarinas.filter(
    (m) => !m.isLine && m.polygon?.length >= 3 && PIER_TYPES.has(m.type)
  );

  const skipCoastline  = !CONFIG.RENDER_COASTLINE_AS_POLYGONS;
  const skipOpenWater  = !CONFIG.RENDER_OPEN_WATER_AS_POLYGONS;
  const tileKey = opts.tileKey || null;

  // Open-polyline check: polygon is open when first point ≠ last point (gap ≥ 1m).
  // epsilon=1m excludes truly closed rings; stream ribbons have a gap equal to their
  // buffer width (5–10m), canals 10m — all caught. Marina/dock closed polygons have
  // gap≈0 and are unaffected (they arrive via marinaWaterPolys path, not rawAreas).
  const OPEN_POLY_EPS = 1.0; // metres
  function isOpenPolyline(polygon) {
    if (!polygon || polygon.length < 2) return false;
    const f = polygon[0], l = polygon[polygon.length - 1];
    return Math.hypot(f.x - l.x, f.y - l.y) >= OPEN_POLY_EPS;
  }

  let coastlineSkippedCount = 0;
  const openSkippedByType = {}; // type → count, for the log

  const waterAreas = [
    ...(Array.isArray(rawAreas)
      ? rawAreas.filter((a) => {
          if (a.id != null && renderedWaterIds.has(a.id)) return false;
          // Coastline filter (open polyline, but has its own flag for clarity)
          if (skipCoastline && a.type === 'coastline') {
            coastlineSkippedCount++;
            return false;
          }
          // Open-polyline filter — catches stream, canal, river, ditch, drain, etc.
          // Does NOT touch closed natural=water polygons (gap < 1m → passes through).
          // Does NOT touch marinaWaterPolys — those come from tileData.marinas[], not here.
          if (skipOpenWater && a.type !== 'coastline' && isOpenPolyline(a.polygon)) {
            openSkippedByType[a.type] = (openSkippedByType[a.type] || 0) + 1;
            return false;
          }
          return true;
        })
      : []),
    ...marinaWaterPolys.filter((m) => !renderedWaterIds.has(m.id)),
  ];

  // Per-tile log (this function is called exactly once per tile build)
  if (coastlineSkippedCount > 0 || Object.keys(openSkippedByType).length > 0) {
    const parts = [];
    if (coastlineSkippedCount > 0) parts.push(`coastline:${coastlineSkippedCount}`);
    const openTotal = Object.values(openSkippedByType).reduce((s, n) => s + n, 0);
    if (openTotal > 0) {
      const breakdown = Object.entries(openSkippedByType).map(([t, n]) => `${t}:${n}`).join(' ');
      parts.push(`open-polylines:${openTotal} (${breakdown})`);
    }
    console.log(
      `[Water${tileKey ? ' ' + tileKey : ''}] skipped ${parts.join(', ')}` +
      ` — ${waterAreas.length} feature(s) remain`
    );
  }

  // ── Pier mesh (elevated concrete above water) ─────────────────────────────
  let pierMesh = null;
  if (pierPolys.length > 0) {
    const seaY = getSeaLevelY();
    const pierY = seaY + 0.35; // piers sit 35 cm above water surface
    const pierGeos = [];
    for (const pier of pierPolys) {
      let poly = pier.polygon.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (poly.length < 3) continue;
      let cx = 0, cz = 0;
      for (const p of poly) { cx += p.x; cz += p.y; }
      cx /= poly.length; cz /= poly.length;
      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x - cx, -(poly[0].y - cz));
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x - cx, -(poly[i].y - cz));
      shape.closePath();
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, pierY, cz);
      pierGeos.push(g);
    }
    if (pierGeos.length > 0) {
      try {
        const merged = mergeGeometries(pierGeos);
        pierGeos.forEach((g) => g.dispose());
        if (merged) {
          pierMesh = new THREE.Mesh(merged, getPierMaterial());
          pierMesh.renderOrder = 4;
          pierMesh.frustumCulled = true;
        }
      } catch { pierGeos.forEach((g) => g.dispose()); }
    }
  }

  if (waterAreas.length === 0) return { mesh: null, embankmentMesh: pierMesh, waterIds: [] };

  const seaLevelY = getSeaLevelY();
  const geometries = [];
  const waterIds = [];

  for (const area of waterAreas) {
    if (area.id != null) waterIds.push(area.id);
    let poly = area.polygon || [];
    if (poly.length < 3) continue;

    poly = poly.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (poly.length < 3) continue;

    const area2d = polygonArea(poly);
    if (area2d < MIN_WATER_AREA) continue;

    const tolerance = area2d > 50000 ? 3.0 : (area2d > 10000 ? 2.0 : 1.0);
    poly = simplifyPolygonDP(poly, tolerance);
    if (poly.length < 3) continue;

    let cx = 0, cz = 0;
    for (const p of poly) { cx += p.x; cz += p.y; }
    cx /= poly.length;
    cz /= poly.length;

    // Marina/dock water: use a single globally consistent sea-level Y so all
    // tile portions of the same harbour are perfectly coplanar (no z-fighting).
    // Natural water (lake, river): sample terrain as before for correct height.
    let waterY;
    if (area.isMarina) {
      waterY = seaLevelY + 0.08; // just above normalized sea level, consistent across tiles
    } else if (getWorldElevation) {
      let minElev = getWorldElevation(cx, cz);
      const sampleCount = Math.min(8, poly.length);
      const step = Math.max(1, Math.floor(poly.length / sampleCount));
      for (let i = 0; i < poly.length; i += step) {
        const e = getWorldElevation(poly[i].x, poly[i].y);
        if (Number.isFinite(e) && e < minElev) minElev = e;
      }
      waterY = Number.isFinite(minElev) ? minElev - WATER_DEPTH : seaLevelY;
    } else {
      waterY = seaLevelY;
    }

    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x - cx, -(poly[0].y - cz));
    for (let i = 1; i < poly.length; i++) {
      shape.lineTo(poly[i].x - cx, -(poly[i].y - cz));
    }
    shape.closePath();

    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(cx, waterY, cz);
    geometries.push(geom);
  }

  if (geometries.length === 0) return { mesh: null, embankmentMesh: pierMesh, waterIds };

  let mesh = null;
  try {
    const merged = mergeGeometries(geometries);
    geometries.forEach(g => g.dispose());
    if (merged) {
      mesh = new THREE.Mesh(merged, getWaterMaterial());
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.renderOrder = 3; // after terrain (0), greens (1), roads (2)
      mesh.userData.type = 'water';
    }
  } catch (e) {
    console.error('[Water] Failed to create water mesh:', e);
    geometries.forEach(g => g.dispose());
  }

  return { mesh, embankmentMesh: pierMesh, waterIds };
}

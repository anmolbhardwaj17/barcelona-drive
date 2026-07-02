/**
 * Parse water features from OSM Overpass response: natural=water, waterway=riverbank, natural=coastline.
 * Output: water areas as closed polygons in Mercator.
 * Coastline: detects land/sea side from roads/buildings, clips tile by sea half-plane.
 */
import { latLonToMercator } from './projection.js';

const MAX_POLYGON_VERTICES = 200; // raised — DP simplification handles reduction better than uniform sampling
const MAX_COASTLINE_POLYGONS_PER_TILE = 10;
const SIDE_DETECTION_OFFSET = 80;
const LAND_DETECTION_RADIUS_SQ = 200 * 200;

function getWayPoints(way, nodesMap) {
  if (way.geometry && way.geometry.length > 0) {
    return way.geometry.map((n) => ({ lat: n.lat, lon: n.lon }));
  }
  const refs = way.nodes || [];
  return refs
    .map((id) => nodesMap.get(id))
    .filter(Boolean)
    .map((n) => ({ lat: n.lat, lon: n.lon }));
}

/** Douglas-Peucker simplification for {x, y} point arrays. */
function dpPerpDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function dpSimplifyLine(pts, tolerance) {
  if (pts.length <= 2) return [...pts];
  let maxDist = 0, maxIdx = 0;
  const s = pts[0], e = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dpPerpDist(pts[i].x, pts[i].y, s.x, s.y, e.x, e.y);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= tolerance) return [s, e];
  const left = dpSimplifyLine(pts.slice(0, maxIdx + 1), tolerance);
  const right = dpSimplifyLine(pts.slice(maxIdx), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyPolygon(polygon, maxVertices = MAX_POLYGON_VERTICES) {
  if (!polygon || polygon.length <= 4) return polygon;

  // Tolerance in Mercator units (meters) — adaptive based on polygon complexity
  const tolerance = polygon.length > 500 ? 3.0 : (polygon.length > 200 ? 2.0 : 1.0);

  const n = polygon.length;
  const isClosed = n >= 2 &&
    Math.abs(polygon[0].x - polygon[n - 1].x) < 1e-9 &&
    Math.abs(polygon[0].y - polygon[n - 1].y) < 1e-9;

  const pts = isClosed ? polygon.slice(0, -1) : polygon;
  if (pts.length <= 3) return polygon;

  // Find point farthest from centroid to use as split point for closed ring
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let maxD = 0, splitIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - cx, pts[i].y - cy);
    if (d > maxD) { maxD = d; splitIdx = i; }
  }
  const rotated = [...pts.slice(splitIdx), ...pts.slice(0, splitIdx)];
  let simplified = dpSimplifyLine(rotated, tolerance);

  // Hard cap — if still over maxVertices, apply larger tolerance
  if (simplified.length > maxVertices) {
    const bigTolerance = tolerance * Math.ceil(simplified.length / maxVertices);
    simplified = dpSimplifyLine(rotated, bigTolerance);
  }

  if (isClosed && simplified.length >= 3) {
    simplified.push({ ...simplified[0] });
  }
  return simplified;
}

/** Count road points and building footprint points within radiusSq of (px, py) in Mercator. */
function countLandFeaturesNear(px, py, roads, buildings, radiusSq) {
  let count = 0;
  for (const road of roads || []) {
    const pts = road.points || [];
    for (const p of pts) {
      const dx = p.x - px;
      const dy = (p.y || 0) - py;
      if (dx * dx + dy * dy <= radiusSq) {
        count += 1;
        break;
      }
    }
  }
  for (const b of buildings || []) {
    const fp = b.footprint || [];
    const cx = fp.length ? fp.reduce((s, p) => s + p.x, 0) / fp.length : 0;
    const cy = fp.length ? fp.reduce((s, p) => s + (p.y || 0), 0) / fp.length : 0;
    if ((cx - px) ** 2 + (cy - py) ** 2 <= radiusSq) count += 2;
  }
  return count;
}

/**
 * Determine which side of the coastline is sea.
 * Returns +1 if sea is in direction +normal, -1 if sea is in direction -normal.
 */
function detectSeaSide(coastlineMercator, tileMidMx, tileMidMy, roads, buildings) {
  if (coastlineMercator.length < 2) return 1;
  const midIdx = Math.floor(coastlineMercator.length / 2);
  const a = coastlineMercator[midIdx - 1];
  const b = coastlineMercator[midIdx];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const testPos = { x: midX + SIDE_DETECTION_OFFSET * nx, y: midY + SIDE_DETECTION_OFFSET * ny };
  const testNeg = { x: midX - SIDE_DETECTION_OFFSET * nx, y: midY - SIDE_DETECTION_OFFSET * ny };
  const countPos = countLandFeaturesNear(testPos.x, testPos.y, roads, buildings, LAND_DETECTION_RADIUS_SQ);
  const countNeg = countLandFeaturesNear(testNeg.x, testNeg.y, roads, buildings, LAND_DETECTION_RADIUS_SQ);
  return countPos < countNeg ? 1 : -1;
}

/** Sutherland-Hodgman: clip polygon by half-plane. Keep points where (p - on) · n >= 0. */
function clipPolygonByHalfPlane(polygon, onX, onY, nx, ny, keepInside) {
  if (!polygon || polygon.length < 3) return [];
  const out = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];
    const currD = (curr.x - onX) * nx + (curr.y - onY) * ny;
    const nextD = (next.x - onX) * nx + (next.y - onY) * ny;
    const currIn = (currD >= 0) === keepInside;
    const nextIn = (nextD >= 0) === keepInside;
    if (currIn) out.push({ ...curr });
    if (currIn !== nextIn) {
      const t = currD / (currD - nextD);
      out.push({
        x: curr.x + t * (next.x - curr.x),
        y: curr.y + t * (next.y - curr.y),
      });
    }
  }
  return out;
}

/** Check if segment (a,b) intersects tile bbox in Mercator. */
function segmentIntersectsTile(ax, ay, bx, by, tileMinX, tileMinY, tileMaxX, tileMaxY) {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  return minX <= tileMaxX && maxX >= tileMinX && minY <= tileMaxY && maxY >= tileMinY;
}

/**
 * Build sea polygon by clipping tile to sea side of coastline.
 * @param {number} south - bbox south (lat)
 * @param {number} west - bbox west (lon)
 * @param {number} north - bbox north (lat)
 * @param {number} east - bbox east (lon)
 * @param {Array<{x:number,y:number}>} coastlineMercator - coastline points in Mercator
 * @param {number} seaSideSign - +1 or -1 from detectSeaSide
 * @returns {{ polygon: { x: number, y: number }[] }|null}
 */
function buildCoastlineSeaPolygon(south, west, north, east, coastlineMercator, seaSideSign) {
  const sw = latLonToMercator(south, west);
  const se = latLonToMercator(south, east);
  const ne = latLonToMercator(north, east);
  const nw = latLonToMercator(north, west);
  const tileMinX = Math.min(sw.x, se.x, ne.x, nw.x);
  const tileMaxX = Math.max(sw.x, se.x, ne.x, nw.x);
  const tileMinY = Math.min(sw.y, se.y, ne.y, nw.y);
  const tileMaxY = Math.max(sw.y, se.y, ne.y, nw.y);

  let polygon = [
    { x: sw.x, y: sw.y },
    { x: se.x, y: se.y },
    { x: ne.x, y: ne.y },
    { x: nw.x, y: nw.y },
    { x: sw.x, y: sw.y },
  ];

  for (let i = 0; i < coastlineMercator.length - 1; i++) {
    const a = coastlineMercator[i];
    const b = coastlineMercator[i + 1];
    if (!segmentIntersectsTile(a.x, a.y, b.x, b.y, tileMinX, tileMinY, tileMaxX, tileMaxY)) continue;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (dy / len) * seaSideSign;
    const ny = (-dx / len) * seaSideSign;
    const onX = a.x;
    const onY = a.y;
    polygon = clipPolygonByHalfPlane(polygon, onX, onY, nx, ny, true);
    if (polygon.length < 3) return null;
    polygon.push({ ...polygon[0] });
  }

  if (polygon.length < 3) return null;
  const simplified = simplifyPolygon(polygon);
  if (simplified.length < 3) return null;
  return { polygon: simplified };
}

/**
 * Parse OSM JSON into water areas (closed polygons in Mercator).
 * @param {object} osmJson - Overpass API response
 * @param {string} [bboxStr] - "south,west,north,east" for coastline sea fill
 * @param {{ roads?: object[], buildings?: object[] }} [context] - for coastline side detection
 * @returns {{ waterAreas: { polygon: { x: number, y: number }[] }[] }}
 */
export function parseWater(osmJson, bboxStr, context = {}) {
  const elements = osmJson.elements || [];
  let waterTagCount = 0;
  let riverbankTagCount = 0;
  let coastlineTagCount = 0;
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.natural === 'water') waterTagCount += 1;
    if (tags.waterway === 'riverbank') riverbankTagCount += 1;
    if (tags.natural === 'coastline') coastlineTagCount += 1;
  }
  const waterCount = waterTagCount + riverbankTagCount;
  console.log('Water features (natural=water + waterway=riverbank):', waterCount);
  console.log('Coastline features (natural=coastline):', coastlineTagCount);
  if (bboxStr) console.log('Tile BBOX:', bboxStr);

  const nodesMap = new Map();
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodesMap.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }

  const waterAreas = [];
  const coastlineWays = [];

  for (const el of elements) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};

    if (tags.natural === 'coastline') {
      const points = getWayPoints(el, nodesMap);
      if (points.length >= 2) coastlineWays.push(points);
      continue;
    }

    const isWater = tags.natural === 'water' || tags.waterway === 'riverbank';
    if (!isWater) continue;

    const points = getWayPoints(el, nodesMap);
    if (points.length < 3) continue;

    const pointsMercator = points.map((p) => latLonToMercator(p.lat, p.lon));
    const closed =
      pointsMercator.length >= 3 &&
      pointsMercator[0].x === pointsMercator[pointsMercator.length - 1].x &&
      pointsMercator[0].y === pointsMercator[pointsMercator.length - 1].y
        ? pointsMercator
        : [...pointsMercator, pointsMercator[0]];
    const polygon = simplifyPolygon(closed.map(({ x, y }) => ({ x, y })));
    waterAreas.push({ polygon });
  }

  if (bboxStr && coastlineWays.length > 0) {
    const parts = bboxStr.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [south, west, north, east] = parts;
      const sw = latLonToMercator(south, west);
      const ne = latLonToMercator(north, east);
      const tileMidMx = (sw.x + ne.x) / 2;
      const tileMidMy = (sw.y + ne.y) / 2;
      const { roads = [], buildings = [] } = context;
      let added = 0;

      for (const wayPoints of coastlineWays) {
        if (added >= MAX_COASTLINE_POLYGONS_PER_TILE) break;
        const coastlineMercator = wayPoints.map((p) => latLonToMercator(p.lat, p.lon));
        const seaSideSign = detectSeaSide(coastlineMercator, tileMidMx, tileMidMy, roads, buildings);
        const seaPoly = buildCoastlineSeaPolygon(south, west, north, east, coastlineMercator, seaSideSign);
        if (seaPoly && seaPoly.polygon.length >= 3) {
          waterAreas.push(seaPoly);
          added += 1;
        }
      }
    }
  }

  console.log('Water polygons generated:', waterAreas.length);
  if (waterAreas.length === 0) {
    console.warn('No water polygons generated for this tile.');
  }

  return { waterAreas, waterCount, coastlineCount: coastlineTagCount, waterPolygonCount: waterAreas.length };
}

/**
 * Normalize water features and split by tile.
 * correctness-first: bbox-intersect assignment. Full geometry per tile. No clipping.
 */
import { mercatorToWorld, worldToMercator, getOriginMercator, mercatorToLatLon, latLonToTile, tileToBBox } from '../projection.js';

const WATER_WIDTH_RIVER = 40;  // Major rivers like Yamuna are 200-500m but OSM often has area polygons; this is for linestring fallback
const WATER_WIDTH_STREAM = 5;
const WATER_WIDTH_CANAL = 10;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

function parseWidthTag(tags) {
  const w = getTag(tags, 'width');
  if (!w) return null;
  const m = w.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/** Bbox intersect: true if a and b overlap. */
function bboxIntersects(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

/** Buffer a polyline into a polygon with averaged normals at joints for smooth curves. */
function bufferPolyline(points, halfWidth) {
  if (!points || points.length < 2 || halfWidth <= 0) return [];
  const o = getOriginMercator();
  const pts = points.map((p) => {
    const w = mercatorToWorld(p.x, p.y);
    return { x: w.x, z: w.z };
  });

  // Compute per-vertex averaged normals for smooth buffering at bends
  const normals = [];
  for (let i = 0; i < pts.length; i++) {
    let nx = 0, nz = 0;
    if (i < pts.length - 1) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      const len = Math.hypot(dx, dz) || 1e-10;
      nx += -dz / len;
      nz += dx / len;
    }
    if (i > 0) {
      const dx = pts[i].x - pts[i - 1].x;
      const dz = pts[i].z - pts[i - 1].z;
      const len = Math.hypot(dx, dz) || 1e-10;
      nx += -dz / len;
      nz += dx / len;
    }
    const nlen = Math.hypot(nx, nz) || 1e-10;
    normals.push({ x: nx / nlen, z: nz / nlen });
  }

  // Build left and right offset paths
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    left.push([pts[i].x + normals[i].x * halfWidth, pts[i].z + normals[i].z * halfWidth]);
    right.push([pts[i].x - normals[i].x * halfWidth, pts[i].z - normals[i].z * halfWidth]);
  }

  // Close: left forward, right backward
  const poly = [...left, ...right.reverse()];
  return poly;
}

/** Convert polygon (real-metre world [x,z]) to polygonMercator for API payload (Unstretch-X). */
function worldToMercatorPolygon(poly) {
  return poly.map(([x, z]) => worldToMercator(x, z));
}

/**
 * Normalize one raw water feature.
 * @param {{ id, type, pointsMercator, closed, waterwayType?, tags }} raw
 * @returns {{ id, type, polygon, polygonMercator, width?, closed }}
 */
export function normalizeWater(raw) {
  const pts = raw.pointsMercator || [];
  let polygon = pts.map((p) => {
    const w = mercatorToWorld(p.x, p.y);
    return [w.x, w.z];
  });

  let width = null;
  if (raw.type === 'river' || raw.type === 'stream' || raw.type === 'canal') {
    width = parseWidthTag(raw.tags || {});
    if (width == null) {
      if (raw.type === 'river') width = WATER_WIDTH_RIVER;
      else if (raw.type === 'stream') width = WATER_WIDTH_STREAM;
      else width = WATER_WIDTH_CANAL;
    }
    width = Math.max(2, Math.min(50, width));
    const halfWidth = width / 2;
    polygon = bufferPolyline(pts, halfWidth);
  }

  const closed = raw.closed && pts.length >= 3;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const isClosed =
    first &&
    last &&
    Math.abs(first.x - last.x) < 1e-9 &&
    Math.abs(first.y - last.y) < 1e-9;

  const polygonMercator =
    polygon.length >= 3
      ? worldToMercatorPolygon(polygon)
      : pts.map((p) => ({ x: p.x, y: p.y }));

  return {
    id: raw.id,
    type: raw.type,
    polygon,
    polygonMercator,
    width: width ?? null,
    closed: closed || isClosed,
  };
}

/**
 * Split waters by tile using bbox-intersect. If water bbox intersects tile bbox, include FULL geometry.
 * No clipping. Waters may appear in multiple tiles. Frontend dedupes by id.
 */
export function splitWatersByTile(waters, zoom, bbox) {
  const o = getOriginMercator();
  const tiles = new Map();

  const minT = latLonToTile(bbox.maxLat, bbox.minLon, zoom);
  const maxT = latLonToTile(bbox.minLat, bbox.maxLon, zoom);
  const minTileX = Math.min(minT.x, maxT.x);
  const maxTileX = Math.max(minT.x, maxT.x);
  const minTileY = Math.min(minT.y, maxT.y);
  const maxTileY = Math.max(minT.y, maxT.y);

  for (const w of waters) {
    const poly = w.polygon || [];
    if (poly.length < 2) continue;

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [x, z] of poly) {
      const { x: mx, y: my } = worldToMercator(x, z);  // real-metre world (Unstretch-X)
      const { lat, lon } = mercatorToLatLon(mx, my);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    const waterBbox = { minLon, maxLon, minLat, maxLat };

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tileBbox = tileToBBox(tx, ty, zoom);
        if (!bboxIntersects(waterBbox, tileBbox)) continue;
        const key = `${zoom}_${tx}_${ty}`;
        if (!tiles.has(key)) tiles.set(key, []);
        tiles.get(key).push(w);
      }
    }
  }
  return tiles;
}

/**
 * Parse vegetation from OSM Overpass response: trees (nodes) and green areas (ways).
 * Output is Mercator only. No tree cap; frontend caps total instances per tile.
 * Polygon simplification preserves shape for large areas.
 */
import { latLonToMercator } from './projection.js';

const MAX_POLYGON_VERTICES = 80;

/**
 * Deterministic seeded random in [0, 1). Same seed => same sequence.
 * @param {number} seed
 * @returns {number}
 */
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Fisher–Yates shuffle with seeded random. Mutates array and returns it.
 * @param {any[]} arr
 * @param {string} seed
 * @returns {any[]}
 */
function deterministicShuffle(arr, seed) {
  let s = 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s + 1) * 0.618033988749895;
    const j = Math.floor(seededRandom(seed.length + s + i) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Reduce polygon to at most maxVertices points. Keeps first, last, and evenly spaced in between.
 * @param {{ x: number, y: number }[]} polygon
 * @param {number} maxVertices
 * @returns {{ x: number, y: number }[]}
 */
function simplifyPolygon(polygon, maxVertices = MAX_POLYGON_VERTICES) {
  if (!polygon || polygon.length <= maxVertices) return polygon;
  const out = [];
  out.push(polygon[0]);
  const n = polygon.length;
  const closed = n >= 2 && polygon[0].x === polygon[n - 1].x && polygon[0].y === polygon[n - 1].y;
  const lastIdx = closed ? n - 2 : n - 1;
  if (lastIdx <= 0) return polygon;
  const step = (lastIdx - 0) / (maxVertices - 2);
  for (let i = 1; i < maxVertices - 1; i++) {
    const idx = Math.min(Math.floor(i * step), lastIdx);
    out.push(polygon[idx]);
  }
  if (closed) out.push({ ...polygon[0] });
  else out.push(polygon[n - 1]);
  return out;
}

/**
 * Get way points from OSM element (geometry or node refs).
 * @param {object} way
 * @param {Map<number, {lat: number, lon: number}>} nodesMap
 * @returns {{lat: number, lon: number}[]}
 */
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

/**
 * Parse OSM JSON into vegetation: trees (Mercator points) and green areas (polygons in Mercator).
 * Always returns { trees, greenAreas }. Trees capped at MAX_TREES_PER_TILE; if above TREE_SAMPLE_ABOVE, randomly sampled with seed.
 * @param {object} osmJson - Overpass API response
 * @param {string} [seed=''] - Optional seed for deterministic tree sampling (e.g. bbox string)
 * @returns {{ trees: { x: number, y: number }[], greenAreas: { id: number, type: 'park'|'grass'|'wood', polygon: { x: number, y: number }[] }[] }}
 */
export function parseVegetation(osmJson, seed = '') {
  const elements = osmJson.elements || [];
  const nodesMap = new Map();
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodesMap.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }

  const trees = [];
  const greenAreas = [];

  for (const el of elements) {
    if (el.type === 'node') {
      const tags = el.tags || {};
      if (tags.natural === 'tree') {
        const { x, y } = latLonToMercator(el.lat, el.lon);
        trees.push({ x, y });
      }
      continue;
    }

    if (el.type === 'way') {
      const tags = el.tags || {};
      let type = null;
      if (tags.natural === 'wood') type = 'wood';
      else if (tags.landuse === 'grass') type = 'grass';
      else if (tags.leisure === 'park') type = 'park';
      if (!type) continue;

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
      greenAreas.push({
        id: el.id,
        type,
        polygon,
      });
    }
  }

  return {
    trees,
    greenAreas,
  };
}

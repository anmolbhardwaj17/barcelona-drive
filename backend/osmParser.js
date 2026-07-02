/**
 * Parse OSM Overpass JSON into nodes map and ways with coordinates.
 * Uses geometry from Overpass "geom" output when present.
 */
import { latLonToMercator } from './projection.js';

/**
 * Build node id -> {lat, lon} from OSM elements.
 * Prefer geometry from way when present (Overpass out geom).
 * @param {object} osmJson - Overpass API response
 * @returns {Map<number, {lat: number, lon: number}>}
 */
function buildNodesMap(osmJson) {
  const nodes = new Map();
  const elements = osmJson.elements || [];
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodes.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }
  return nodes;
}

/**
 * Get points for a way: use geometry if present (Overpass geom), else resolve node refs.
 * @param {object} way - OSM way element
 * @param {Map<number, {lat, lon}>} nodesMap
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
 * Get tag value or default.
 * @param {object} el - OSM element with tags
 * @param {string} key
 * @param {string} [def='']
 * @returns {string}
 */
function getTag(el, key, def = '') {
  const tags = el.tags || {};
  return tags[key] != null ? String(tags[key]) : def;
}

/**
 * Parse OSM JSON into roads, buildings, railways, and landuse polygons (for procedural infill).
 * @param {object} osmJson - Overpass API response
 * @returns {{ roads: object[], buildings: object[], railways: object[], landuse: object[] }}
 */
export function parseOSM(osmJson) {
  const nodesMap = buildNodesMap(osmJson);
  const roads = [];
  const buildings = [];
  const railways = [];
  const landuse = [];

  const elements = osmJson.elements || [];
  for (const el of elements) {
    if (el.type !== 'way') continue;

    const points = getWayPoints(el, nodesMap);
    const pointsMercator = points.map((p) => latLonToMercator(p.lat, p.lon));

    if (getTag(el, 'highway')) {
      const layerTag = getTag(el, 'layer');
      const layer = layerTag === '' ? 0 : parseInt(layerTag, 10);
      roads.push({
        id: el.id,
        name: getTag(el, 'name'),
        highwayType: getTag(el, 'highway'),
        tags: el.tags || {},
        tunnel: getTag(el, 'tunnel') === 'yes',
        bridge: getTag(el, 'bridge') === 'yes',
        layer: Number.isFinite(layer) ? layer : 0,
        points: pointsMercator.map(({ x, y }) => ({ x, y })),
      });
      continue;
    }

    const railwayType = getTag(el, 'railway');
    if (railwayType === 'rail' || railwayType === 'light_rail' || railwayType === 'subway' || railwayType === 'tram') {
      const layerTag = getTag(el, 'layer');
      const layer = layerTag === '' ? 0 : parseInt(layerTag, 10);
      railways.push({
        id: el.id,
        railwayType,
        layer: Number.isFinite(layer) ? layer : 0,
        bridge: getTag(el, 'bridge') === 'yes',
        tunnel: getTag(el, 'tunnel') === 'yes',
        points: pointsMercator.map(({ x, y }) => ({ x, y })),
      });
      continue;
    }

    if (getTag(el, 'building')) {
      const closed =
        points.length >= 3 &&
        points[0].lat === points[points.length - 1].lat &&
        points[0].lon === points[points.length - 1].lon
          ? pointsMercator
          : [...pointsMercator, pointsMercator[0]];
      buildings.push({
        id: el.id,
        tags: el.tags || {},
        pointsMercator: closed.map(({ x, y }) => ({ x, y })),
      });
      continue;
    }

    const landuseType = getTag(el, 'landuse');
    if (landuseType === 'residential' || landuseType === 'commercial') {
      if (points.length >= 3) {
        const closed =
          points[0].lat === points[points.length - 1].lat && points[0].lon === points[points.length - 1].lon
            ? pointsMercator
            : [...pointsMercator, pointsMercator[0]];
        landuse.push({
          id: el.id,
          type: landuseType,
          polygon: closed.map(({ x, y }) => ({ x, y })),
        });
      }
    }
  }

  return { roads, buildings, railways, landuse };
}

/**
 * Normalize raw PBF green area to tile v5 schema.
 * Type: park, garden, forest, grass, playground, scrub, generic_green.
 * Polygon: world-relative [[x,z], ...].
 */
import { mercatorToWorld, worldToMercator, getOriginMercator, mercatorToLatLon, latLonToTile } from '../projection.js';

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase().replace(/\s+/g, '_') : def;
}

function normalizeGreenType(tags) {
  const leisure = getTag(tags, 'leisure');
  if (leisure === 'park') return 'park';
  if (leisure === 'garden') return 'garden';
  if (leisure === 'playground') return 'playground';
  const landuse = getTag(tags, 'landuse');
  if (landuse === 'park' || landuse === 'recreation_ground') return 'park';
  if (landuse === 'forest') return 'forest';
  if (landuse === 'grass' || landuse === 'meadow') return 'grass';
  const natural = getTag(tags, 'natural');
  if (natural === 'wood' || natural === 'forest') return 'forest';
  if (natural === 'grassland') return 'grass';
  if (natural === 'scrub') return 'scrub';
  return 'generic_green';
}

/**
 * Normalize one raw green (id, tags, pointsMercator) to v5 schema.
 * @param {{ id: number, tags: object, pointsMercator: { x, y }[] }} raw
 * @returns {{ id: number, polygon: [number, number][], type: string }}
 */
export function normalizeGreen(raw) {
  const tags = raw.tags || {};
  const type = normalizeGreenType(tags);
  const polygon = (raw.pointsMercator || []).map((p) => {
    const w = mercatorToWorld(p.x, p.y);
    return [w.x, w.z];
  });
  return { id: raw.id, polygon, type };
}

/**
 * Split normalized greens by tile (by centroid).
 */
export function splitGreensByTile(greens, zoom) {
  const o = getOriginMercator();
  const tiles = new Map();
  for (const g of greens) {
    const poly = g.polygon || [];
    if (poly.length < 3) continue;
    const n =
      poly.length -
      (poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1] ? 1 : 0);
    if (n === 0) continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += poly[i][0];
      cz += poly[i][1];
    }
    cx /= n;
    cz /= n;
    const { x: mx, y: my } = worldToMercator(cx, cz);  // world centroid is real-metre (Unstretch-X)
    const { lat, lon } = mercatorToLatLon(mx, my);
    const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
    const key = `${zoom}_${tx}_${ty}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(g);
  }
  return tiles;
}

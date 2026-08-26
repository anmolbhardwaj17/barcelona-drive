/**
 * Normalize raw PBF green area to tile v5 schema.
 * Type: park, garden, forest, grass, playground, scrub, generic_green.
 * Polygon: world-relative [[x,z], ...].
 */
import { mercatorToWorld, worldToMercator, getOriginMercator, mercatorToLatLon, latLonToTile, latLonToMercator } from '../projection.js';

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
/**
 * Assign each green area to EVERY tile it overlaps, clipped to that tile.
 *
 * This used to assign a green to exactly ONE tile — the one containing its centroid. For a plaza
 * garden that is fine and it is why nobody noticed. For a Collserola forest ring spanning a dozen
 * tiles, the entire polygon landed in whichever tile held its centroid and every other tile it
 * covered got nothing: measured after the relation fix, the bake produced 150 rings from relations
 * region-wide and the Collserola tiles still reported ZERO greens. Large woodland is exactly the
 * shape multipolygon relations produce, so the two bugs hid each other.
 *
 * Each tile receives the polygon CLIPPED to its own bounds plus a margin. Clipping rather than
 * duplicating whole is what keeps a park-sized polygon from being copied into twenty tiles at full
 * vertex count; the margin keeps vegetation continuous across the seam.
 */
const TILE_CLIP_MARGIN_M = 40;   // metres of overlap, so scatter does not stop dead at a tile edge

/** Sutherland-Hodgman clip of a polygon against an axis-aligned rect. */
function clipToRect(poly, minX, minZ, maxX, maxZ) {
  const edges = [
    (p) => p[0] >= minX, (p) => p[0] <= maxX,
    (p) => p[1] >= minZ, (p) => p[1] <= maxZ,
  ];
  const isect = [
    (a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])],
    (a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (minZ - a[1])) / (b[1] - a[1]), minZ],
    (a, b) => [a[0] + ((b[0] - a[0]) * (maxZ - a[1])) / (b[1] - a[1]), maxZ],
  ];
  let out = poly;
  for (let e = 0; e < 4; e++) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prv = inp[(i + inp.length - 1) % inp.length];
      const curIn = edges[e](cur);
      const prvIn = edges[e](prv);
      if (curIn) {
        if (!prvIn) out.push(isect[e](prv, cur));
        out.push(cur);
      } else if (prvIn) {
        out.push(isect[e](prv, cur));
      }
    }
    if (out.length === 0) return null;
  }
  return out;
}

export function splitGreensByTile(greens, zoom) {
  const tiles = new Map();
  for (const g of greens) {
    const poly = g.polygon || [];
    if (poly.length < 3) continue;

    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (const p of poly) {
      if (p[0] < mnX) mnX = p[0]; if (p[0] > mxX) mxX = p[0];
      if (p[1] < mnZ) mnZ = p[1]; if (p[1] > mxZ) mxZ = p[1];
    }

    // Tile range the polygon's bbox touches. World corners -> lat/lon -> tile indices. Y is
    // inverted between world Z and tile Y, so both corners are converted and then min/maxed.
    const corners = [[mnX, mnZ], [mxX, mnZ], [mnX, mxZ], [mxX, mxZ]].map(([x, z]) => {
      const m = worldToMercator(x, z);
      const ll = mercatorToLatLon(m.x, m.y);
      return latLonToTile(ll.lat, ll.lon, zoom);
    });
    const tx0 = Math.min(...corners.map((c) => c.x)), tx1 = Math.max(...corners.map((c) => c.x));
    const ty0 = Math.min(...corners.map((c) => c.y)), ty1 = Math.max(...corners.map((c) => c.y));

    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const b = tileWorldBounds(tx, ty, zoom);
        if (!b) continue;
        const clipped = (tx0 === tx1 && ty0 === ty1)
          ? poly   // wholly inside one tile — no need to clip, and no vertices to lose
          : clipToRect(poly,
              b.minX - TILE_CLIP_MARGIN_M, b.minZ - TILE_CLIP_MARGIN_M,
              b.maxX + TILE_CLIP_MARGIN_M, b.maxZ + TILE_CLIP_MARGIN_M);
        if (!clipped || clipped.length < 3) continue;
        const key = `${zoom}_${tx}_${ty}`;
        if (!tiles.has(key)) tiles.set(key, []);
        tiles.get(key).push(clipped === poly ? g : { ...g, polygon: clipped });
      }
    }
  }
  return tiles;
}

/** Inverse of latLonToTile — the NW corner of a slippy tile. */
function tileToLatLon(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lat: (latRad * 180) / Math.PI, lon };
}

/** World-space bounds of a tile, in the same real-metre frame as green.polygon. */
function tileWorldBounds(tx, ty, zoom) {
  const nw = tileToLatLon(tx, ty, zoom);
  const se = tileToLatLon(tx + 1, ty + 1, zoom);
  if (!nw || !se) return null;
  const mnw = latLonToMercator(nw.lat, nw.lon);
  const mse = latLonToMercator(se.lat, se.lon);
  const a = mercatorToWorld(mnw.x, mnw.y);
  const c = mercatorToWorld(mse.x, mse.y);
  return {
    minX: Math.min(a.x, c.x), maxX: Math.max(a.x, c.x),
    minZ: Math.min(a.z, c.z), maxZ: Math.max(a.z, c.z),
  };
}


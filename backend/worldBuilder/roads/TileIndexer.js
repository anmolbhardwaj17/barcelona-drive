/**
 * TileIndexer: assign ways to tiles by bbox intersection. No centroid/center logic.
 * If way bbox intersects tile bbox, include way. Clip geometry to tile bounds.
 * Never delete full way because center is outside.
 */
import { latLonToTile, tileToBBox, latLonToMercator } from '../projection.js';
import { tileMercatorBounds, clipRoadsForTile } from '../tileSplit.js';
import { buildRoadIndex } from './roadSpatialIndex.js';

/**
 * Get tile IDs in region bbox at zoom.
 */
export function getTileIdsInBbox(bbox, zoom) {
  const minT = latLonToTile(bbox.maxLat, bbox.minLon, zoom);
  const maxT = latLonToTile(bbox.minLat, bbox.maxLon, zoom);
  const minX = Math.min(minT.x, maxT.x);
  const maxX = Math.max(minT.x, maxT.x);
  const minY = Math.min(minT.y, maxT.y);
  const maxY = Math.max(minT.y, maxT.y);
  const ids = [];
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      ids.push(`${zoom}_${tx}_${ty}`);
    }
  }
  return ids;
}

/**
 * Assign roads to tiles. Uses bbox intersection only.
 * @param {object[]} roads - Each { points: [[x,y,z],...], ... }
 * @param {object} bbox - { minLon, minLat, maxLon, maxLat }
 * @param {number} zoom
 * @param {number} margin - tile boundary margin (m)
 * @returns {{ index: object, tileIds: string[] }}
 */
export function buildTileIndex(roads, bbox, zoom, margin = 0) {
  const roadIndex = buildRoadIndex(roads);
  const tileIds = getTileIdsInBbox(bbox, zoom);
  return { index: roadIndex, tileIds, zoom, margin };
}

/**
 * Get roads for a tile. Bbox-intersect only; clip geometry.
 * @param {object} roadIndex - from buildRoadIndex
 * @param {object[]} roads - full roads array
 * @param {string} tileId - "z_x_y"
 * @param {number} margin
 * @returns {object[]}
 */
export function getRoadsForTile(roadIndex, roads, tileId, margin = 0) {
  const [zStr, xStr, yStr] = tileId.split('_');
  const tx = parseInt(xStr, 10);
  const ty = parseInt(yStr, 10);
  const zoom = parseInt(zStr, 10);
  const bounds = tileMercatorBounds(tx, ty, zoom, margin);
  const indices = roadIndex.query(bounds);
  const subset = indices.map((i) => ({
    ...roads[i],
    points: roads[i].points.map((p) => [...p]),
  }));
  return clipRoadsForTile(subset, bounds);
}

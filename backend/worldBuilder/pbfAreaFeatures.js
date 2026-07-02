/**
 * pbfAreaFeatures.js
 *
 * Parse beaches, pedestrian areas, and marina/dock/pier features from OSM PBF.
 * Single two-pass scan covers all three feature types to avoid re-streaming the PBF.
 *
 * Pass 1: collect nodes in bbox + margin
 * Pass 2: scan ways for qualifying features
 *
 * Returns: { beaches, pedestrianAreas, marinas }
 *   beaches[]        — natural=beach|sand, landuse=beach
 *   pedestrianAreas[] — highway=pedestrian area=yes, highway=footway area=yes,
 *                       highway=pedestrian closed way (implicit area)
 *   marinas[]        — leisure=marina, waterway=dock, man_made=pier
 *
 * All polygon features are returned with:
 *   { id, type: string, pointsMercator: [{ x, y }], isLine: bool }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator, worldToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_MARGIN = 0.02;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase() : def;
}

function nodeInBbox(lat, lon, bbox, margin = 0) {
  return (
    lon >= bbox.minLon - margin && lon <= bbox.maxLon + margin &&
    lat >= bbox.minLat - margin && lat <= bbox.maxLat + margin
  );
}

function isBeachWay(tags) {
  const natural = getTag(tags, 'natural');
  if (natural === 'beach' || natural === 'sand') return 'beach';
  const landuse = getTag(tags, 'landuse');
  if (landuse === 'beach') return 'beach';
  return null;
}

function isPedestrianAreaWay(tags) {
  const highway = getTag(tags, 'highway');
  if (highway !== 'pedestrian' && highway !== 'footway') return null;
  const areaTag = getTag(tags, 'area');
  // Explicit area=yes, OR pedestrian way that is a closed loop (implicit area)
  if (areaTag === 'yes' || highway === 'pedestrian') return highway;
  return null;
}

function isMarinaDockPier(tags) {
  const leisure = getTag(tags, 'leisure');
  if (leisure === 'marina') return { type: 'marina', isLine: false };
  const waterway = getTag(tags, 'waterway');
  if (waterway === 'dock') return { type: 'dock', isLine: false };
  const manMade = getTag(tags, 'man_made');
  if (manMade === 'pier') return { type: 'pier', isLine: false }; // piers can be areas or lines; treat as polygon either way
  return null;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  return fs.createReadStream(resolved).pipe(parseOSM());
}

async function collectNodesInBbox(pbfPath, bbox, onProgress) {
  const through2 = (await import('through2')).default;
  const nodes = new Map();
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream.pipe(through2.obj(function (items, enc, next) {
      for (const item of items) {
        if (item.type !== 'node' || item.lat == null || item.lon == null) continue;
        if (!nodeInBbox(item.lat, item.lon, bbox, NODE_MARGIN)) continue;
        nodes.set(item.id, { lat: item.lat, lon: item.lon });
      }
      chunks++;
      if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'area-nodes');
      next();
    })).on('finish', resolve).on('error', reject);
  });
  return nodes;
}

/**
 * Parse PBF and return all three area feature types.
 * @param {string} pbfPath
 * @param {{ minLon, minLat, maxLon, maxLat }} bbox
 * @param {Function} [onProgress]
 * @returns {Promise<{ beaches: object[], pedestrianAreas: object[], marinas: object[] }>}
 */
export async function parsePbfAreaFeatures(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (area features):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);

  const beaches = [];
  const pedestrianAreas = [];
  const marinas = [];

  const through2 = (await import('through2')).default;
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;

  console.log('  Pass 2: scanning ways for beaches, pedestrian areas, marinas...');
  await new Promise((resolve, reject) => {
    stream.pipe(through2.obj(function (items, enc, next) {
      for (const item of items) {
        if (item.type !== 'way') continue;
        const tags = item.tags || {};
        const refs = item.refs || item.nodes || [];
        if (!refs.length) continue;

        // Must touch bbox
        if (!refs.some((ref) => nodes.has(ref))) continue;

        // Resolve points
        const pts = refs.map((ref) => nodes.get(ref)).filter(Boolean);
        if (pts.length < 2) continue;

        // Must have at least one point strictly inside bbox
        const hasInside = pts.some((p) => nodeInBbox(p.lat, p.lon, bbox));
        if (!hasInside) continue;

        // Check if closed ring (first === last node ref)
        const isClosed = refs.length >= 4 && refs[0] === refs[refs.length - 1];

        const pointsMercator = pts.map((p) => {
          const m = latLonToMercator(p.lat, p.lon);
          return { x: m.x, y: m.y };
        });
        // Close the ring if not already closed
        const first = pointsMercator[0];
        const last  = pointsMercator[pointsMercator.length - 1];
        const ring  = (first.x === last.x && first.y === last.y)
          ? pointsMercator
          : [...pointsMercator, { x: first.x, y: first.y }];

        const beachType = isBeachWay(tags);
        if (beachType) {
          if (ring.length >= 4) {
            beaches.push({ id: item.id, type: beachType, pointsMercator: ring, isLine: false });
          }
          continue; // don't double-count
        }

        const pedType = isPedestrianAreaWay(tags);
        if (pedType) {
          // Only accept closed-loop ways (actual area, not just a pedestrian street)
          if (isClosed && ring.length >= 4) {
            pedestrianAreas.push({ id: item.id, type: pedType, pointsMercator: ring, isLine: false });
          }
          continue;
        }

        const marinaResult = isMarinaDockPier(tags);
        if (marinaResult) {
          if (ring.length >= 3) {
            marinas.push({
              id: item.id,
              type: marinaResult.type,
              pointsMercator: ring,
              isLine: !isClosed && ring.length < 4,
            });
          }
        }
      }
      chunks++;
      if (onProgress && chunks % 50 === 0) onProgress(beaches.length + pedestrianAreas.length + marinas.length, chunks, 'area-ways');
      next();
    })).on('finish', resolve).on('error', reject);
  });

  console.log('  Beaches:', beaches.length, '  Pedestrian areas:', pedestrianAreas.length, '  Marinas/docks/piers:', marinas.length);
  return { beaches, pedestrianAreas, marinas };
}

/**
 * Normalize area features to tile v7 schema.
 * Input: { id, type, pointsMercator: [{x,y}], isLine }
 * Output: { id, type, polygon: [[wx,wz], ...], isLine }
 */
export function normalizeAreaFeature(raw, mercatorToWorld) {
  const polygon = (raw.pointsMercator || []).map((p) => {
    const w = mercatorToWorld(p.x, p.y);
    return [w.x, w.z];
  });
  return { id: raw.id, type: raw.type, polygon, isLine: !!raw.isLine };
}

/**
 * Split normalized area features into per-tile buckets by centroid.
 * @param {object[]} features - normalized { id, polygon, type, isLine }
 * @param {number} zoom
 * @param {Function} mercatorToLatLon
 * @param {Function} latLonToTile
 * @param {Function} getOriginMercator
 * @returns {Map<string, object[]>}
 */
export function splitAreaFeaturesByTile(features, zoom, mercatorToLatLon, latLonToTile, getOriginMercator) {
  const o = getOriginMercator();
  const tiles = new Map();
  for (const f of features) {
    const poly = f.polygon || [];
    if (poly.length < 2) continue;
    const n = poly.length -
      (poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1] ? 1 : 0);
    if (n === 0) continue;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += poly[i][0]; cz += poly[i][1]; }
    cx /= n; cz /= n;
    // World (real-metre, Unstretch-X) → Mercator → lat/lon → tile
    const { x: mx, y: my } = worldToMercator(cx, cz);
    const { lat, lon } = mercatorToLatLon(mx, my);
    const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
    const key = `${zoom}_${tx}_${ty}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(f);
  }
  return tiles;
}

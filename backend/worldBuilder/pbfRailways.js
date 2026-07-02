/**
 * Parse OSM PBF: extract railway ways inside bbox.
 * Reuses the same two-pass streaming approach as pbfHighways.js.
 *
 * Captures: rail, light_rail, subway, tram, narrow_gauge, monorail.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RAILWAY_TYPES = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'monorail']);
const NODE_MARGIN = 0.02;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  return fs.createReadStream(resolved).pipe(parseOSM());
}

function nodeInBbox(lat, lon, bbox, margin = 0) {
  return (
    lon >= bbox.minLon - margin && lon <= bbox.maxLon + margin &&
    lat >= bbox.minLat - margin && lat <= bbox.maxLat + margin
  );
}

async function collectNodesInBbox(pbfPath, bbox) {
  const through2 = (await import('through2')).default;
  const nodes = new Map();
  const stream = await createPbfStream(pbfPath);

  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type !== 'node' || item.lat == null || item.lon == null) continue;
            if (!nodeInBbox(item.lat, item.lon, bbox, NODE_MARGIN)) continue;
            nodes.set(item.id, { lat: item.lat, lon: item.lon });
          }
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

async function collectRailwayWays(pbfPath, nodes) {
  const through2 = (await import('through2')).default;
  const ways = [];
  const stream = await createPbfStream(pbfPath);

  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type !== 'way') continue;
            const railwayType = getTag(item.tags, 'railway');
            if (!RAILWAY_TYPES.has(railwayType)) continue;

            const refs = item.refs || item.nodes || [];
            if (!refs.length) continue;
            if (!refs.some((ref) => nodes.has(ref))) continue;

            ways.push({ id: item.id, tags: item.tags || {}, refs });
          }
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return ways;
}

/**
 * @param {string} pbfPath
 * @param {{ minLon, maxLon, minLat, maxLat }} bbox
 * @param {Map} [existingNodes] — reuse highway node map to avoid a second PBF pass
 * @returns {Promise<object[]>} railways with pointsMercator
 */
export async function parsePbfRailways(pbfPath, bbox, existingNodes) {
  console.log('  Parsing railways...');
  const nodes = existingNodes || await collectNodesInBbox(pbfPath, bbox);

  const ways = await collectRailwayWays(pbfPath, nodes);
  console.log('  Railway ways found:', ways.length);

  const railways = [];
  for (const w of ways) {
    const pts = [];
    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) continue;
      pts.push(n);
    }
    if (pts.length < 2) continue;

    const layerTag = getTag(w.tags, 'layer');
    const parsedLayer = parseInt(layerTag, 10);
    const layer = Number.isFinite(parsedLayer) ? parsedLayer : 0;

    const tunnelTag = getTag(w.tags, 'tunnel');
    const bridgeTag = getTag(w.tags, 'bridge');

    const pointsMercator = pts.map((p) => {
      const m = latLonToMercator(p.lat, p.lon);
      return { x: m.x, y: m.y };
    });

    railways.push({
      id: w.id,
      railwayType: getTag(w.tags, 'railway'),
      layer,
      bridge: !!(bridgeTag && bridgeTag !== 'no') || layer > 0,
      tunnel: !!(tunnelTag && tunnelTag !== 'no') || layer < 0,
      pointsMercator,
    });
  }

  console.log('  Railways parsed:', railways.length);
  return railways;
}

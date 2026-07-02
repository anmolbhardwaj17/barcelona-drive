/**
 * Parse OSM PBF: extract green area ways (parks, grass, forest, etc.) inside bbox.
 * Two-pass streaming (same pattern as pbfBuildings).
 * Tags: landuse=grass|forest|meadow|recreation_ground|park,
 *       leisure=park|garden|playground, natural=grassland|wood|scrub
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_MARGIN = 0.02;

const LANDUSE_GREEN = new Set(['grass', 'forest', 'meadow', 'recreation_ground', 'park']);
const LEISURE_GREEN = new Set(['park', 'garden', 'playground']);
const NATURAL_GREEN = new Set(['grassland', 'wood', 'scrub']);

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase() : def;
}

function isGreenWay(tags) {
  const landuse = getTag(tags, 'landuse');
  if (LANDUSE_GREEN.has(landuse)) return true;
  const leisure = getTag(tags, 'leisure');
  if (LEISURE_GREEN.has(leisure)) return true;
  const natural = getTag(tags, 'natural');
  if (NATURAL_GREEN.has(natural)) return true;
  return false;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);
  return fs.createReadStream(resolved).pipe(parseOSM());
}

function nodeInBbox(lat, lon, bbox, margin = 0) {
  return (
    lon >= bbox.minLon - margin &&
    lon <= bbox.maxLon + margin &&
    lat >= bbox.minLat - margin &&
    lat <= bbox.maxLat + margin
  );
}

async function collectNodesInBbox(pbfPath, bbox, onProgress) {
  const through2 = (await import('through2')).default;
  const nodes = new Map();
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type !== 'node' || item.lat == null || item.lon == null) continue;
            const { lat, lon } = item;
            if (!nodeInBbox(lat, lon, bbox, NODE_MARGIN)) continue;
            nodes.set(item.id, { lat, lon });
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'green-nodes');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

async function collectGreenWaysInRegion(pbfPath, nodes, onProgress) {
  const through2 = (await import('through2')).default;
  const ways = [];
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type !== 'way') continue;
            if (!isGreenWay(item.tags || {})) continue;
            const refs = item.refs || item.nodes || [];
            if (!refs.length) continue;
            const touchesRegion = refs.some((ref) => nodes.has(ref));
            if (!touchesRegion) continue;
            ways.push({ id: item.id, tags: item.tags || {}, refs });
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'green-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return ways;
}

/**
 * Parse PBF and return green areas with closed polygon points in mercator.
 */
export async function parsePbfGreens(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (greens):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);
  console.log('  Pass 2: collecting green ways touching region...');
  const ways = await collectGreenWaysInRegion(pbfPath, nodes, onProgress);
  console.log('  Green ways touching region:', ways.length);

  const greens = [];
  for (const w of ways) {
    const pts = [];
    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) continue;
      pts.push({ lat: n.lat, lon: n.lon });
    }
    if (pts.length < 3) continue;
    const strictInBbox = pts.some(
      (p) =>
        p.lon >= bbox.minLon &&
        p.lon <= bbox.maxLon &&
        p.lat >= bbox.minLat &&
        p.lat <= bbox.maxLat
    );
    if (!strictInBbox) continue;

    const pointsMercator = pts.map((p) => {
      const m = latLonToMercator(p.lat, p.lon);
      return { x: m.x, y: m.y };
    });
    const first = pointsMercator[0];
    const last = pointsMercator[pointsMercator.length - 1];
    const closed =
      first.x === last.x && first.y === last.y
        ? pointsMercator
        : [...pointsMercator, { x: first.x, y: first.y }];

    greens.push({
      id: w.id,
      tags: w.tags || {},
      pointsMercator: closed,
    });
  }
  console.log('  Greens inside strict bbox:', greens.length);
  return greens;
}

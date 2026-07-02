/**
 * Parse OSM PBF: extract parking area ways (amenity=parking, landuse=parking) inside bbox.
 * Two-pass streaming (same pattern as pbfGreens).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_MARGIN = 0.01;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

function nodeInBbox(lat, lon, bbox, margin = 0) {
  return (
    lon >= bbox.minLon - margin &&
    lon <= bbox.maxLon + margin &&
    lat >= bbox.minLat - margin &&
    lat <= bbox.maxLat + margin
  );
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
    stream
      .pipe(through2.obj(function (items, enc, next) {
        for (const item of items) {
          if (item.type !== 'node' || item.lat == null || item.lon == null) continue;
          if (nodeInBbox(item.lat, item.lon, bbox, NODE_MARGIN)) {
            nodes.set(item.id, { lat: item.lat, lon: item.lon });
          }
        }
        chunks++;
        if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'parking-nodes');
        next();
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

/**
 * Parse PBF and return parking areas with closed polygon points in mercator.
 */
export async function parsePbfParking(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (parking):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);

  console.log('  Pass 2: collecting parking ways...');
  const through2 = (await import('through2')).default;
  const parkings = [];
  const stream2 = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream2
      .pipe(through2.obj(function (items, enc, next) {
        for (const item of items) {
          if (item.type !== 'way') continue;
          const tags = item.tags || {};
          const amenity = getTag(tags, 'amenity');
          const landuse = getTag(tags, 'landuse');
          if (amenity !== 'parking' && landuse !== 'parking') continue;
          const refs = item.refs || item.nodes || [];
          if (refs.length < 3) continue;
          const touchesRegion = refs.some((ref) => nodes.has(ref));
          if (!touchesRegion) continue;

          const pointsMercator = [];
          let hasAllNodes = true;
          for (const ref of refs) {
            const n = nodes.get(ref);
            if (!n) { hasAllNodes = false; break; }
            const m = latLonToMercator(n.lat, n.lon);
            pointsMercator.push({ x: m.x, y: m.y });
          }
          if (!hasAllNodes || pointsMercator.length < 3) continue;

          // Ensure closed ring
          const first = pointsMercator[0];
          const last = pointsMercator[pointsMercator.length - 1];
          const closed = (first.x === last.x && first.y === last.y)
            ? pointsMercator
            : [...pointsMercator, { x: first.x, y: first.y }];

          parkings.push({
            id: item.id,
            pointsMercator: closed,
            parkingType: getTag(tags, 'parking') || getTag(tags, 'access') || 'surface',
            capacity: parseInt(getTag(tags, 'capacity'), 10) || null,
          });
        }
        chunks++;
        if (onProgress && chunks % 50 === 0) onProgress(parkings.length, chunks, 'parking-ways');
        next();
      }))
      .on('finish', resolve)
      .on('error', reject);
  });

  console.log('  Parking areas found:', parkings.length);
  return parkings;
}

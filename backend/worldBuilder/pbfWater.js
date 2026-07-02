/**
 * Parse OSM PBF: extract water features inside bbox.
 * correctness-first: preserve wayId, nodeIds, tags. No clipping, no simplification.
 *
 * Closed ways: natural=water, natural=wetland
 * Linear ways: waterway=river, waterway=stream, waterway=canal
 * Coastline: natural=coastline
 *
 * Does NOT parse multipolygon relations yet.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_MARGIN = 0.02;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase() : def;
}

function isWaterWay(tags) {
  const natural = getTag(tags, 'natural');
  if (natural === 'water' || natural === 'wetland' || natural === 'coastline') return true;
  const waterway = getTag(tags, 'waterway');
  if (waterway === 'river' || waterway === 'stream' || waterway === 'canal') return true;
  // Marina basins and docks — Port Olímpic and similar harbour water bodies
  if (waterway === 'dock' || waterway === 'basin') return true;
  const leisure = getTag(tags, 'leisure');
  if (leisure === 'marina') return true;
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

function segmentIntersectsBbox(p0, p1, bbox) {
  const { minLon, minLat, maxLon, maxLat } = bbox;
  const x0 = p0.lon, y0 = p0.lat, x1 = p1.lon, y1 = p1.lat;
  if (x0 >= minLon && x0 <= maxLon && y0 >= minLat && y0 <= maxLat) return true;
  if (x1 >= minLon && x1 <= maxLon && y1 >= minLat && y1 <= maxLat) return true;
  const dx = x1 - x0, dy = y1 - y0;
  const t = { min: 0, max: 1 };
  if (dx !== 0) {
    const t0 = (minLon - x0) / dx, t1 = (maxLon - x0) / dx;
    t.min = Math.max(t.min, Math.min(t0, t1));
    t.max = Math.min(t.max, Math.max(t0, t1));
  } else if (x0 < minLon || x0 > maxLon) return false;
  if (dy !== 0) {
    const t0 = (minLat - y0) / dy, t1 = (maxLat - y0) / dy;
    t.min = Math.max(t.min, Math.min(t0, t1));
    t.max = Math.min(t.max, Math.max(t0, t1));
  } else if (y0 < minLat || y0 > maxLat) return false;
  return t.min <= t.max && t.min < 1 && t.max > 0;
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
          if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'water-nodes');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

async function collectWaterWaysInRegion(pbfPath, nodes, bbox, onProgress) {
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
            if (!isWaterWay(item.tags || {})) continue;
            const refs = item.refs || item.nodes || [];
            if (!refs.length) continue;

            const pts = [];
            for (const ref of refs) {
              const n = nodes.get(ref);
              if (!n) continue;
              pts.push({ lat: n.lat, lon: n.lon });
            }
            if (pts.length < 2) continue;

            const segmentIntersects = pts.some((_, i) => {
              if (i === 0) return false;
              return segmentIntersectsBbox(pts[i - 1], pts[i], bbox);
            });
            const anyInside = pts.some(
              (p) =>
                p.lon >= bbox.minLon &&
                p.lon <= bbox.maxLon &&
                p.lat >= bbox.minLat &&
                p.lat <= bbox.maxLat
            );
            if (!segmentIntersects && !anyInside) continue;

            const nodeIds = refs.filter((ref) => nodes.has(ref));
            ways.push({
              id: item.id,
              tags: item.tags || {},
              refs,
              nodeIds,
              pts,
            });
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'water-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return ways;
}

/**
 * Parse PBF and return water features.
 * @returns {{ waters: Array<{ id, type, nodeIds, tags, pointsMercator, closed, waterwayType? }>, nodeMap: Map }}
 */
export async function parsePbfWater(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (water):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);
  console.log('  Pass 2: collecting water ways intersecting region...');
  const ways = await collectWaterWaysInRegion(pbfPath, nodes, bbox, onProgress);
  console.log('  Water ways intersecting region:', ways.length);

  const waters = [];
  const nodeMap = new Map(nodes.entries());

  for (const w of ways) {
    const natural = getTag(w.tags, 'natural');
    const waterway = getTag(w.tags, 'waterway');
    const closed =
      w.pts.length >= 3 &&
      Math.abs(w.pts[0].lat - w.pts[w.pts.length - 1].lat) < 1e-9 &&
      Math.abs(w.pts[0].lon - w.pts[w.pts.length - 1].lon) < 1e-9;

    let type = 'water';
    if (natural === 'coastline') type = 'coastline';
    else if (natural === 'wetland') type = 'wetland';
    else if (waterway === 'river') type = 'river';
    else if (waterway === 'stream') type = 'stream';
    else if (waterway === 'canal') type = 'canal';
    else if (waterway === 'dock' || waterway === 'basin') type = 'dock';
    else if (getTag(w.tags, 'leisure') === 'marina') type = 'marina';

    const pointsMercator = w.pts.map((p) => {
      const m = latLonToMercator(p.lat, p.lon);
      return { x: m.x, y: m.y };
    });

    waters.push({
      id: w.id,
      type,
      nodeIds: w.nodeIds,
      tags: w.tags,
      pointsMercator,
      closed: !!closed,
      waterwayType: waterway || null,
    });
  }

  const byType = {};
  for (const w of waters) {
    byType[w.type] = (byType[w.type] || 0) + 1;
  }
  console.log('  Water type distribution:', JSON.stringify(byType));
  return { waters, nodeMap };
}

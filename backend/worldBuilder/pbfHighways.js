/**
 * Parse OSM PBF: extract highway ways inside bbox only.
 * Two-pass streaming:
 *  Pass 1: collect nodes inside bbox (+ margin)
 *  Pass 2: collect only ways that reference at least one of those nodes
 *
 * Safe for full-country PBF with region-level bbox.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEEP_TAGS = ['highway', 'bridge', 'tunnel', 'layer', 'lanes', 'surface', 'incline', 'name', 'service', 'junction',
                   // R-W1: `width` was NOT on this list, so `getWidth()`'s first branch — which read
                   // `tags.width` and was documented as the primary width source — had never once
                   // fired. 4.41% of drivable ways carry it, and on a pre-Cerda Gracia street it is
                   // the only thing that knows the street is 5.5 m and not the derived 10.4 m.
                   'width', 'lanes:forward', 'lanes:backward',
                   'oneway', 'sidewalk', 'cycleway', 'maxspeed',
                   'footway', 'path', 'crossing',   // marked-crossing detection (bake-surface-clipping.md Phase 1)
                   'parking:lane:left', 'parking:lane:right', 'parking:lane:both',   // Phase 4A: no-parking stripes
                   // Phase 4C-B: Barcelona's primary parking restriction schema
                   'parking:left:restriction', 'parking:right:restriction', 'parking:both:restriction',
                   'parking:condition:left', 'parking:condition:right', 'parking:condition:both',
                   'parking:left:fee', 'parking:right:fee', 'parking:both:fee',
                   'parking:left', 'parking:right', 'parking:both'];

// Increased margin to avoid cutting boundary roads too aggressively
const NODE_MARGIN = 0.02;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);

  return fs.createReadStream(resolved).pipe(parseOSM());
}

/**
 * Check if node is inside bbox (lon/lat order correct).
 */
function nodeInBbox(lat, lon, bbox, margin = 0) {
  return (
    lon >= bbox.minLon - margin &&
    lon <= bbox.maxLon + margin &&
    lat >= bbox.minLat - margin &&
    lat <= bbox.maxLat + margin
  );
}

/**
 * Check if segment (p0-p1) intersects axis-aligned bbox.
 * Keeps ways that cross the bbox even when no vertex is inside.
 */
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

/**
 * PASS 1
 * Collect only nodes inside bbox + margin.
 */
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
          if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'nodes');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });

  return nodes;
}

/**
 * PASS 2
 * Collect only ways with highway=* that reference at least one node in region.
 */
async function collectWaysInRegion(pbfPath, nodes, onProgress) {
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

            const highway = getTag(item.tags, 'highway');
            if (!highway) {
              if (item.id === 29534879) console.log('  [TRACE 29534879] not in ways: no highway tag');
              continue;
            }

            const refs = item.refs || item.nodes || [];
            if (!refs.length) continue;

            const touchesRegion = refs.some((ref) => nodes.has(ref));
            if (!touchesRegion) {
              if (item.id === 29534879) console.log('  [TRACE 29534879] not in ways: no node in region');
              continue;
            }

            ways.push({
              id: item.id,
              tags: item.tags || {},
              refs,
            });
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });

  return ways;
}

/**
 * Main parser entry
 */
export async function parsePbfHighways(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);

  console.log('  PBF:', resolved);

  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);

  console.log('  Pass 2: collecting highway ways touching region...');
  const ways = await collectWaysInRegion(pbfPath, nodes, onProgress);
  console.log('  Ways touching region:', ways.length);

  const roads = [];
  const skipped = [];
  const debugSkip = process.env.DEBUG_SKIP_WAYS === 'true';

  for (const w of ways) {
    const pts = [];
    const nodeIds = [];

    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) continue;
      nodeIds.push(ref);
      pts.push({ lat: n.lat, lon: n.lon });
    }

    if (pts.length < 2) {
      if (debugSkip) skipped.push({ id: w.id, highway: getTag(w.tags, 'highway'), reason: 'pts.length < 2' });
      if (w.id === 29534879) console.log('  [TRACE 29534879] skipped: pts.length < 2');
      continue;
    }

    const closedLoop = w.refs?.length >= 3 && w.refs[0] === w.refs[w.refs.length - 1];

    // Keep way if ANY segment intersects the bbox (not just vertex-inside).
    const intersectsBbox = pts.some((p, i) => {
      if (i === pts.length - 1) return false;
      return segmentIntersectsBbox(p, pts[i + 1], bbox);
    });
    if (!intersectsBbox) {
      if (debugSkip) skipped.push({ id: w.id, highway: getTag(w.tags, 'highway'), reason: 'no segment intersects bbox' });
      if (w.id === 29534879) console.log('  [TRACE 29534879] skipped: no segment intersects bbox');
      continue;
    }

    const layerTag = getTag(w.tags, 'layer');
    const parsedLayer = parseInt(layerTag, 10);
    const layer = Number.isFinite(parsedLayer) ? parsedLayer : 0;

    const highwayType = getTag(w.tags, 'highway');

    const tunnelTag = getTag(w.tags, 'tunnel');
    const bridgeTag = getTag(w.tags, 'bridge');

    const tunnel = (tunnelTag && tunnelTag !== 'no') || layer < 0;
    const bridge = (bridgeTag && bridgeTag !== 'no') || layer > 0;

    const pointsMercator = pts.map((p) => {
      const m = latLonToMercator(p.lat, p.lon);
      return {
        x: m.x,           // east-west
        y: m.y,           // north-south
        lat: p.lat,
        lon: p.lon,
      };
    });

    const keptTags = {};
    for (const k of KEEP_TAGS) {
      const v = w.tags[k];
      if (v != null) keptTags[k] = v;
    }

    if (w.id === 29534879) console.log('  [TRACE 29534879] parsed, added to roads');
    roads.push({
      id: w.id,
      nodeIds,
      name: getTag(w.tags, 'name'),
      highwayType,
      serviceSubtype: highwayType === 'service' ? (getTag(w.tags, 'service') || null) : null,
      tags: keptTags,
      tunnel: !!tunnel,
      bridge: !!bridge,
      layer,
      closedLoop: !!closedLoop,
      points: pointsMercator,
    });
  }

  const nodeMap = new Map(nodes.entries());
  console.log('  Roads (segment-intersects-bbox):', roads.length);
  const byType = {};
  for (const r of roads) {
    const t = (r.highwayType || 'unknown').toLowerCase();
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log('  Highway type distribution:', JSON.stringify(byType, null, 0));
  if (debugSkip && skipped.length > 0) {
    console.log('  Skipped ways (DEBUG_SKIP_WAYS):', skipped.length);
    skipped.slice(0, 10).forEach((s) => console.log('    way', s.id, 'highway=', s.highway, 'reason:', s.reason));
    if (skipped.length > 10) console.log('    ... and', skipped.length - 10, 'more');
  }
  return { roads, nodeMap };
}
/**
 * Parse OSM PBF: extract building ways AND multipolygon relations inside bbox.
 * Three-pass streaming:
 *  Pass 1: collect nodes inside bbox (+ margin)
 *  Pass 2: collect ways with building=*, store refs for all ways touching region,
 *           collect relations with building=* and note member way IDs
 *  Pass 3: collect any relation member ways not already captured
 * Output: closed polygon with pointsMercator (mercator x, y) and optional innerRingsMercator.
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
  return v != null ? String(v).trim() : def;
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
          if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'building-nodes');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

/**
 * Pass 2: collect building ways + building relations + store refs for member ways.
 * Returns { ways, relations, wayRefsMap }.
 */
async function collectBuildingWaysAndRelations(pbfPath, nodes, onProgress) {
  const through2 = (await import('through2')).default;
  const ways = [];
  const relations = [];
  const wayRefsMap = new Map();

  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type === 'way') {
              const refs = item.refs || item.nodes || [];
              if (!refs.length) continue;
              const touchesRegion = refs.some((ref) => nodes.has(ref));
              if (!touchesRegion) continue;

              wayRefsMap.set(item.id, { refs, tags: item.tags || {} });

              const building = getTag(item.tags, 'building');
              if (building) {
                ways.push({ id: item.id, tags: item.tags || {}, refs });
              }
            } else if (item.type === 'relation') {
              const building = getTag(item.tags, 'building');
              const relType = getTag(item.tags, 'type');
              if (!building || relType !== 'multipolygon') continue;

              const members = (item.members || [])
                .filter((m) => m.type === 'way')
                .map((m) => ({ id: m.id, role: m.role || 'outer' }));
              if (members.length === 0) continue;

              relations.push({
                id: item.id,
                tags: item.tags || {},
                members,
              });
            }
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'building-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return { ways, relations, wayRefsMap };
}

/**
 * Pass 3: collect refs for any relation member ways not already in wayRefsMap.
 */
async function collectMissingMemberWays(pbfPath, missingWayIds, nodes, onProgress) {
  if (missingWayIds.size === 0) return new Map();
  const through2 = (await import('through2')).default;
  const found = new Map();
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream
      .pipe(
        through2.obj(function (items, enc, next) {
          for (const item of items) {
            if (item.type !== 'way') continue;
            if (!missingWayIds.has(item.id)) continue;
            const refs = item.refs || item.nodes || [];
            found.set(item.id, { refs, tags: item.tags || {} });
            missingWayIds.delete(item.id);
            if (missingWayIds.size === 0) break;
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(found.size, chunks, 'building-missing-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return found;
}

/**
 * Join open ways into closed rings by matching start/end node IDs.
 */
function joinWaysIntoRings(waySegments) {
  const rings = [];
  const remaining = waySegments.map((s) => [...s]);

  while (remaining.length > 0) {
    const ring = remaining.shift();
    if (ring.length === 0) continue;

    let changed = true;
    while (changed) {
      changed = false;
      const head = ring[0];
      const tail = ring[ring.length - 1];
      if (head === tail && ring.length >= 4) break;

      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (seg.length === 0) continue;

        if (tail === seg[0]) {
          ring.push(...seg.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (tail === seg[seg.length - 1]) {
          ring.push(...seg.slice(0, -1).reverse());
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (head === seg[seg.length - 1]) {
          ring.unshift(...seg.slice(0, -1));
          remaining.splice(i, 1);
          changed = true;
          break;
        } else if (head === seg[0]) {
          ring.unshift(...seg.slice(1).reverse());
          remaining.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Build closed rings (outer/inner) from relation members using wayRefsMap.
 */
export function assembleRings(members, wayRefsMap, role) {
  const segments = [];
  for (const m of members) {
    if (m.role !== role) continue;
    const w = wayRefsMap.get(m.id);
    if (!w || !w.refs || w.refs.length < 2) continue;
    segments.push(w.refs);
  }
  if (segments.length === 0) return [];
  return joinWaysIntoRings(segments);
}

export function refsToMercator(refs, nodes) {
  const pts = [];
  for (const ref of refs) {
    const n = nodes.get(ref);
    if (!n) continue;
    pts.push({ lat: n.lat, lon: n.lon });
  }
  if (pts.length < 3) return null;
  const mercator = pts.map((p) => {
    const m = latLonToMercator(p.lat, p.lon);
    return { x: m.x, y: m.y };
  });
  const first = mercator[0];
  const last = mercator[mercator.length - 1];
  if (first.x !== last.x || first.y !== last.y) {
    mercator.push({ x: first.x, y: first.y });
  }
  return mercator;
}

/**
 * Parse PBF and return buildings with closed polygon points in mercator.
 * Handles both simple ways and multipolygon relations.
 * @param {string} pbfPath
 * @param {{ minLon, minLat, maxLon, maxLat }} bbox
 * @returns {Promise<{ id: number, tags: object, pointsMercator: { x, y }[], innerRingsMercator?: { x, y }[][] }[]>}
 */
export async function parsePbfBuildings(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (buildings):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);

  console.log('  Pass 2: collecting building ways + relations...');
  const { ways, relations, wayRefsMap } = await collectBuildingWaysAndRelations(pbfPath, nodes, onProgress);
  console.log('  Building ways:', ways.length, ' Relations:', relations.length);

  const missingIds = new Set();
  for (const rel of relations) {
    for (const m of rel.members) {
      if (!wayRefsMap.has(m.id)) missingIds.add(m.id);
    }
  }
  if (missingIds.size > 0) {
    console.log('  Pass 3: fetching', missingIds.size, 'missing member ways...');
    const extra = await collectMissingMemberWays(pbfPath, new Set(missingIds), nodes, onProgress);
    for (const [id, data] of extra) {
      wayRefsMap.set(id, data);
    }
    console.log('  Found', extra.size, 'additional member ways');
  }

  const relationOuterWayIds = new Set();
  for (const rel of relations) {
    for (const m of rel.members) {
      if (m.role === 'outer') relationOuterWayIds.add(m.id);
    }
  }

  const buildings = [];

  for (const w of ways) {
    if (relationOuterWayIds.has(w.id)) continue;

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

    buildings.push({
      id: w.id,
      tags: w.tags || {},
      pointsMercator: closed,
    });
  }

  for (const rel of relations) {
    const outerRings = assembleRings(rel.members, wayRefsMap, 'outer');
    const innerRings = assembleRings(rel.members, wayRefsMap, 'inner');

    for (const outerRefs of outerRings) {
      const outerMerc = refsToMercator(outerRefs, nodes);
      if (!outerMerc || outerMerc.length < 4) continue;

      const strictInBbox = outerMerc.some((p) => {
        const ll = latLonToMercator; // already mercator, need to check lat/lon
        // Convert back is expensive; check mercator bbox instead
        return true;
      });
      // Use node lat/lon for bbox check
      const outerLatLon = outerRefs.map((r) => nodes.get(r)).filter(Boolean);
      const inBbox = outerLatLon.some(
        (p) =>
          p.lon >= bbox.minLon &&
          p.lon <= bbox.maxLon &&
          p.lat >= bbox.minLat &&
          p.lat <= bbox.maxLat
      );
      if (!inBbox) continue;

      const innerMercRings = [];
      for (const innerRefs of innerRings) {
        const innerMerc = refsToMercator(innerRefs, nodes);
        if (innerMerc && innerMerc.length >= 4) {
          innerMercRings.push(innerMerc);
        }
      }

      const entry = {
        id: rel.id,
        tags: rel.tags || {},
        pointsMercator: outerMerc,
      };
      if (innerMercRings.length > 0) {
        entry.innerRingsMercator = innerMercRings;
      }
      buildings.push(entry);
    }
  }

  console.log('  Buildings (ways + relations):', buildings.length);
  return buildings;
}

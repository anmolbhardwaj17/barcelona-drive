/**
 * Parse OSM PBF: extract green areas — ways AND multipolygon relations — inside bbox.
 * Three-pass streaming (same pattern as pbfBuildings).
 * Tags: landuse=grass|forest|meadow|recreation_ground|park,
 *       leisure=park|garden|playground, natural=grassland|wood|scrub
 *
 * WHY RELATIONS MATTER HERE. This parser read WAYS ONLY, and the consequence was measurable: the
 * whole baked Barcelona region contained TEN `forest` polygons and twelve `scrub`, against 409
 * grass and 380 garden. Barcelona is wrapped in the Serra de Collserola and sits beside Montjuïc,
 * and large woodland is almost always mapped as a `type=multipolygon` relation whose member ways
 * carry no tags of their own — so every one of them was invisible. `ZONE_RULES.forest` in the
 * vegetation worker has had a dense rule (treeDensity 1/25, cap 600) waiting on data that never
 * arrived.
 *
 * The ring-assembly machinery is imported from pbfBuildings rather than copied: joining split ways
 * into closed rings is fiddly, and two divergent versions of it is how one of them quietly rots.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';
import { assembleRings, refsToMercator } from './pbfBuildings.js';

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

/**
 * Pass 2: green ways + green multipolygon relations, plus the refs of every way in the region.
 *
 * wayRefsMap holds ALL region ways, not just green ones: a relation's member ways are usually
 * untagged (the tags live on the relation), so filtering to green-tagged ways here would throw
 * away exactly the geometry the relations need.
 */
async function collectGreenWaysAndRelations(pbfPath, nodes, onProgress) {
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
              if (isGreenWay(item.tags || {})) {
                ways.push({ id: item.id, tags: item.tags || {}, refs });
              }
            } else if (item.type === 'relation') {
              if (!isGreenWay(item.tags || {})) continue;
              const relType = getTag(item.tags, 'type');
              // `boundary` covers leisure=nature_reserve / protected areas, which is how large
              // Mediterranean parkland is often mapped.
              if (relType !== 'multipolygon' && relType !== 'boundary') continue;
              const members = (item.members || [])
                .filter((m) => m.type === 'way')
                .map((m) => ({ id: m.id, role: m.role || 'outer' }));
              if (members.length === 0) continue;
              relations.push({ id: item.id, tags: item.tags || {}, members });
            }
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'green-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return { ways, relations, wayRefsMap };
}

/** Pass 3: refs for relation member ways that pass 2 did not already capture. */
async function collectMissingMemberWays(pbfPath, missingWayIds, onProgress) {
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
            found.set(item.id, { refs: item.refs || item.nodes || [], tags: item.tags || {} });
            missingWayIds.delete(item.id);
            if (missingWayIds.size === 0) break;
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(found.size, chunks, 'green-missing-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return found;
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
  console.log('  Pass 2: collecting green ways + relations touching region...');
  const { ways, relations, wayRefsMap } = await collectGreenWaysAndRelations(pbfPath, nodes, onProgress);
  console.log('  Green ways touching region:', ways.length, ' Relations:', relations.length);

  // Pass 3: a relation can reference member ways that pass 2 skipped, because a way only entered
  // wayRefsMap if one of ITS OWN nodes was in the bbox. A large forest boundary crossing the region
  // has member ways lying entirely outside it, and dropping those leaves the ring unclosed.
  const missing = new Set();
  for (const rel of relations) {
    for (const m of rel.members) if (!wayRefsMap.has(m.id)) missing.add(m.id);
  }
  if (missing.size > 0) {
    console.log('  Pass 3: fetching', missing.size, 'missing relation member ways...');
    const found = await collectMissingMemberWays(pbfPath, missing, onProgress);
    for (const [id, w] of found) wayRefsMap.set(id, w);
  }

  const greens = [];

  // ── relation multipolygons ────────────────────────────────────────────────────────────────
  // Each OUTER ring becomes its own green area. Inner rings (holes) are deliberately NOT modelled:
  // the green record carries a single polygon, and a hole in a forest reads as slightly too much
  // woodland — far less wrong than the whole forest being absent, which is the status quo.
  let relRings = 0;
  for (const rel of relations) {
    const outers = assembleRings(rel.members, wayRefsMap, 'outer');
    for (const ring of outers) {
      const merc = refsToMercator(ring, nodes);
      if (!merc || merc.length < 4) continue;
      const inBbox = merc.length > 0 && ring.some((ref) => {
        const n = nodes.get(ref);
        return n && n.lon >= bbox.minLon && n.lon <= bbox.maxLon &&
               n.lat >= bbox.minLat && n.lat <= bbox.maxLat;
      });
      if (!inBbox) continue;
      greens.push({ id: rel.id, tags: rel.tags || {}, pointsMercator: merc });
      relRings++;
    }
  }
  if (relations.length) console.log('  Rings from relations:', relRings);

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

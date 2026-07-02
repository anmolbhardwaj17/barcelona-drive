/**
 * Parse OSM PBF: extract barrier ways (walls, fences, hedges, guard_rails) and
 * campus compound walls (hospital, university, school, park perimeters).
 * Two-pass streaming (same pattern as pbfGreens.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_MARGIN = 0.02;

const LINEAR_BARRIER_TYPES = new Set([
  'wall', 'fence', 'hedge', 'guard_rail', 'retaining_wall',
  'city_wall', 'jersey_barrier', 'kerb',
]);
const GATE_TAGS = new Set([
  'gate', 'lift_gate', 'swing_gate', 'sliding_gate', 'turnstile',
]);
const CAMPUS_AMENITY = new Set(['hospital', 'university', 'school', 'college', 'clinic', 'government']);
const CAMPUS_LANDUSE = new Set(['industrial', 'school', 'education', 'institutional', 'railway', 'military']);
const CAMPUS_LEISURE = new Set(['sports_centre', 'stadium']);
const OPEN_LANDUSE = new Set([
  'grass', 'meadow', 'forest', 'farmland', 'recreation_ground',
  'greenfield', 'allotments', 'scrub', 'heath', 'wetland', 'cemetery', 'brownfield',
]);
const OPEN_NATURAL = new Set(['wood']);
const OPEN_LEISURE = new Set(['park', 'garden']);

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase() : def;
}

function isLinearBarrier(tags) {
  return LINEAR_BARRIER_TYPES.has(getTag(tags, 'barrier'));
}

function isCampusArea(tags, refs) {
  if (!refs || refs.length < 4) return false;
  // Must be a closed way (first node == last node)
  if (refs[0] !== refs[refs.length - 1]) return false;
  const amenity = getTag(tags, 'amenity');
  if (CAMPUS_AMENITY.has(amenity)) return true;
  const landuse = getTag(tags, 'landuse');
  if (OPEN_LANDUSE.has(landuse)) return false;
  const natural = getTag(tags, 'natural');
  if (OPEN_NATURAL.has(natural)) return false;
  if (OPEN_LEISURE.has(getTag(tags, 'leisure'))) return false;
  if (CAMPUS_LANDUSE.has(landuse)) return true;
  const leisure = getTag(tags, 'leisure');
  if (CAMPUS_LEISURE.has(leisure)) return true;
  return false;
}

const HIGH_CONFIDENCE_AMENITY = new Set([
  'hospital', 'university', 'school', 'college', 'clinic', 'government',
]);
const HIGH_CONFIDENCE_LANDUSE = new Set([
  'industrial', 'education', 'military', 'institutional', 'railway',
]);

function getCompoundWallClass(tags) {
  if (HIGH_CONFIDENCE_AMENITY.has(getTag(tags, 'amenity'))) return 'high_confidence';
  if (HIGH_CONFIDENCE_LANDUSE.has(getTag(tags, 'landuse')))  return 'high_confidence';
  return 'conditional';
}

function isGateNode(tags) {
  return GATE_TAGS.has(getTag(tags, 'barrier'));
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
            nodes.set(item.id, { lat, lon, tags: item.tags || {} });
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(nodes.size, chunks, 'barrier-nodes');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return nodes;
}

async function collectBarrierWaysInRegion(pbfPath, nodes, onProgress) {
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
            const tags = item.tags || {};
            const refs = item.refs || item.nodes || [];
            if (!refs.length) continue;
            const touchesRegion = refs.some((ref) => nodes.has(ref));
            if (!touchesRegion) continue;
            if (isLinearBarrier(tags) || isCampusArea(tags, refs)) {
              ways.push({ id: item.id, tags, refs });
            }
          }
          chunks++;
          if (onProgress && chunks % 50 === 0) onProgress(ways.length, chunks, 'barrier-ways');
          next();
        })
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  return ways;
}

/**
 * Parse PBF and return barrier features with Mercator coordinates.
 * @param {string} pbfPath
 * @param {{ minLon, maxLon, minLat, maxLat }} bbox
 * @returns {{ barriers: object[], gateNodes: Map<number, {x, y}> }}
 */
export async function parsePbfBarriers(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath)
    ? pbfPath
    : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (barriers):', resolved);
  console.log('  Pass 1: collecting nodes in bbox (+margin)...');
  const nodes = await collectNodesInBbox(pbfPath, bbox, onProgress);
  console.log('  Nodes in region:', nodes.size);
  console.log('  Pass 2: collecting barrier ways touching region...');
  const ways = await collectBarrierWaysInRegion(pbfPath, nodes, onProgress);
  console.log('  Barrier ways touching region:', ways.length);

  // Collect gate node IDs from all barrier ways
  const gateNodes = new Map();
  for (const [nodeId, nodeData] of nodes.entries()) {
    if (isGateNode(nodeData.tags)) {
      const m = latLonToMercator(nodeData.lat, nodeData.lon);
      gateNodes.set(nodeId, { x: m.x, y: m.y });
    }
  }

  const barriers = [];
  for (const w of ways) {
    const pts = [];
    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) continue;
      pts.push({ lat: n.lat, lon: n.lon });
    }
    if (pts.length < 2) continue;

    // Strict bbox check: at least one point must be inside the region
    const strictInBbox = pts.some(
      (p) =>
        p.lon >= bbox.minLon &&
        p.lon <= bbox.maxLon &&
        p.lat >= bbox.minLat &&
        p.lat <= bbox.maxLat
    );
    if (!strictInBbox) continue;

    const tags = w.tags || {};
    const isArea = isCampusArea(tags, w.refs);
    const barrierTag = getTag(tags, 'barrier');
    const barrierType = isArea ? 'compound_wall' : (barrierTag || 'wall');

    // Parse height tag
    const heightStr = tags['height'];
    let heightOsm = null;
    if (heightStr != null) {
      const m = String(heightStr).match(/^[\d.]+/);
      if (m) heightOsm = parseFloat(m[0]);
    }

    const pointsMercator = pts.map((p) => {
      const m = latLonToMercator(p.lat, p.lon);
      return { x: m.x, y: m.y };
    });

    // Close polygon for area features
    let finalPoints = pointsMercator;
    if (isArea) {
      const first = pointsMercator[0];
      const last = pointsMercator[pointsMercator.length - 1];
      if (first.x !== last.x || first.y !== last.y) {
        finalPoints = [...pointsMercator, { x: first.x, y: first.y }];
      }
    }

    // Collect gate node IDs that appear on this way
    const gateNodeIds = w.refs.filter((id) => gateNodes.has(id));

    const campusClass = isArea ? getCompoundWallClass(tags) : null;
    const isLeisure   = isArea && CAMPUS_LEISURE.has(getTag(tags, 'leisure'));

    barriers.push({
      id: w.id,
      barrierType,
      isArea,
      campusClass,
      isLeisure,
      heightOsm,
      pointsMercator: finalPoints,
      gateNodeIds,
    });
  }
  console.log('  Barriers inside strict bbox:', barriers.length);
  console.log('  Gate nodes:', gateNodes.size);
  return { barriers, gateNodes };
}

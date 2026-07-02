import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTag(tags, key) {
  const v = tags?.[key];
  return v != null ? String(v).trim().toLowerCase() : '';
}

function nodeInBbox(lat, lon, bbox) {
  return lon >= bbox.minLon && lon <= bbox.maxLon &&
         lat >= bbox.minLat && lat <= bbox.maxLat;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  return fs.createReadStream(resolved).pipe(parseOSM());
}

function classifyUrbanFeature(tags) {
  const amenity = getTag(tags, 'amenity');
  const manMade = getTag(tags, 'man_made');
  const emergency = getTag(tags, 'emergency');
  const towerType = getTag(tags, 'tower:type');

  if (amenity === 'fountain' || manMade === 'fountain') return 'fountain';
  if (amenity === 'fuel') return 'fuel_station';
  if (amenity === 'toilets') return 'public_toilet';
  if (manMade === 'communications_tower') return 'communication_tower';
  if (manMade === 'tower' && towerType === 'communication') return 'communication_tower';
  if (manMade === 'mast' && towerType === 'communication') return 'communication_tower';
  if (manMade === 'mast' && !towerType) return 'communication_tower'; // bare masts are typically cell towers
  if (manMade === 'water_tower') return 'water_tower';
  if (emergency === 'fire_hydrant') return 'fire_hydrant';
  return null;
}

function extractTags(tags) {
  const out = {};
  const name = getTag(tags, 'name');
  const operator = getTag(tags, 'operator');
  const brand = getTag(tags, 'brand');
  if (name) out.name = name;
  if (operator) out.operator = operator;
  if (brand) out.brand = brand;
  return out;
}

export async function parsePbfUrbanFeatures(pbfPath, bbox, onProgress) {
  const through2 = (await import('through2')).default;
  const features = [];
  const wayData = [];      // { id, type, nodeRefs, tags }
  const neededNodes = new Set();

  // Pass 1: collect matching nodes directly + collect way node refs
  const stream1 = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream1.pipe(through2.obj(function (items, enc, next) {
      for (const item of items) {
        if (item.type === 'node' && item.lat != null && item.lon != null) {
          const type = classifyUrbanFeature(item.tags || {});
          if (!type) continue;
          if (!nodeInBbox(item.lat, item.lon, bbox)) continue;
          const m = latLonToMercator(item.lat, item.lon);
          features.push({
            id: item.id, type, lat: item.lat, lon: item.lon,
            mx: m.x, my: m.y, tags: extractTags(item.tags || {}),
          });
        } else if (item.type === 'way') {
          const type = classifyUrbanFeature(item.tags || {});
          if (!type) continue;
          const refs = item.refs || [];
          if (refs.length === 0) continue;
          wayData.push({ id: item.id, type, nodeRefs: refs, tags: item.tags || {} });
          for (const ref of refs) neededNodes.add(ref);
        }
      }
      chunks++;
      if (onProgress && chunks % 50 === 0) onProgress(features.length, chunks, 'urban-features');
      next();
    })).on('finish', resolve).on('error', reject);
  });

  // Pass 2: resolve way node positions if any ways were found
  if (wayData.length > 0) {
    const nodePositions = new Map();
    const stream2 = await createPbfStream(pbfPath);
    let chunks2 = 0;
    await new Promise((resolve, reject) => {
      stream2.pipe(through2.obj(function (items, enc, next) {
        for (const item of items) {
          if (item.type === 'node' && neededNodes.has(item.id) && item.lat != null && item.lon != null) {
            nodePositions.set(item.id, { lat: item.lat, lon: item.lon });
          }
        }
        chunks2++;
        if (onProgress && chunks2 % 50 === 0) onProgress(nodePositions.size, chunks2, 'urban-way-nodes');
        next();
      })).on('finish', resolve).on('error', reject);
    });

    for (const way of wayData) {
      let latSum = 0, lonSum = 0, count = 0;
      for (const ref of way.nodeRefs) {
        const pos = nodePositions.get(ref);
        if (pos) { latSum += pos.lat; lonSum += pos.lon; count++; }
      }
      if (count === 0) continue;
      const lat = latSum / count;
      const lon = lonSum / count;
      if (!nodeInBbox(lat, lon, bbox)) continue;
      const m = latLonToMercator(lat, lon);
      features.push({
        id: way.id, type: way.type, lat, lon,
        mx: m.x, my: m.y, tags: extractTags(way.tags),
      });
    }
  }

  return features;
}

const DEFAULT_MIN_SPACING = {
  fire_hydrant: 20,
  fountain: 30,
  public_toilet: 30,
  fuel_station: 50,
  communication_tower: 100,
  water_tower: 100,
};

export function deduplicateUrbanFeatures(features, minSpacingByType) {
  const spacing = { ...DEFAULT_MIN_SPACING, ...minSpacingByType };
  const byType = new Map();
  for (const f of features) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }

  const result = [];
  for (const [type, group] of byType) {
    group.sort((a, b) => a.id - b.id);
    const minDist = spacing[type] ?? 30;
    const kept = [];
    for (const f of group) {
      let tooClose = false;
      for (const k of kept) {
        if (Math.hypot(f.mx - k.mx, f.my - k.my) < minDist) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) kept.push(f);
    }
    result.push(...kept);
  }
  return result;
}

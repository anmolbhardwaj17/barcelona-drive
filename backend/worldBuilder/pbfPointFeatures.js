/**
 * pbfPointFeatures.js
 *
 * Parse all new point-based OSM features in a single PBF scan:
 *   - Traffic signals  (highway=traffic_signals)
 *   - Street lamps     (highway=street_lamp)
 *   - Individual trees (natural=tree)
 *   - Tourism POIs     (tourism=*, historic=*)
 *   - Metro stations   (railway=station + station=subway, or public_transport=stop_position + subway=yes)
 *   - Healthcare       (amenity=hospital|clinic|doctors|dentist|pharmacy)
 *   - Shops/commerce   (shop=*, amenity=restaurant|cafe|bar|fast_food|pub|ice_cream)
 *
 * Strategy:
 *   Phase 1 (nodes): collect all qualifying nodes + record way refs for way-based tourism/healthcare
 *   Phase 2 (nodes): resolve positions of way centroid features (only if ways found in phase 1)
 *
 * Returns: { trafficSignals, streetLamps, trees, tourismPois, metroStations, healthcare, shops }
 * All features have: { id, lat, lon, mx, my, ...typeSpecificFields }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim().toLowerCase() : def;
}

function getTagRaw(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
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

// ── Shop category encoding ─────────────────────────────────────────────────
// Uint8 code per shop/amenity. 0 = other/unknown. Used in binary tile.
export const SHOP_CATEGORY = {
  // Food service (amenity=)
  restaurant: 1, cafe: 2, bar: 3, fast_food: 4, pub: 5, ice_cream: 6, food_court: 7,
  // Food retail (shop=)
  bakery: 8, supermarket: 9, convenience: 10, butcher: 11, greengrocer: 12,
  deli: 13, fishmonger: 14, confectionery: 15,
  // Health
  pharmacy: 16, optician: 17,
  // Fashion
  clothes: 18, shoes: 19,
  // Services
  hairdresser: 20, beauty: 21, bank: 22, laundry: 23,
  // Misc retail
  gift: 24, kiosk: 25, newsagent: 26, electronics: 27, books: 28,
  florist: 29, jewelry: 30,
  // Catch-all
  other: 0,
};

function getShopCategory(tags) {
  const amenity = getTag(tags, 'amenity');
  if (amenity === 'restaurant') return SHOP_CATEGORY.restaurant;
  if (amenity === 'cafe')       return SHOP_CATEGORY.cafe;
  if (amenity === 'bar')        return SHOP_CATEGORY.bar;
  if (amenity === 'fast_food')  return SHOP_CATEGORY.fast_food;
  if (amenity === 'pub')        return SHOP_CATEGORY.pub;
  if (amenity === 'ice_cream')  return SHOP_CATEGORY.ice_cream;
  const shop = getTag(tags, 'shop');
  if (!shop) return null; // not a shop
  return SHOP_CATEGORY[shop] ?? SHOP_CATEGORY.other;
}

function isShop(tags) {
  const amenity = getTag(tags, 'amenity');
  if (['restaurant', 'cafe', 'bar', 'fast_food', 'pub', 'ice_cream'].includes(amenity)) return true;
  const shop = getTag(tags, 'shop');
  return !!shop; // any shop= tag qualifies
}

// ── Tourism type detection ─────────────────────────────────────────────────
const TOURISM_KEEP = new Set([
  'attraction', 'museum', 'gallery', 'artwork', 'viewpoint',
  'hotel', 'hostel', 'information', 'monument',
]);
const HISTORIC_KEEP = new Set([
  'monument', 'memorial', 'ruins', 'castle', 'church', 'building',
  'archaeological_site', 'city_gate',
]);

function getTourismType(tags) {
  const tourism = getTag(tags, 'tourism');
  if (tourism && TOURISM_KEEP.has(tourism)) return `tourism_${tourism}`;
  const historic = getTag(tags, 'historic');
  if (historic && HISTORIC_KEEP.has(historic)) return `historic_${historic}`;
  return null;
}

// ── Healthcare type detection ──────────────────────────────────────────────
const HEALTHCARE_AMENITIES = new Set([
  'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy',
  'veterinary', 'social_facility',
]);
const HEALTHCARE_TAG = new Set(['hospital', 'clinic', 'doctor']);

function getHealthcareType(tags) {
  const amenity = getTag(tags, 'amenity');
  if (HEALTHCARE_AMENITIES.has(amenity)) return amenity;
  const healthcare = getTag(tags, 'healthcare');
  if (HEALTHCARE_TAG.has(healthcare)) return healthcare;
  return null;
}

// ── Metro station detection ────────────────────────────────────────────────
function isMetroStation(tags) {
  const railway  = getTag(tags, 'railway');
  const station  = getTag(tags, 'station');
  const pt       = getTag(tags, 'public_transport');
  const subway   = getTag(tags, 'subway');
  if (railway === 'station' && (station === 'subway' || station === 'metro')) return true;
  if (pt === 'stop_position' && (subway === 'yes' || station === 'subway')) return true;
  return false;
}

/**
 * Parse all point features in one combined PBF scan (2 phases).
 */
export async function parsePbfPointFeatures(pbfPath, bbox, onProgress) {
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  console.log('  PBF (point features):', resolved);

  const trafficSignals = [];
  const streetLamps    = [];
  const trees          = [];
  const tourismPois    = [];
  const metroStations  = [];
  const healthcare     = [];
  const shops          = [];

  // Way-based tourism/healthcare: collect refs for centroid calculation
  const tourismWays    = []; // { id, type, name, nodeRefs }
  const healthcareWays = []; // { id, type, name, nodeRefs }
  const neededNodes    = new Set();

  const through2 = (await import('through2')).default;
  let chunks = 0;

  // ── Phase 1: scan all nodes + collect way refs ─────────────────────────
  console.log('  Phase 1: scanning nodes for all point feature types...');
  const stream1 = await createPbfStream(pbfPath);
  await new Promise((resolve, reject) => {
    stream1.pipe(through2.obj(function (items, enc, next) {
      for (const item of items) {
        const tags = item.tags || {};

        if (item.type === 'node' && item.lat != null && item.lon != null) {
          if (!nodeInBbox(item.lat, item.lon, bbox)) continue;
          const m = latLonToMercator(item.lat, item.lon);

          const highway = getTag(tags, 'highway');
          if (highway === 'traffic_signals') {
            trafficSignals.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              direction: getTagRaw(tags, 'direction') || null,
            });
            continue;
          }
          if (highway === 'street_lamp') {
            streetLamps.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              height: parseFloat(getTag(tags, 'height')) || null,
            });
            continue;
          }

          const natural = getTag(tags, 'natural');
          if (natural === 'tree') {
            const sp = getTagRaw(tags, 'species') || getTagRaw(tags, 'taxon') || null;
            const ht = parseFloat(getTag(tags, 'height')) || null;
            trees.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              species: sp ? sp.slice(0, 40) : null,
              height: ht,
            });
            continue;
          }

          const tourismType = getTourismType(tags);
          if (tourismType) {
            tourismPois.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              type: tourismType,
              name: getTagRaw(tags, 'name') || null,
            });
            continue;
          }

          if (isMetroStation(tags)) {
            metroStations.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              name:    getTagRaw(tags, 'name') || null,
              network: getTagRaw(tags, 'network') || null,
              lines:   getTagRaw(tags, 'ref') || null,
            });
            continue;
          }

          const hcType = getHealthcareType(tags);
          if (hcType) {
            healthcare.push({
              id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
              type: hcType,
              name: getTagRaw(tags, 'name') || null,
            });
            continue;
          }

          if (isShop(tags)) {
            const cat = getShopCategory(tags);
            if (cat !== null) {
              shops.push({
                id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
                cat,
                name: getTagRaw(tags, 'name')?.slice(0, 64) || null,
              });
            }
            continue;
          }

        } else if (item.type === 'way') {
          // Collect way-based tourism/healthcare for centroid computation
          const refs = item.refs || [];
          if (!refs.length) continue;

          const tourismType = getTourismType(tags);
          if (tourismType) {
            tourismWays.push({ id: item.id, type: tourismType, name: getTagRaw(tags, 'name') || null, nodeRefs: refs });
            for (const ref of refs) neededNodes.add(ref);
            continue;
          }

          const hcType = getHealthcareType(tags);
          if (hcType) {
            healthcareWays.push({ id: item.id, type: hcType, name: getTagRaw(tags, 'name') || null, nodeRefs: refs });
            for (const ref of refs) neededNodes.add(ref);
          }
        }
      }
      chunks++;
      if (onProgress && chunks % 50 === 0) {
        const total = trafficSignals.length + streetLamps.length + trees.length +
                      tourismPois.length + metroStations.length + healthcare.length + shops.length;
        onProgress(total, chunks, 'point-features');
      }
      next();
    })).on('finish', resolve).on('error', reject);
  });

  // ── Phase 2: resolve way centroids (only if needed) ────────────────────
  if (neededNodes.size > 0) {
    console.log('  Phase 2: resolving', neededNodes.size, 'way-node positions for tourism/healthcare ways...');
    const nodePositions = new Map();
    const stream2 = await createPbfStream(pbfPath);
    let chunks2 = 0;
    await new Promise((resolve, reject) => {
      stream2.pipe(through2.obj(function (items, enc, next) {
        for (const item of items) {
          if (item.type === 'node' && neededNodes.has(item.id) && item.lat != null && item.lon != null) {
            nodePositions.set(item.id, { lat: item.lat, lon: item.lon });
            if (nodePositions.size === neededNodes.size) break; // early exit possible
          }
        }
        chunks2++;
        if (onProgress && chunks2 % 50 === 0) onProgress(nodePositions.size, chunks2, 'poi-way-nodes');
        next();
      })).on('finish', resolve).on('error', reject);
    });

    for (const way of tourismWays) {
      const { lat, lon } = centroidFromWay(way.nodeRefs, nodePositions);
      if (!nodeInBbox(lat, lon, bbox)) continue;
      const m = latLonToMercator(lat, lon);
      tourismPois.push({ id: way.id, lat, lon, mx: m.x, my: m.y, type: way.type, name: way.name });
    }
    for (const way of healthcareWays) {
      const { lat, lon } = centroidFromWay(way.nodeRefs, nodePositions);
      if (!nodeInBbox(lat, lon, bbox)) continue;
      const m = latLonToMercator(lat, lon);
      healthcare.push({ id: way.id, lat, lon, mx: m.x, my: m.y, type: way.type, name: way.name });
    }
  }

  console.log(
    `  Point features found: signals:${trafficSignals.length} lamps:${streetLamps.length}` +
    ` trees:${trees.length} tourism:${tourismPois.length} metro:${metroStations.length}` +
    ` healthcare:${healthcare.length} shops:${shops.length}`
  );

  return { trafficSignals, streetLamps, trees, tourismPois, metroStations, healthcare, shops };
}

function centroidFromWay(nodeRefs, nodePositions) {
  let latSum = 0, lonSum = 0, count = 0;
  for (const ref of nodeRefs) {
    const pos = nodePositions.get(ref);
    if (pos) { latSum += pos.lat; lonSum += pos.lon; count++; }
  }
  return count > 0
    ? { lat: latSum / count, lon: lonSum / count }
    : { lat: 0, lon: 0 };
}

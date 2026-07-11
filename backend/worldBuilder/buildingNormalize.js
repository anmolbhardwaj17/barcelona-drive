/**
 * Normalize raw PBF building to tile v4 schema.
 * Height: height tag → building:levels×3.5 → default 18m.
 * Type: normalized category. Footprint: world-relative [[x,z], ...].
 */
import { mercatorToWorld, worldToMercator, getOriginMercator, mercatorToLatLon, latLonToTile } from '../projection.js';

// Phase A.4: raised from 9m (3-story) to 18m (realistic Eixample 6-story default).
// Only affects untagged buildings — OSM height/levels tags always win.
const DEFAULT_HEIGHT_M = 18;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

function parseHeightTag(tags) {
  const heightTag = tags?.height;
  if (heightTag == null || heightTag === '') return null;
  const str = String(heightTag).trim();
  const match = str.match(/^([\d.]+)\s*(m|metres?|meters?|ft|feet|')?/i);
  if (!match) return null;
  let v = parseFloat(match[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = (match[2] || 'm').toLowerCase();
  if (unit === 'ft' || unit === "'" || unit === 'feet') v *= 0.3048;
  if (v > 500) return null;
  return v;
}

function parseLevelsTag(tags) {
  const levels = tags?.['building:levels'];
  if (levels == null || levels === '') return null;
  const n = parseInt(String(levels).trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 200) return null;
  return n;
}

/** Normalize building type to schema enum. */
function normalizeBuildingType(tags) {
  // ── Priority 0: water towers (bespoke Torre-de-les-Aigües geometry in the frontend worker) ──
  const manMade = getTag(tags, 'man_made', '').toLowerCase();
  const buildingTag = getTag(tags, 'building', '').toLowerCase();
  if (manMade === 'water_tower' || buildingTag === 'water_tower') return 'water_tower';

  // ── Priority 1: amenity / tourism / leisure / shop tags (most specific) ──
  const amenity = getTag(tags, 'amenity', '').toLowerCase();
  if (amenity === 'hospital' || amenity === 'clinic' || amenity === 'doctors') return 'hospital';
  if (amenity === 'school' || amenity === 'university' || amenity === 'college' || amenity === 'kindergarten') return 'school';
  if (amenity === 'place_of_worship') return 'religious';
  if (amenity === 'police') return 'police';
  if (amenity === 'fire_station') return 'fire_station';
  if (amenity === 'bank') return 'bank';
  if (amenity === 'restaurant' || amenity === 'fast_food' || amenity === 'cafe' || amenity === 'food_court') return 'restaurant';
  if (amenity === 'cinema' || amenity === 'theatre' || amenity === 'arts_centre') return 'entertainment';
  if (amenity === 'library') return 'library';
  if (amenity === 'fuel' || amenity === 'charging_station') return 'fuel_station';
  if (amenity === 'parking') return 'parking';
  if (amenity === 'bus_station') return 'transport';

  const healthcare = getTag(tags, 'healthcare', '').toLowerCase();
  if (healthcare) return 'hospital';

  const tourism = getTag(tags, 'tourism', '').toLowerCase();
  if (tourism === 'hotel' || tourism === 'motel' || tourism === 'hostel' || tourism === 'guest_house') return 'hotel';
  if (tourism === 'museum') return 'museum';
  if (tourism === 'attraction' || tourism === 'gallery') return 'landmark';

  const leisure = getTag(tags, 'leisure', '').toLowerCase();
  if (leisure === 'sports_centre' || leisure === 'stadium' || leisure === 'fitness_centre') return 'sports';
  if (leisure === 'swimming_pool') return 'sports';

  const shop = getTag(tags, 'shop', '').toLowerCase();
  if (shop) return 'shop';

  const historic = getTag(tags, 'historic', '').toLowerCase();
  if (historic === 'monument' || historic === 'memorial' || historic === 'fort' || historic === 'castle' || historic === 'ruins') return 'historic';

  const railway = getTag(tags, 'railway', '').toLowerCase();
  const aeroway = getTag(tags, 'aeroway', '').toLowerCase();
  if (railway === 'station' || railway === 'halt') return 'transport';
  if (aeroway === 'terminal' || aeroway === 'hangar') return 'transport';

  // ── Priority 2: building=* tag ───────────────────────────────────────────
  const building = getTag(tags, 'building', '').toLowerCase().replace(/\s+/g, '_');
  if (building === 'residential' || building === 'apartments' || building === 'house' || building === 'detached' || building === 'terrace' || building === 'dormitory' || building === 'semidetached_house') return 'residential';
  if (building === 'commercial') return 'commercial';
  if (building === 'retail' || building === 'supermarket' || building === 'kiosk') return 'retail';
  if (building === 'office') return 'office';
  if (building === 'industrial' || building === 'warehouse' || building === 'factory' || building === 'manufacture') return 'industrial';
  if (building === 'hospital' || building === 'healthcare') return 'hospital';
  if (building === 'school' || building === 'university' || building === 'college' || building === 'kindergarten') return 'school';
  if (building === 'mall' || building === 'shopping_centre') return 'mall';
  if (building === 'government' || building === 'civic' || building === 'public') return 'government';
  if (building === 'religious' || building === 'church' || building === 'temple' || building === 'mosque' || building === 'cathedral' || building === 'chapel' || building === 'synagogue' || building === 'shrine' || building === 'gurudwara') return 'religious';
  if (building === 'hotel') return 'hotel';
  if (building === 'train_station' || building === 'transportation') return 'transport';
  if (building === 'parking' || building === 'garage' || building === 'garages') return 'parking';
  if (building === 'stadium') return 'sports';
  if (building === 'shed' || building === 'hut' || building === 'cabin' || building === 'static_caravan') return 'shed';
  if (building === 'ruins') return 'historic';

  return 'generic';
}

/**
 * Normalize one raw building (id, tags, pointsMercator) to v4 schema.
 * Footprint becomes world-relative [[x,z], ...].
 * @param {{ id: number, tags: object, pointsMercator: { x, y }[] }} raw
 * @param {{ includeRawTags?: boolean }} [opts]
 * @returns {{ id: number, footprint: [number, number][], height: number, levels: number|null, type: string, name: string|null, roofShape: string|null, rawTags?: object }}
 */
export function normalizeBuilding(raw, opts = {}) {
  const tags = raw.tags || {};
  let height = parseHeightTag(tags);
  if (height == null || !Number.isFinite(height)) {
    const levels = parseLevelsTag(tags);
    height = levels != null ? levels * 3.5 : DEFAULT_HEIGHT_M; // Phase A.4: 3.5m/floor (was 3.0m)
  }
  height = Math.max(1, Math.min(500, height));

  const levels = parseLevelsTag(tags);
  const name = getTag(tags, 'name') || null;
  const roofShape = getTag(tags, 'roof:shape') || null;
  const type = normalizeBuildingType(tags);

  // Material & colour from OSM tags
  const material = getTag(tags, 'building:material') || getTag(tags, 'building:facade:material') || null;
  const colour = getTag(tags, 'building:colour') || getTag(tags, 'building:color') || null;
  const roofMaterial = getTag(tags, 'roof:material') || null;
  const roofColour = getTag(tags, 'roof:colour') || getTag(tags, 'roof:color') || null;

  // OSM layer tag: negative = underground, positive = elevated
  // Also detect underground via location/tunnel/levels:underground tags (e.g. metro stations)
  const layerTag = getTag(tags, 'layer');
  const parsedLayer = parseInt(layerTag, 10);
  const location = getTag(tags, 'location').toLowerCase();
  const tunnel = getTag(tags, 'tunnel').toLowerCase();
  const levelsUnderground = parseInt(getTag(tags, 'building:levels:underground'), 10);
  const aboveGroundLevels = parseLevelsTag(tags);  // building:levels
  let layer = Number.isFinite(parsedLayer) ? parsedLayer : 0;
  if (layer === 0 && (location === 'underground' || tunnel === 'yes')) {
    layer = -1;
  }
  // If building has underground levels but 0 above-ground levels, it's fully underground
  if (layer === 0 && Number.isFinite(levelsUnderground) && levelsUnderground > 0
      && (aboveGroundLevels === 0 || aboveGroundLevels === null)) {
    layer = -1;
  }

  const footprint = (raw.pointsMercator || []).map((p) => {
    const w = mercatorToWorld(p.x, p.y);
    return [w.x, w.z];
  });

  let innerRings = null;
  if (raw.innerRingsMercator && raw.innerRingsMercator.length > 0) {
    innerRings = raw.innerRingsMercator.map((ring) =>
      ring.map((p) => {
        const w = mercatorToWorld(p.x, p.y);
        return [w.x, w.z];
      })
    );
  }

  const out = {
    id: raw.id,
    footprint,
    height,
    levels: levels != null ? levels : null,
    type,
    name: name || null,
    roofShape: roofShape || null,
    layer,
  };
  if (material) out.material = material;
  if (colour) out.colour = colour;
  if (roofMaterial) out.roofMaterial = roofMaterial;
  if (roofColour) out.roofColour = roofColour;
  if (innerRings) out.innerRings = innerRings;
  if (opts.includeRawTags && tags && Object.keys(tags).length > 0) {
    out.rawTags = { ...tags };
  }
  return out;
}

/**
 * Split normalized buildings by tile (by centroid in world -> lat/lon -> tile).
 * @param {ReturnType<normalizeBuilding>[]} buildings
 * @param {number} zoom
 * @returns {Map<string, ReturnType<normalizeBuilding>[]>}
 */
export function splitBuildingsByTile(buildings, zoom) {
  const o = getOriginMercator();
  const tiles = new Map();
  for (const b of buildings) {
    const fp = b.footprint || [];
    if (fp.length < 3) continue;
    let cx = 0;
    let cz = 0;
    const n = fp.length - (fp[0][0] === fp[fp.length - 1][0] && fp[0][1] === fp[fp.length - 1][1] ? 1 : 0);
    if (n === 0) continue;
    for (let i = 0; i < n; i++) {
      cx += fp[i][0];
      cz += fp[i][1];
    }
    cx /= n;
    cz /= n;
    const { x: mx, y: my } = worldToMercator(cx, cz);  // world centroid is real-metre (Unstretch-X)
    const { lat, lon } = mercatorToLatLon(mx, my);
    const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
    const key = `${zoom}_${tx}_${ty}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(b);
  }
  return tiles;
}

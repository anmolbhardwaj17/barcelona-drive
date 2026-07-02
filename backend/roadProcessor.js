/**
 * Filter drivable roads and enrich with width, lanes, oneway, maxSpeed.
 * Used by /map endpoint; output in Mercator.
 */
const DRIVABLE = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'service',
  'unclassified',
]);

const IGNORED = new Set([
  'footway',
  'path',
  'cycleway',
  'bridleway',
  'steps',
  'pedestrian',
  'construction',
  'corridor',
  'platform',
]);

const WIDTH_BY_TYPE = {
  motorway: 16,
  trunk: 14,
  primary: 12,
  secondary: 10,
  tertiary: 8,
  residential: 6,
  service: 4,
  unclassified: 6,
};

const LANES_BY_TYPE = {
  motorway: 4,
  trunk: 3,
  primary: 2,
  secondary: 2,
  tertiary: 2,
  residential: 1,
  service: 1,
  unclassified: 1,
};

const MAXSPEED_BY_TYPE = {
  motorway: 100,
  trunk: 80,
  primary: 60,
  secondary: 50,
  tertiary: 40,
  residential: 30,
  service: 20,
  unclassified: 30,
};

const MIN_WIDTH = 4;
const MAX_WIDTH = 20;
const MAX_ROADS_PER_TILE = 300;
const MAX_POINTS_PER_ROAD = 150;

function getTag(tags, key, def = '') {
  return tags[key] != null ? String(tags[key]).trim() : def;
}

function parseNumeric(str, fallback) {
  if (str == null || str === '') return fallback;
  const m = String(str).match(/^[\d.]+/);
  return m ? parseFloat(m[0]) : fallback;
}

function parseIntStrict(str, fallback) {
  if (str == null || str === '') return fallback;
  const n = parseInt(String(str), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getWidth(tags, highwayType, lanes) {
  const widthTag = getTag(tags, 'width');
  if (widthTag) {
    const w = parseNumeric(widthTag, null);
    if (w != null && w > 0) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
  }
  const lanesTag = parseIntStrict(getTag(tags, 'lanes'), null);
  const L = lanesTag != null ? lanesTag : lanes;
  if (L != null && L > 0) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, L * 3.5));
  const def = WIDTH_BY_TYPE[highwayType] ?? 6;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, def));
}

function getLanes(tags, highwayType) {
  const lanesTag = parseIntStrict(getTag(tags, 'lanes'), null);
  if (lanesTag != null && lanesTag > 0) return lanesTag;
  return LANES_BY_TYPE[highwayType] ?? 1;
}

function getOneWay(tags) {
  const v = getTag(tags, 'oneway').toLowerCase();
  return v === 'yes' || v === '1' || v === 'true';
}

function getMaxSpeed(tags, highwayType) {
  const ms = getTag(tags, 'maxspeed');
  if (!ms) return MAXSPEED_BY_TYPE[highwayType] ?? 30;
  const n = parseNumeric(ms, null);
  if (n != null && n > 0) return n;
  if (/mph/i.test(ms)) {
    const mph = parseNumeric(ms, null);
    if (mph != null) return Math.round(mph * 1.60934);
  }
  return MAXSPEED_BY_TYPE[highwayType] ?? 30;
}

/** Simplify polyline: keep first, last, and evenly spaced in between. */
function simplifyPoints(points, maxPoints = MAX_POINTS_PER_ROAD) {
  if (!points || points.length <= maxPoints) return points;
  const out = [];
  const n = points.length;
  const step = (n - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = i === maxPoints - 1 ? n - 1 : Math.min(Math.floor(i * step), n - 1);
    out.push(points[idx]);
  }
  return out;
}

/**
 * Filter to drivable roads only and enrich with width, lanes, isOneWay, maxSpeed.
 * Limits to MAX_ROADS_PER_TILE. Points in Mercator {x,y}.
 * @param {object[]} roads - from parseOSM: { id, name, highwayType, points }
 * @returns {object[]} { id, name, highwayType, width, lanes, isOneWay, maxSpeed, points }
 */
export function processRoads(roads) {
  if (!roads || !Array.isArray(roads)) return [];
  const out = [];
  for (const road of roads) {
    const type = (road.highwayType || '').toLowerCase().replace(/^highway\s*:\s*/, '');
    if (IGNORED.has(type)) continue;
    if (!DRIVABLE.has(type)) continue;
    const points = road.points || [];
    if (points.length < 2) continue;

    const tags = road.tags || {};
    const lanes = getLanes(tags, type);
    const width = getWidth(tags, type, lanes);
    const isOneWay = getOneWay(tags);
    const maxSpeed = getMaxSpeed(tags, type);
    const simplified = simplifyPoints(points);

    out.push({
      id: road.id,
      name: road.name != null ? String(road.name) : '',
      highwayType: type,
      width,
      lanes,
      isOneWay,
      maxSpeed,
      tunnel: !!road.tunnel,
      bridge: !!road.bridge,
      layer: road.layer != null && Number.isFinite(road.layer) ? road.layer : 0,
      points: simplified.map((p) => ({ x: p.x, y: p.y })),
    });
    if (out.length >= MAX_ROADS_PER_TILE) break;
  }
  return out;
}

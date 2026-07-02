/**
 * Building shape logic: robust height resolution, cylinder detection, shapeType + footprint.
 * Never skip a building; always assign a valid height (4–80 m). Preserve full footprint.
 */

const METERS_PER_LEVEL = 3;
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 80;
const CYLINDER_MIN_VERTICES = 8;
const CYLINDER_DEVIATION_THRESHOLD = 0.05;

/** Default height ranges [min, max] in meters by building type. Add small randomness per building. */
const DEFAULT_HEIGHT_BY_TYPE = {
  residential: [8, 12],
  apartments: [12, 20],
  commercial: [12, 25],
  industrial: [8, 15],
  warehouse: [6, 12],
  retail: [10, 18],
  office: [12, 24],
  school: [8, 18],
  hospital: [12, 25],
  hotel: [15, 30],
  garage: [4, 8],
  shed: [4, 6],
  house: [6, 12],
  detached: [6, 12],
  semidetached_house: [6, 12],
  terrace: [6, 12],
  default: [8, 14],
};

/** Deterministic pseudo-random in [0, 1) from a seed (so same building => same height). */
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Parse height from OSM "height" tag.
 * Strips units (e.g. "12 m", "50 ft"); converts ft to meters.
 * @param {object} tags
 * @returns {number|null} height in meters, or null if not parseable
 */
function parseHeightTag(tags) {
  const heightTag = tags.height;
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

/**
 * Parse height from "building:levels" tag.
 * @param {object} tags
 * @returns {number|null} height in meters, or null
 */
function parseLevelsTag(tags) {
  const levels = tags['building:levels'];
  if (levels == null || levels === '') return null;
  const n = parseInt(String(levels).trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 200) return null;
  return n * METERS_PER_LEVEL;
}

/**
 * Get default height range for building type, then apply deterministic randomness.
 * @param {string} buildingType - value of tag "building" (e.g. "residential", "yes")
 * @param {number} seed - e.g. building id, for deterministic randomness
 * @returns {number} height in meters (base + random 0–3)
 */
function getDefaultHeightByType(buildingType, seed) {
  const key = (buildingType && String(buildingType).toLowerCase().replace(/\s+/g, '_')) || 'default';
  const range = DEFAULT_HEIGHT_BY_TYPE[key] || DEFAULT_HEIGHT_BY_TYPE.default;
  const [min, max] = range;
  const r = seededRandom(seed);
  const base = min + r * (max - min);
  const extra = seededRandom(seed + 1) * 3;
  return base + extra;
}

/**
 * Robust building height: never null, always 4–80 m.
 * 1) height tag (with unit stripping)
 * 2) building:levels * 3
 * 3) Intelligent default by building type + small randomness
 * @param {object} tags - OSM tags
 * @param {number} buildingId - for deterministic default randomness
 * @returns {number} height in meters, clamped to [MIN_HEIGHT, MAX_HEIGHT]
 */
export function getBuildingHeight(tags, buildingId = 0) {
  let h = parseHeightTag(tags);
  if (h != null && Number.isFinite(h)) {
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
  }
  h = parseLevelsTag(tags);
  if (h != null && Number.isFinite(h)) {
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
  }
  const buildingType = tags.building;
  h = getDefaultHeightByType(buildingType, buildingId);
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
}

/**
 * Compute centroid of footprint (closed ring; exclude duplicate last point).
 */
function centroid(footprint) {
  const pts =
    footprint.length > 1 &&
    footprint[0].x === footprint[footprint.length - 1].x &&
    footprint[0].y === footprint[footprint.length - 1].y
      ? footprint.slice(0, -1)
      : footprint;
  if (pts.length === 0) return { x: 0, y: 0 };
  let sx = 0,
    sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const n = pts.length;
  return { x: sx / n, y: sy / n };
}

/**
 * Check if footprint approximates a circle (>= 8 vertices, low deviation from mean radius).
 * Preserves shapeType = "cylinder" for round buildings.
 */
function detectCylinder(footprint) {
  const pts =
    footprint.length > 1 &&
    footprint[0].x === footprint[footprint.length - 1].x &&
    footprint[0].y === footprint[footprint.length - 1].y
      ? footprint.slice(0, -1)
      : footprint;
  if (pts.length < CYLINDER_MIN_VERTICES) return { isCylinder: false };

  const c = centroid(footprint);
  const dists = pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  if (mean < 0.1) return { isCylinder: false };
  const maxDev = Math.max(...dists.map((d) => Math.abs(d - mean)));
  if (maxDev / mean > CYLINDER_DEVIATION_THRESHOLD) return { isCylinder: false };
  return { isCylinder: true, center: c, radius: mean };
}

/**
 * Process raw building from OSM parser into API shape.
 * - Full footprint preserved (no aggressive simplification).
 * - Height always a number in meters (4–80).
 * - shapeType "cylinder" when footprint approximates a circle.
 * @param {{ id: number, tags: object, pointsMercator: {x,y}[] }} raw
 * @returns {{ id: number, height: number, shapeType: string, footprint: {x,y}[], tags: object, center?: {x,y}, radius?: number }}
 */
export function processBuilding(raw) {
  const height = getBuildingHeight(raw.tags, raw.id);
  const footprint = raw.pointsMercator.map((p) => ({ x: p.x, y: p.y }));

  const { isCylinder, center, radius } = detectCylinder(footprint);
  if (isCylinder && center != null && radius != null) {
    return {
      id: raw.id,
      height,
      shapeType: 'cylinder',
      footprint,
      tags: raw.tags || {},
      center: { x: center.x, y: center.y },
      radius,
    };
  }

  return {
    id: raw.id,
    height,
    shapeType: 'polygon',
    footprint,
    tags: raw.tags || {},
  };
}

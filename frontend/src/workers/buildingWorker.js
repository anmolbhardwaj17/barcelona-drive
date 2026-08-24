/**
 * buildingWorker.js — Pure-math building geometry generator for Web Workers.
 *
 * NO Three.js, NO DOM. Replicates the full building processing pipeline from
 * buildingRenderer.js, producing raw Float32Array/Uint32Array buffers suitable
 * for transfer to the main thread.
 *
 * Entry point: processBuildingsInWorker(data, config)
 */

import {
  extrudePolygonWalls,
  createCylinderWalls,
  triangulatePolygon,
  createCylinderFull,
  createCircle,
  createTorus,
  createSphere,
  makeBoxGeom,
  makeQuadGeom,
  mergeBufferSets,
  applyTranslation,
  applyRotationX,
  applyRotationY,
} from './workerGeometry.js';

import earcut from './earcut.js';
import { FLOOR_HEIGHT, WALL_REPEAT_HORIZONTAL_M, AO_FACADE_STRENGTH, AO_GAMMA } from '../buildingConstants.js';   // v3 P1-13: single source (was mirrored here)

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const BUILDING_Z_OFFSET = 0.05;
const ROOF_Y_OFFSET = 0.03;
const MAX_VERTICES_PER_TILE = 60000;
const CYLINDER_RADIAL_SEGMENTS = 6;
const MAX_FOOTPRINT_VERTICES = 16;
// (Unstretch-X §3) MERCATOR_SCALE purged — footprint wall lengths are now real metres from the
// honest projection, so facade UV repeat = wallLength / WALL_REPEAT_HORIZONTAL_M directly.

const BALCONY_VERT_CAP = 40000;
const COMMERCIAL_VERT_CAP = 40000;
const MALL_VERT_CAP = 10000;
const RELIGIOUS_VERT_CAP = 20000;
const BOUNDARY_VERT_CAP = 30000;

// ── Elevation origin — MUST match frontend/src/projection.js ORIGIN_LAT/ORIGIN_LON ──
const R = 6378137;
const ORIGIN_LAT = 41.350;
const ORIGIN_LON = 2.115;
const _originLatRad = ORIGIN_LAT * Math.PI / 180;
const _originLonRad = ORIGIN_LON * Math.PI / 180;
const originMercator = {
  x: R * _originLonRad,
  y: R * Math.log(Math.tan(Math.PI / 4 + _originLatRad / 2)),
};
// Unstretch-X (vertical-model-foundation-spec §3): world XZ = (mercator − origin) × cos(ORIGIN_LAT)
// so 1 world unit = 1 real metre. MUST match frontend/src/projection.js MERCATOR_UNSTRETCH.
const MERCATOR_UNSTRETCH = Math.cos(_originLatRad);

// ── Facade palettes ──

// Barcelona Eixample warm-masonry palette (cream/ochre/sandstone/pale-yellow/rose/warm-stone).
const FACADE_PALETTES = {
  // (warmth eased: the yellowest ochre entries pulled toward neutral cream — walls read too golden)
  residential: [
    0xEDE6D6, 0xF2ECDE, 0xE7DECB, 0xEAE3D2, 0xE0D6C0,
    0xE0D3BC, 0xD8CAAE, 0xCFC1A4, 0xDED2BA, 0xD3C5A8,
    0xE6DCC0, 0xDED2B2, 0xE0C8B6, 0xD6BBA6,
    0xCFC7B6, 0xC5BBA8, 0xC89A78, 0xBC8E70,
  ],
  commercial: [
    0xE6D8BE, 0xDACDB4, 0xD2C2A6, 0xE0D8BC, 0xD7CEB2,
    0xE8E0CE, 0xDED3BC, 0xE4DAC6, 0xD6CBB2,
    0xD8B89C, 0xCBA888, 0xD0B294,
    0xE0D8B8, 0xD9D0AE, 0xD0C7B2,
  ],
  office:      [0xDED6C4, 0xD4CAB4, 0xE2DBCB, 0xCFC6B2, 0xD8D0BE],
  hospital:    [0xE8E2D4, 0xDED8C8, 0xD6CFBE, 0xECE6DA, 0xE0DACB],
  school:      [0xE0D8C2, 0xD6CCB4, 0xCFC6AE, 0xDCD4BE, 0xD2C9B0],
  industrial:  [0x9E5A3E, 0xA86848, 0xB0704E, 0x8C5236, 0x96604A, 0xA45C40, 0xB8785A], // Poblenou red brick
  religious: [
    // Barcelona churches: warm sandstone / grey stone (Gothic/Romanesque), not bright red.
    0xD8C8A0, 0xCEBE94, 0xD2C6A8, 0xDED2B0, 0xD4CAB2,
    0xC8C2B0, 0xBEB8A6, 0xCEC8B6,
    0xC8A078, // terracotta/brick accent (Modernisme, rare)
  ],
  commercial_glass: [
    // Near-white: the full-glass mosaic TEXTURE carries the colour (Agbar blues/teals + warm
    // flecks) — a saturated tint here would mud it. Slight cool variation only.
    0xEDF1F4, 0xE6ECF0, 0xF0F3F5, 0xE2EAEF, 0xEAF0F2,
  ],
};
// Barcelona redesign flags (mirror buildingRenderer.js).
const ENABLE_DELHI_DETAILS = false; // boundary walls/gates, setback, shikhara, billboards, AC, water tanks, garage shutters
const BALCONY_CATEGORIES = new Set(['residential', 'commercial', 'office']); // masonry blocks that get balconies + bands

// Barcelona-from-above signature: the residential fabric is TERRACOTTA clay tile (the orange rooftop sea
// in every aerial of the city). Modern office/industrial/glass keep grey flat roofs for realistic contrast.
const ROOF_PALETTES = {
  // Reference-matched (real Barceloneta/Eixample aerials): MID-DARK dusty terracotta dominates,
  // pale sand roofs are the sparse exception (~6:2, not half-half). Bases are deliberately darker
  // + moderately desaturated because the rally grade multiplies saturation ×1.52 and lifts
  // brightness — light bases wash to cream, saturated bases go fire-red; mid-dark dusty survives.
  // (peach pass: blue channel raised on all clays — rotates orange-brown toward peach/salmon-pink.
  //  Spread TIGHTENED around the approved mid-peach: the old deep entries 0x84493C/0x955446 hit
  //  maroon after the ×0.85 per-building variation and read as "wrong dark roofs" in whole blocks.)
  residential: [0xAD6B5C, 0xA76A5C, 0xC4A48E, 0xB57866, 0xA5685A, 0xBA8270, 0xA06452, 0xBC9C88],
  commercial:  [0xAD6B5C, 0xA76A5C, 0xBEB4A8, 0xB2978A, 0xB57866, 0xA5685A, 0xBA8270, 0xB2A192], // mixed: many older blocks tiled
  office:      [0xC0C8D0, 0xB8C0C8, 0xC4CCD4, 0xB4BCC4, 0xCAD0D6],
  hospital:    [0xD6D2CC, 0x99684A, 0xD0CCC6, 0x8F5537, 0xCCC8C2],   // older masonry wards often tiled
  school:      [0x95573A, 0xD0CAB2, 0x8A4E31, 0xD4CEB6, 0x9D6142],   // ditto
  industrial:  [0xBAB6AE, 0xB2AEA6, 0xACA8A0, 0xB6B2AA, 0xC0BCB4],
  religious:   [0x5E574E, 0x564F47, 0x645C52, 0x524B43, 0x6A6258], // dark slate/lead church roof
  commercial_glass: [0xA0B0C0, 0x98A8B8, 0xA8B8C8, 0x90A0B0, 0xB0C0D0],
};

// ── Type to category mapping ──

const TYPE_TO_CATEGORY = {
  residential: 'residential',
  commercial:  'commercial',
  retail:      'commercial',
  shop:        'commercial',
  office:      'office',
  industrial:  'industrial',
  warehouse:   'industrial',
  factory:     'industrial',
  hospital:    'hospital',
  healthcare:  'hospital',
  school:      'school',
  religious:   'religious',
  mall:        'commercial',
  government:  'office',
};

// ────────────────────────────────────────────────────────────────────────────
// Deterministic helpers
// ────────────────────────────────────────────────────────────────────────────

function deterministicIndex(id) {
  const h = (id * 9301 + 49297) % 233280;
  return Math.abs(h);
}

// ────────────────────────────────────────────────────────────────────────────
// Elevation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create fast elevation sampler (pure math, no imports).
 * Replicates createFastElevation from fastElevation.js.
 */
function createFastElevation(elevation, offset) {
  if (!elevation || !elevation.elevations || (!Array.isArray(elevation.elevations) && !ArrayBuffer.isView(elevation.elevations))) {
    // No grid → fall back to the spawn-normalized ground floor (sea level ≈ -offset), NOT absolute 0.
    // Returning 0 (the spawn-height plane) floats whole building blocks ~offset metres up at the port/hills.
    return () => -offset;
  }

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;

  const southRad = south * Math.PI / 180;
  const northRad = north * Math.PI / 180;
  const mySouth = R * Math.log(Math.tan(Math.PI / 4 + southRad / 2));
  const myNorth = R * Math.log(Math.tan(Math.PI / 4 + northRad / 2));
  const mxWest  = R * (west * Math.PI / 180);
  const mxEast  = R * (east * Math.PI / 180);

  const wSouth = (mySouth - originMercator.y) * MERCATOR_UNSTRETCH;
  const wNorth = (myNorth - originMercator.y) * MERCATOR_UNSTRETCH;
  const wWest  = (mxWest  - originMercator.x) * MERCATOR_UNSTRETCH;
  const wEast  = (mxEast  - originMercator.x) * MERCATOR_UNSTRETCH;

  const rowSpan = wNorth - wSouth;
  const colSpan = wEast - wWest;
  const rowScale = rowSpan > 1e-10 ? (gridRows - 1) / rowSpan : 0;
  const colScale = colSpan > 1e-10 ? (gridCols - 1) / colSpan : 0;
  const rowOff   = -wSouth * rowScale;
  const colOff   = -wWest  * colScale;
  const maxRow   = gridRows - 1;
  const maxCol   = gridCols - 1;

  return function fastElevationAt(wx, wz) {
    let rowF = wz * rowScale + rowOff;
    let colF = wx * colScale + colOff;

    if (rowF < 0) rowF = 0; else if (rowF > maxRow) rowF = maxRow;
    if (colF < 0) colF = 0; else if (colF > maxCol) colF = maxCol;

    const r0 = rowF | 0;
    const c0 = colF | 0;
    const r1 = r0 < maxRow ? r0 + 1 : r0;
    const c1 = c0 < maxCol ? c0 + 1 : c0;
    const tr = rowF - r0;
    const tc = colF - c0;

    const v00 = elevations[r0 * gridCols + c0];
    const v10 = elevations[r1 * gridCols + c0];
    const v01 = elevations[r0 * gridCols + c1];
    const v11 = elevations[r1 * gridCols + c1];

    const raw = (1 - tr) * ((1 - tc) * v00 + tc * v01) + tr * ((1 - tc) * v10 + tc * v11);
    return raw - offset;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Baked sky-visibility AO (tile v9) — facade darkening
// ────────────────────────────────────────────────────────────────────────────

// MUST MATCH frontend/src/map/aoSampler.js (workers are import-free): strength/gamma dials for the
// svf → darkening curve, applied per facade vertex with a vertical fade (canyon floors dark, upper
// storeys open to the sky).
const AO_FACADE_FADE_M = 16;     // full AO at the base → none this many metres up
const AO_SAMPLE_OUTSET = 2.5;    // sample the STREET next to the wall, not the wall itself —
                                 // the grid cell under a facade averages in the building interior (svf≈0)

/** Bilinear sky-view-factor sampler over the tile's aoGrid — same world→grid mapping as
 *  createFastElevation (the aoGrid shares the elevation grid's bounds/orientation). */
function createWorkerAoSampler(elevation, aoGrid) {
  if (!aoGrid || !aoGrid.data || !aoGrid.resolution || !elevation) return null;
  const res = aoGrid.resolution;
  const data = aoGrid.data;
  if (data.length !== res * res) return null;

  const { south, west, north, east } = elevation;
  const southRad = south * Math.PI / 180;
  const northRad = north * Math.PI / 180;
  const mySouth = R * Math.log(Math.tan(Math.PI / 4 + southRad / 2));
  const myNorth = R * Math.log(Math.tan(Math.PI / 4 + northRad / 2));
  const mxWest  = R * (west * Math.PI / 180);
  const mxEast  = R * (east * Math.PI / 180);
  const wSouth = (mySouth - originMercator.y) * MERCATOR_UNSTRETCH;
  const wNorth = (myNorth - originMercator.y) * MERCATOR_UNSTRETCH;
  const wWest  = (mxWest  - originMercator.x) * MERCATOR_UNSTRETCH;
  const wEast  = (mxEast  - originMercator.x) * MERCATOR_UNSTRETCH;
  const rowScale = (res - 1) / (wNorth - wSouth);
  const colScale = (res - 1) / (wEast - wWest);
  const maxRC = res - 1;

  return function svfAt(wx, wz) {
    let rowF = (wz - wSouth) * rowScale;
    let colF = (wx - wWest) * colScale;
    if (rowF < 0) rowF = 0; else if (rowF > maxRC) rowF = maxRC;
    if (colF < 0) colF = 0; else if (colF > maxRC) colF = maxRC;
    const r0 = rowF | 0, c0 = colF | 0;
    const r1 = r0 < maxRC ? r0 + 1 : r0, c1 = c0 < maxRC ? c0 + 1 : c0;
    const tr = rowF - r0, tc = colF - c0;
    const v00 = data[r0 * res + c0], v01 = data[r0 * res + c1];
    const v10 = data[r1 * res + c0], v11 = data[r1 * res + c1];
    return ((1 - tr) * ((1 - tc) * v00 + tc * v01) + tr * ((1 - tc) * v10 + tc * v11)) / 255;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Road spatial index (inline, no external dependencies)
// ────────────────────────────────────────────────────────────────────────────

function pointToSegmentSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qz = az + t * dz;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

function distanceToRoadSq(px, pz, points) {
  if (!points || points.length < 2) return Infinity;
  let minSq = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = pointToSegmentSq(px, pz, a.x, a.y, b.x, b.y);
    if (d < minSq) minSq = d;
  }
  return minSq;
}

function findNearestRoadSegment(roads, worldX, worldZ) {
  if (!roads || roads.length === 0) return null;
  let best = null;
  let bestSq = Infinity;
  for (const road of roads) {
    const dSq = distanceToRoadSq(worldX, worldZ, road.points);
    if (dSq < bestSq) {
      bestSq = dSq;
      best = {
        road,
        highwayType: road.highwayType || 'unclassified',
        distance: Math.sqrt(dSq),
      };
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────────────────
// Building category
// ────────────────────────────────────────────────────────────────────────────

function getBuildingCategory(building, roads, worldX, worldZ) {
  // TALL TOWERS ARE GLASS (user call, 2026-07-11): Barcelona's high-rises (Torre Mapfre, Hotel
  // Arts, Agbar, Diagonal Mar…) are all modern glass — masonry textures on a 100m+ slab read
  // wrong. ≥55m → glass curtain wall regardless of OSM type; explicit glass material tags too.
  // (religious spires keep their stone — Sagrada Família is 170m of not-glass.)
  const mat = (building.material || '').toLowerCase();
  if (building.type !== 'church' && building.type !== 'cathedral'
      && ((Number.isFinite(building.height) && building.height >= 55) || mat === 'glass' || mat === 'mirror')) {
    return 'commercial_glass';
  }
  const mapped = TYPE_TO_CATEGORY[building.type];
  if (mapped) return mapped;
  // Barcelona: generic/untagged → warm Eixample MASONRY (residential) by default, NOT commercial/glass.
  // Buildings on a busy artery get warm 'commercial' (ground-floor shops) for variety.
  if (roads && roads.length > 0) {
    const nearest = findNearestRoadSegment(roads, worldX, worldZ);
    if (nearest) {
      const t = nearest.highwayType;
      if (t === 'primary' || t === 'secondary' || t === 'primary_link' || t === 'secondary_link') return 'commercial';
    }
  }
  return 'residential';
}

// ────────────────────────────────────────────────────────────────────────────
// Facade / Roof tint
// ────────────────────────────────────────────────────────────────────────────

// DRAW-CALL COLLAPSE: palette colours are BAKED into the vertex-colour attribute (in linear space, matching
// how three interprets material.color) and every facade/roof shares one WHITE material per category. The
// per-tile merge then produces a handful of building meshes instead of one per palette colour — the audit
// showed ~200+ draws across ~25 colour-keyed material signatures; this removes them with zero new machinery.
function srgbHexToLinear(hex) {
  const f = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  return { r: f(((hex >> 16) & 255) / 255), g: f(((hex >> 8) & 255) / 255), b: f((hex & 255) / 255) };
}

function pickFacadeColorHex(category, buildingId) {
  const pal = FACADE_PALETTES[category] ?? FACADE_PALETTES.commercial;
  return pal[deterministicIndex(buildingId) % pal.length];
}

function getFacadeTint(building, category) {
  const v = 0.85 + (deterministicIndex(building.id) % 21) / 100;
  const c = srgbHexToLinear(pickFacadeColorHex(category, building.id));
  return { r: c.r * v, g: c.g * v, b: c.b * v };
}

// Low structures (< 8m) are mostly the single-storey interiors of Eixample blocks — flat gravel/terrace
// roofs in reality, NOT clay tile. Keeping them grey-tan carves the real courtyard pattern out of the
// terracotta fabric (orange perimeter rings, muted interiors), matching aerial Barcelona.
// Flat terrats (low buildings): dusty warm tan tiles, a step deeper than before — the bright sands
// were washing to cream under the rally grade and dominating the aerial view.
const TERRACE_ROOFS = [0xBC9C88, 0xB29080, 0xC4A48E, 0xB49588, 0xBD9F90];   // peach-tinted tans (match the clay rotation)

function pickRoofColorHex(category, buildingId, height) {
  const pal = (Number.isFinite(height) && height < 8 && category !== 'religious')
    ? TERRACE_ROOFS
    : (ROOF_PALETTES[category] ?? ROOF_PALETTES.residential);
  return pal[deterministicIndex(buildingId + 7) % pal.length];
}

function getRoofTint(category, buildingId, height) {
  const v = 0.85 + (deterministicIndex(buildingId) % 21) / 100;
  const c = srgbHexToLinear(pickRoofColorHex(category, buildingId, height));
  return { r: c.r * v, g: c.g * v, b: c.b * v };
}

// ────────────────────────────────────────────────────────────────────────────
// Material key generation — colour is baked into vertices, so keys collapse to one per category (facades)
// and ONE total (roofs). The materializer's existing key parser sees hex FFFFFF → white materials.
// ────────────────────────────────────────────────────────────────────────────

function getFacadeMaterialKey(category, id = 0, height = 0) {
  // Hero-lit buildings: a small deterministic set of TALL buildings gets a '#hero' facade variant —
  // dense warm windows + stronger glow at night (the reference render's glowing tower). Identical by
  // day. The marker rides inside the category segment so the materializer's key parser is untouched.
  const n = Number(id) || 0;
  const hero = height >= 28 && ((n * 2654435761) >>> 0) % 7 === 0;
  return 'facade_' + category + (hero ? '#hero' : '') + '_FFFFFF';
}

function getRoofMaterialKey() {
  return 'roof_FFFFFF';
}

// ────────────────────────────────────────────────────────────────────────────
// Footprint simplification (RDP)
// ────────────────────────────────────────────────────────────────────────────

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function simplifyFootprint(footprint) {
  if (!footprint || footprint.length <= MAX_FOOTPRINT_VERTICES) return footprint;
  let epsilon = 0.3;
  let simplified = rdpSimplify(footprint, epsilon);
  while (simplified.length > MAX_FOOTPRINT_VERTICES && epsilon < 3) {
    epsilon *= 1.5;
    simplified = rdpSimplify(footprint, epsilon);
  }
  return simplified.length >= 3 ? simplified : footprint;
}

// ────────────────────────────────────────────────────────────────────────────
// Point-in-polygon
// ────────────────────────────────────────────────────────────────────────────

function pointInFootprint(px, pz, fp) {
  let inside = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const xi = fp[i].x, zi = fp[i].y, xj = fp[j].x, zj = fp[j].y;
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Get centroid and clean (non-duplicate-closing) points for a footprint.
 */
function getFootprintCentroid(footprint) {
  let pts = footprint;
  if (pts.length > 1 &&
      pts[0].x === pts[pts.length - 1].x &&
      pts[0].y === pts[pts.length - 1].y) {
    pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length;
  cy /= pts.length;
  return { cx, cy, pts };
}

/**
 * Get cylinder params from a building.
 */
function getCylinderParams(building) {
  if (building.center != null && building.radius != null && Number.isFinite(building.radius)) {
    return { cx: building.center.x, cy: building.center.y, radius: building.radius };
  }
  const footprint = building.footprint || [];
  if (footprint.length < 3) return null;
  const pts =
    footprint.length > 1 &&
    footprint[0].x === footprint[footprint.length - 1].x &&
    footprint[0].y === footprint[footprint.length - 1].y
      ? footprint.slice(0, -1)
      : footprint;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const radius = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  return { cx, cy, radius };
}

/**
 * Create wall geometry for a polygon building (replaces createPolygonBuilding).
 */
function createPolygonWallBuffers(building, baseY) {
  let footprint = building.footprint || [];
  if (footprint.length < 3) return null;
  footprint = simplifyFootprint(footprint);

  const uvConfigFn = (wallLength) => ({
    hRepeat: wallLength / WALL_REPEAT_HORIZONTAL_M,  // wallLength is real metres (Unstretch-X)
    vRepeat: building.height / FLOOR_HEIGHT,
  });

  // Handle inner rings (holes) — walls also needed for inner edges
  const outerWalls = extrudePolygonWalls(footprint, building.height, baseY, uvConfigFn);
  if (!outerWalls) return null;

  if (building.innerRings && building.innerRings.length > 0) {
    const allWalls = [outerWalls];
    for (let ring of building.innerRings) {
      if (!ring || ring.length < 3) continue;
      ring = simplifyFootprint(ring);
      const innerWalls = extrudePolygonWalls(ring, building.height, baseY, uvConfigFn);
      if (innerWalls) allWalls.push(innerWalls);
    }
    return allWalls.length === 1 ? outerWalls : mergeBufferSets(allWalls);
  }

  return outerWalls;
}

/**
 * BULLET TOWER (Torre Agbar reference, user call 2026-07-11): a revolve whose profile is
 * near-cylindrical for the lower ~55% then converges into a rounded dome — for a deterministic
 * subset of tall glass towers. Proper facade UVs (u = arc-metres/12, v = metres/10) so the glass
 * mosaic texture wraps cleanly; caller skips the flat roof (the crown closes itself).
 */
function createBulletTowerBuffers(building, baseY, cx, cy) {
  let R = 0;
  for (const p of building.footprint) R = Math.max(R, Math.hypot(p.x - cx, p.y - cy));
  R = Math.max(8, Math.min(R * 0.92, 22));
  const H = building.height;
  const SEGS = 18, RINGS = 16;
  const profile = (t) => t < 0.55 ? (0.94 + 0.06 * Math.sin((t / 0.55) * Math.PI / 2))
                                  : Math.max(0.10, Math.pow(Math.cos(((t - 0.55) / 0.45) * Math.PI / 2), 0.75));
  const positions = [], uvs = [], indices = [];
  for (let ri = 0; ri <= RINGS; ri++) {
    const t = ri / RINGS;
    const r = R * profile(t);
    const y = baseY + t * H;
    for (let s = 0; s <= SEGS; s++) {                     // +1 duplicated seam vertex for clean UV wrap
      const a = (s / SEGS) * Math.PI * 2;
      positions.push(cx + Math.cos(a) * r, y, cy + Math.sin(a) * r);
      uvs.push((s / SEGS) * ((2 * Math.PI * R) / WALL_REPEAT_HORIZONTAL_M), (t * H) / FLOOR_HEIGHT);
    }
  }
  const row = SEGS + 1;
  for (let ri = 0; ri < RINGS; ri++) {
    for (let s = 0; s < SEGS; s++) {
      const a0 = ri * row + s, b0 = a0 + 1, a1 = a0 + row, b1 = b0 + row;
      indices.push(a0, a1, b0, b0, a1, b1);
    }
  }
  // Cap the crown with a small fan.
  const topCenter = positions.length / 3;
  positions.push(cx, baseY + H + R * 0.02, cy);
  uvs.push(0.5, (H) / FLOOR_HEIGHT);
  const lastRing = RINGS * row;
  for (let s = 0; s < SEGS; s++) indices.push(lastRing + s, topCenter, lastRing + s + 1);
  const buffers = {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
  buffers.normals = computeVertexNormals(buffers.positions, buffers.indices);
  return buffers;
}

/**
 * Create wall geometry for a cylinder building.
 */
function createCylinderWallBuffers(building, baseY) {
  const params = getCylinderParams(building);
  if (!params) return null;
  const { cx, cy, radius } = params;
  const h = building.height;

  const perimeter = 2 * Math.PI * radius;
  const uvConfig = {
    horizontalRepeat: perimeter / WALL_REPEAT_HORIZONTAL_M,  // perimeter is real metres (Unstretch-X)
    verticalRepeat: h / FLOOR_HEIGHT,
  };

  return createCylinderWalls(cx, cy, radius, h, baseY, CYLINDER_RADIAL_SEGMENTS, uvConfig);
}

/**
 * Create roof geometry for a polygon building.
 */
function createPolygonRoofBuffers(building, baseY) {
  let footprint = building.footprint || [];
  if (footprint.length < 3) return null;
  footprint = simplifyFootprint(footprint);

  const roofY = baseY + building.height + ROOF_Y_OFFSET;
  let holes = null;
  if (building.innerRings && building.innerRings.length > 0) {
    holes = [];
    for (let ring of building.innerRings) {
      if (!ring || ring.length < 3) continue;
      ring = simplifyFootprint(ring);
      holes.push(ring);
    }
    if (holes.length === 0) holes = null;
  }

  return triangulatePolygon(footprint, holes, roofY, earcut);
}

/**
 * Create roof geometry for a cylinder building (flat disc).
 */
function createCylinderRoofBuffers(building, baseY) {
  const params = getCylinderParams(building);
  if (!params) return null;
  const { cx, cy, radius } = params;
  const roofY = baseY + building.height + ROOF_Y_OFFSET;

  const disc = createCircle(radius, CYLINDER_RADIAL_SEGMENTS);
  // Circle is in XZ plane at Y=0, translate to position
  applyTranslation(disc, cx, roofY, cy);
  return disc;
}

/**
 * Apply vertex color tint to a buffer set.
 */
function applyVertexColorToBuffers(buffers, tintColor) {
  const vertCount = buffers.positions.length / 3;
  const colors = new Float32Array(vertCount * 3);
  const r = tintColor.r, g = tintColor.g, b = tintColor.b;
  for (let i = 0; i < vertCount; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  buffers.colors = colors;
  return buffers;
}

/**
 * Ensure buffer set has colors (default grey if missing).
 */
function ensureColors(buffers) {
  if (buffers.colors) return;
  const vertCount = buffers.positions.length / 3;
  const colors = new Float32Array(vertCount * 3);
  colors.fill(0.6);
  buffers.colors = colors;
}

/**
 * Ensure buffer set has uvs (default zeros if missing).
 */
function ensureUvs(buffers) {
  if (buffers.uvs) return;
  const vertCount = buffers.positions.length / 3;
  buffers.uvs = new Float32Array(vertCount * 2);
}

/**
 * Compute vertex normals from indexed positions.
 */
function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia * 3] += nx; normals[ia * 3 + 1] += ny; normals[ia * 3 + 2] += nz;
    normals[ib * 3] += nx; normals[ib * 3 + 1] += ny; normals[ib * 3 + 2] += nz;
    normals[ic * 3] += nx; normals[ic * 3 + 1] += ny; normals[ic * 3 + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i] = x / len; normals[i + 1] = y / len; normals[i + 2] = z / len;
  }
  return normals;
}

/**
 * Create a quad (front + back face, 8 verts) for sign/billboard panels.
 */
function createQuadBuffers(verts, quadUvs, quadIdx) {
  const normals = computeVertexNormals(verts, quadIdx);
  return {
    positions: verts,
    normals,
    uvs: quadUvs,
    indices: new Uint32Array(quadIdx),
  };
}

/**
 * Create a flat plane in XZ plane (used for temple step tops).
 */
function createPlaneXZ(w, d, cx, y, cz) {
  const hw = w / 2, hd = d / 2;
  const positions = new Float32Array([
    cx - hw, y, cz - hd,
    cx + hw, y, cz - hd,
    cx + hw, y, cz + hd,
    cx - hw, y, cz + hd,
  ]);
  const normals = new Float32Array([
    0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, normals, uvs, indices };
}

/**
 * Create a circle disc oriented to face a given normal direction.
 * Used for AC fan circles.
 * @param {number} radius
 * @param {number} segments
 * @param {number} cx - center X
 * @param {number} cy - center Y
 * @param {number} cz - center Z
 * @param {number} nx - outward normal X (unit)
 * @param {number} nz - outward normal Z (unit)
 */
function createOrientedDisc(radius, segments, cx, cy, cz, nx, nz) {
  const disc = createCircle(radius, segments);
  // Default disc faces +Y. We need it facing (nx, 0, nz).
  // First rotate to face +Z (rotateX -PI/2), then rotateY to align with normal.
  applyRotationX(disc, -Math.PI / 2);
  const angle = Math.atan2(nx, nz);
  applyRotationY(disc, angle);
  applyTranslation(disc, cx, cy, cz);
  return disc;
}

// ────────────────────────────────────────────────────────────────────────────
// Column-major 4x4 instance matrix composition
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compose a column-major 4x4 matrix from position, quaternion, and scale.
 * @param {number} px - position X
 * @param {number} py - position Y
 * @param {number} pz - position Z
 * @param {number} qx - quaternion X
 * @param {number} qy - quaternion Y
 * @param {number} qz - quaternion Z
 * @param {number} qw - quaternion W
 * @param {number} sx - scale X
 * @param {number} sy - scale Y
 * @param {number} sz - scale Z
 * @param {Float32Array} out - 16-element output array
 * @param {number} offset - write offset into out
 */
function composeMatrix4(px, py, pz, qx, qy, qz, qw, sx, sy, sz, out, offset) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[offset + 0]  = (1 - (yy + zz)) * sx;
  out[offset + 1]  = (xy + wz) * sx;
  out[offset + 2]  = (xz - wy) * sx;
  out[offset + 3]  = 0;

  out[offset + 4]  = (xy - wz) * sy;
  out[offset + 5]  = (1 - (xx + zz)) * sy;
  out[offset + 6]  = (yz + wx) * sy;
  out[offset + 7]  = 0;

  out[offset + 8]  = (xz + wy) * sz;
  out[offset + 9]  = (yz - wx) * sz;
  out[offset + 10] = (1 - (xx + yy)) * sz;
  out[offset + 11] = 0;

  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/**
 * Convert Euler Y rotation (radians) to quaternion (x, y, z, w).
 */
function eulerYToQuaternion(angle) {
  const halfAngle = angle / 2;
  return { x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) };
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Process all buildings for a tile, producing raw typed-array geometry groups.
 *
 * @param {object} data - { buildings, roads, elevation, elevationOffset }
 * @param {object} config - { ELEVATION_VERTICAL_EXAGGERATION }
 * @returns {object} Result with buildingGroups, roofGroups, detailGroups, tankInstances, pipeInstances
 */
export function processBuildingsInWorker(data, config) {
  const { buildings, roads, elevation, elevationOffset, aoGrid } = data;
  if (!buildings || buildings.length === 0) {
    return { buildingGroups: [], roofGroups: [], detailGroups: [], tankInstances: null, pipeInstances: null };
  }
  const aoSvfAt = createWorkerAoSampler(elevation, aoGrid);   // null on pre-v9 tiles

  const vertExag = (config && config.ELEVATION_VERTICAL_EXAGGERATION != null &&
    Number.isFinite(config.ELEVATION_VERTICAL_EXAGGERATION))
    ? config.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // Create fast elevation lookup
  const fastElev = createFastElevation(elevation, elevationOffset || 0);

  // ── Accumulation maps ──

  // Facade walls: keyed by material key
  /** @type {Map<string, { geoms: object[], vertCount: number }>} */
  const byMaterial = new Map();

  // Roof caps: keyed by roof material key
  /** @type {Map<string, { geoms: object[], vertCount: number }>} */
  const roofByMaterial = new Map();

  // Detail geometry collections
  const balconySlabGeoms = [];
  const balconyRailGeoms = [];
  let balconySlabVerts = 0;
  let balconyRailVerts = 0;

  const acUnitGeoms = [];
  const acFanGeoms = [];
  const parapetGeoms = [];
  const barExtrudeGeoms = [];
  let commercialVerts = 0;

  const mallSignGeoms = [];
  const mallBillboardGeoms = [];
  let mallVerts = 0;

  const shikharaGeoms = [];
  const templeBaseGeoms = [];
  const templeBandGeoms = [];
  const flagPoleGeoms = [];
  const flagGeoms = [];
  let religiousVerts = 0;

  const boundaryWallGeoms = [];
  const gateGeoms = [];
  let boundaryVerts = 0;

  // Instance data
  const tankInstanceList = [];
  const pipeInstanceList = [];

  // Global vertex budget across ALL material groups (walls + roofs + details)
  let totalTileVerts = 0;
  const heroSpills = [];   // flat [x, baseY, z, radius, strength, ...] — building warm ground-glow decals
  const beaconPoints = []; // flat [x, y, z, ...] — pulsing red beacons (water-tower finials)
  const GLOBAL_VERTEX_BUDGET = 100000;

  // ── Main building loop ──

  for (const b of buildings) {
    // Skip underground structures
    if (b.layer != null && b.layer < 0) continue;

    // ── Anti-z-fight inset ──────────────────────────────────────────────────
    // Adjacent OSM buildings share EXACTLY coplanar walls (row houses share the lot line), which
    // z-fight/shimmer when both facades render. Pull every footprint inward by a tiny
    // per-building deterministic amount (1–4.5 cm — invisible at gameplay distances) so no two
    // buildings' walls are ever depth-coincident. Applied once, up front, so walls, roof, and all
    // later uses of the footprint stay mutually consistent.
    if (b.footprint && b.footprint.length >= 3 && !b._insetApplied) {
      b._insetApplied = true;
      const fpIn = b.footprint;
      let icx = 0, icy = 0;
      for (const p of fpIn) { icx += p.x; icy += p.y; }
      icx /= fpIn.length; icy /= fpIn.length;
      const inset = 0.01 + (deterministicIndex(b.id) % 8) * 0.005;
      b.footprint = fpIn.map((p) => {
        const dx = icx - p.x, dy = icy - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.5) return { ...p };                        // degenerate/tiny — leave
        const t = Math.min(inset, d * 0.2) / d;              // never collapse thin slivers
        return { ...p, x: p.x + dx * t, y: p.y + dy * t };
      });
    }

    let cx, cy;
    if (b.center != null) {
      cx = b.center.x;
      cy = b.center.y;
    } else {
      const footprint = b.footprint || [];
      const pts =
        footprint.length > 1 &&
        footprint[0].x === footprint[footprint.length - 1].x &&
        footprint[0].y === footprint[footprint.length - 1].y
          ? footprint.slice(0, -1)
          : footprint;
      if (pts.length === 0) continue;
      cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    }

    // Ground under a building isn't flat — a single centroid height leaves one end floating where the
    // terrain slopes away (the "touching the ground on one side" bug). Sample the whole FOOTPRINT and
    // take the LOWEST point, so the base sits on the lowest ground under the building; the higher side
    // buries harmlessly underground instead of floating. Flat ground → min == centroid → no change.
    let groundElev = fastElev(cx, cy);
    if (b.footprint && b.footprint.length >= 3) {
      for (let i = 0; i < b.footprint.length; i++) {
        const p = b.footprint[i];
        if (!p) continue;
        const e = fastElev(p.x, p.y);
        if (Number.isFinite(e) && e < groundElev) groundElev = e;
      }
    }
    let baseY = groundElev * vertExag + BUILDING_Z_OFFSET;

    let category = getBuildingCategory(b, roads, cx, cy);
    // (Height-based glass RETURNED 2026-07-11 by user call — ≥55m towers are commercial_glass with
    // the full-glass mosaic texture; the old "dark tower" failure was the saturated palette, since
    // replaced by near-white tints. See getBuildingCategory.)
    const isCommercial = (category === 'commercial' || category === 'commercial_glass');

    // ── WATER TOWER — bespoke Torre-de-les-Aigües silhouette (user ref 2026-07-11) ─────────────
    // Brick shaft → overhanging cream colonnade drum → terracotta conical spire. All vertex-
    // coloured into the map-less ROOF bucket (window textures would smear on a cylinder shaft).
    // Triggers: the water_tower type (man_made/building tag — only 2 in the whole bake), OR the
    // shape heuristic: tall, thin, tower-proportioned generic/industrial building (Barceloneta's
    // beach towers are untagged `generic` in OSM — measured). Churches keep their bell towers.
    let _wtFpR = 0;
    if (b.footprint?.length >= 3) {
      for (const p of b.footprint) _wtFpR = Math.max(_wtFpR, Math.hypot(p.x - cx, p.y - cy));
    }
    const _wtByShape = (b.type === 'generic' || b.type === 'industrial' || b.type == null)
      && _wtFpR > 0 && _wtFpR <= 5.5
      && Number.isFinite(b.height) && b.height >= 16 && b.height / (2 * _wtFpR) >= 2;
    if ((b.type === 'water_tower' || _wtByShape) && b.footprint?.length >= 3) {
      const wtR = Math.max(2.2, Math.min(_wtFpR, 6));
      const WT_H = Math.max(18, Math.min(Number.isFinite(b.height) && b.height >= 12 ? b.height : 30, 45));
      const SEGS = 12;
      const BRICK = srgbHexToLinear(0x8F5A42), CREAM = srgbHexToLinear(0xD9CDB4);
      const TRIM = srgbHexToLinear(0x6B4A38), TERRA = srgbHexToLinear(0x91503A);
      const parts = [];
      const put = (geom, tint) => { applyVertexColorToBuffers(geom, tint); parts.push(geom); };
      const shaftH = WT_H * 0.64;
      const shaft = createCylinderFull(wtR * 0.80, wtR * 0.95, shaftH, SEGS);
      applyTranslation(shaft, cx, baseY + shaftH / 2, cy); put(shaft, BRICK);
      const trimBand = createCylinderFull(wtR * 1.30, wtR * 1.30, 0.6, SEGS);   // dark ring under the drum
      applyTranslation(trimBand, cx, baseY + shaftH + 0.3, cy); put(trimBand, TRIM);
      const crownH = WT_H * 0.20;
      const crown = createCylinderFull(wtR * 1.26, wtR * 1.26, crownH, SEGS);   // overhanging colonnade drum
      applyTranslation(crown, cx, baseY + shaftH + 0.6 + crownH / 2, cy); put(crown, CREAM);
      const spireH = WT_H * 0.17;                                               // squat cone (0.26 was "too pointy" — user)
      const spire = createCylinderFull(wtR * 0.30, wtR * 1.16, spireH, SEGS);   // truncated conical cap
      applyTranslation(spire, cx, baseY + shaftH + 0.6 + crownH + spireH / 2, cy); put(spire, TERRA);
      const finial = createCylinderFull(wtR * 0.10, wtR * 0.26, WT_H * 0.05, SEGS);  // small blunt finial
      applyTranslation(finial, cx, baseY + shaftH + 0.6 + crownH + spireH + WT_H * 0.025, cy); put(finial, TRIM);
      beaconPoints.push(cx, baseY + shaftH + 0.6 + crownH + spireH + WT_H * 0.05 + 0.35, cy);  // pulsing red beacon
      const wtMerged = mergeBufferSets(parts);
      if (wtMerged) {
        ensureUvs(wtMerged);
        const wtVerts = wtMerged.positions.length / 3;
        if (totalTileVerts + wtVerts <= GLOBAL_VERTEX_BUDGET) {
          const roofKey = getRoofMaterialKey();
          if (!roofByMaterial.has(roofKey)) roofByMaterial.set(roofKey, { geoms: [], vertCount: 0 });
          const rEntry = roofByMaterial.get(roofKey);
          rEntry.geoms.push(wtMerged);
          rEntry.vertCount += wtVerts;
          totalTileVerts += wtVerts;
        }
      }
      continue;   // bespoke silhouette replaces the standard wall/roof path entirely
    }

    // ── Residential setback ── Barcelona: OFF (Eixample blocks front the pavement, no driveway).
    let originalFootprint = null;
    const RESIDENTIAL_SETBACK = 3.0;
    if (ENABLE_DELHI_DETAILS && category === 'residential' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 6) {
      const fp = b.footprint;
      const nearest = findNearestRoadSegment(roads, cx, cy);
      if (nearest && nearest.distance < 25) {
        let bestEi = -1, bestDist = Infinity;
        for (let ei = 0; ei < fp.length; ei++) {
          const pp0 = fp[ei], pp1 = fp[(ei + 1) % fp.length];
          const emx = (pp0.x + pp1.x) / 2, emz = (pp0.y + pp1.y) / 2;
          const elen = Math.hypot(pp1.x - pp0.x, pp1.y - pp0.y);
          if (elen < 3) continue;
          const roadPts = nearest.road.points || [];
          let minDSq = Infinity;
          for (let ri = 0; ri < roadPts.length - 1; ri++) {
            const ra = roadPts[ri], rb = roadPts[ri + 1];
            const rdx = rb.x - ra.x, rdz = rb.y - ra.y;
            const rlenSq = rdx * rdx + rdz * rdz;
            let t = rlenSq > 0 ? ((emx - ra.x) * rdx + (emz - ra.y) * rdz) / rlenSq : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ra.x + t * rdx, qz = ra.y + t * rdz;
            const dSq = (emx - qx) ** 2 + (emz - qz) ** 2;
            if (dSq < minDSq) minDSq = dSq;
          }
          if (minDSq < bestDist) { bestDist = minDSq; bestEi = ei; }
        }
        if (bestEi >= 0 && bestDist < 20 * 20) {
          const pp0 = fp[bestEi], pp1 = fp[(bestEi + 1) % fp.length];
          const edx2 = pp1.x - pp0.x, edz2 = pp1.y - pp0.y;
          const elen2 = Math.hypot(edx2, edz2);
          let fnx = -edz2 / elen2, fnz = edx2 / elen2;
          let fcx3 = 0, fcz3 = 0;
          for (const p of fp) { fcx3 += p.x; fcz3 += p.y; }
          fcx3 /= fp.length; fcz3 /= fp.length;
          const emx2 = (pp0.x + pp1.x) / 2, emz2 = (pp0.y + pp1.y) / 2;
          if ((emx2 - fcx3) * fnx + (emz2 - fcz3) * fnz < 0) { fnx = -fnx; fnz = -fnz; }
          originalFootprint = fp.map(p => ({ x: p.x, y: p.y }));
          const i0 = bestEi, i1 = (bestEi + 1) % fp.length;
          fp[i0] = { x: fp[i0].x - fnx * RESIDENTIAL_SETBACK, y: fp[i0].y - fnz * RESIDENTIAL_SETBACK };
          fp[i1] = { x: fp[i1].x - fnx * RESIDENTIAL_SETBACK, y: fp[i1].y - fnz * RESIDENTIAL_SETBACK };
        }
      }
    }

    // ── Wall geometry ──
    // Bullet crown (Agbar look) for a deterministic THIRD of tall glass towers, and any round-
    // footprint glass tower — the rest stay rectangular slabs (user: "some curved, some proper
    // rectangles"). The revolve converges at the top, so these skip the flat roof below.
    const isBulletTower = category === 'commercial_glass' && b.height >= 60 && b.footprint?.length >= 3
      && (b.shapeType === 'cylinder' || deterministicIndex(b.id) % 3 === 0);
    let wallBuffers = null;
    if (isBulletTower) {
      wallBuffers = createBulletTowerBuffers(b, baseY, cx, cy);
    } else if (b.shapeType === 'cylinder') {
      wallBuffers = createCylinderWallBuffers(b, baseY);
    } else {
      wallBuffers = createPolygonWallBuffers(b, baseY);
    }

    if (!wallBuffers) {
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }

    // Apply tint
    const tint = getFacadeTint(b, category);
    applyVertexColorToBuffers(wallBuffers, tint);
    ensureUvs(wallBuffers);

    // Ground-glow wash factor: 1 at the building base fading to 0 by ~7 m up. The facade shader
    // multiplies this by a night-only uniform so lower floors pick up a warm street-light wash
    // (the reference-render look) — zero cost by day.
    {
      const wp = wallBuffers.positions;
      const wn = wallBuffers.normals;
      const wc = wp.length / 3;
      const wash = new Float32Array(wc);
      const ao = aoSvfAt ? new Float32Array(wc) : null;
      for (let wi = 0; wi < wc; wi++) {
        const rel = (wp[wi * 3 + 1] - baseY) / 4.5;   // ground floor + a bit — not half the building
        wash[wi] = rel <= 0 ? 1 : rel >= 1 ? 0 : 1 - rel;
        if (ao) {
          // Baked sky-AO darkening: sample the street beside the wall (outset along the facade
          // normal — the cell under the wall averages in the svf≈0 building interior), fade out
          // with height so canyon floors darken but upper storeys stay sky-lit.
          const fade = 1 - (wp[wi * 3 + 1] - baseY) / AO_FACADE_FADE_M;
          if (fade > 0) {
            const svf = aoSvfAt(
              wp[wi * 3] + (wn ? wn[wi * 3] * AO_SAMPLE_OUTSET : 0),
              wp[wi * 3 + 2] + (wn ? wn[wi * 3 + 2] * AO_SAMPLE_OUTSET : 0),
            );
            const d = AO_FACADE_STRENGTH * Math.pow(1 - svf, AO_GAMMA) * Math.min(1, fade);
            if (Number.isFinite(d)) ao[wi] = d;   // NaN positions must not reach the shader
          }
        }
      }
      wallBuffers.wash = wash;
      if (ao) wallBuffers.ao = ao;
    }

    const matKey = getFacadeMaterialKey(category, b.id, b.height);
    const vertCount = wallBuffers.positions.length / 3;

    // Global budget check — skip entire building if it would exceed tile limit
    if (totalTileVerts + vertCount > GLOBAL_VERTEX_BUDGET) {
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }

    if (!byMaterial.has(matKey)) {
      byMaterial.set(matKey, { geoms: [], vertCount: 0 });
    }
    const entry = byMaterial.get(matKey);
    entry.geoms.push(wallBuffers);
    entry.vertCount += vertCount;
    totalTileVerts += vertCount;

    // HERO buildings emit a warm ground-spill decal (rendered at night only) — the reference
    // renders' "glowing tower lights its surroundings". Hero-only: an every-building version was
    // tried and looked wrong — flat discs clip visibly on sloped/stepped streets, and at low
    // strength they read as pale ghost circles. [x, baseY, z, radius, strength]
    if (matKey.includes('#hero') && b.footprint?.length >= 3) {
      let maxR = 0;
      for (const p of b.footprint) {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d > maxR) maxR = d;
      }
      heroSpills.push(cx, baseY, cy, Math.min(34, Math.max(14, maxR * 1.7)), 1.0);
    }

    // ── Roof cap ── (bullet towers close their own crown — a flat roof would float above it)
    let roofBuffers = isBulletTower
      ? null
      : (b.shapeType === 'cylinder'
        ? createCylinderRoofBuffers(b, baseY)
        : createPolygonRoofBuffers(b, baseY));

    const setbackFootprint = originalFootprint ? b.footprint.map(p => ({ x: p.x, y: p.y })) : null;

    if (originalFootprint) {
      b.footprint = originalFootprint;
    }

    if (roofBuffers) {
      const roofTint = getRoofTint(category, b.id, b.height);
      applyVertexColorToBuffers(roofBuffers, roofTint);
      ensureUvs(roofBuffers);

      const roofKey = getRoofMaterialKey(category, b.id, b.height);
      const rc = roofBuffers.positions.length / 3;
      if (!roofByMaterial.has(roofKey)) {
        roofByMaterial.set(roofKey, { geoms: [], vertCount: 0 });
      }
      const rEntry = roofByMaterial.get(roofKey);
      if (totalTileVerts + rc <= GLOBAL_VERTEX_BUDGET) {
        rEntry.geoms.push(roofBuffers);
        rEntry.vertCount += rc;
        totalTileVerts += rc;
      }
    }

    // ── Water tank positions ── Barcelona: removed (Delhi rooftop tanks).
    if (ENABLE_DELHI_DETAILS && b.height > 6 && b.footprint?.length >= 3) {
      const fp = b.footprint;
      let fmnX = Infinity, fmxX = -Infinity, fmnZ = Infinity, fmxZ = -Infinity;
      for (const p of fp) {
        if (p.x < fmnX) fmnX = p.x; if (p.x > fmxX) fmxX = p.x;
        if (p.y < fmnZ) fmnZ = p.y; if (p.y > fmxZ) fmxZ = p.y;
      }
      const roofY = baseY + b.height + ROOF_Y_OFFSET;
      const roofW = fmxX - fmnX, roofD = fmxZ - fmnZ;
      const groupCount = 1 + deterministicIndex(b.id + 13) % 2;
      const padX = roofW * 0.25, padZ = roofD * 0.25;
      for (let gi = 0; gi < groupCount; gi++) {
        const gcx = fmnX + padX + (deterministicIndex(b.id * 5 + gi) % 100) / 100 * (roofW - 2 * padX);
        const gcz = fmnZ + padZ + (deterministicIndex(b.id * 5 + gi + 99) % 100) / 100 * (roofD - 2 * padZ);
        if (!pointInFootprint(gcx, gcz, fp)) continue;
        const tanksInGroup = 2 + deterministicIndex(b.id * 7 + gi + 30) % 3;
        for (let ti = 0; ti < tanksInGroup; ti++) {
          const angle = (ti / tanksInGroup) * Math.PI * 2 + deterministicIndex(b.id + ti + gi) * 0.3;
          const dist = 0.8 + (deterministicIndex(b.id * 3 + ti + gi * 10) % 60) / 100;
          const tx = gcx + Math.cos(angle) * dist;
          const tz = gcz + Math.sin(angle) * dist;
          if (!pointInFootprint(tx, tz, fp)) continue;
          const s = 0.55 + (deterministicIndex(b.id * 11 + ti + gi * 7 + 41) % 55) / 100;
          tankInstanceList.push({ x: tx, y: roofY, z: tz, scale: s });
        }
      }
    }

    // ── Pipe positions ──
    if (b.height > 4 && b.footprint?.length >= 3 && deterministicIndex(b.id + 21) % 100 < 35) {
      const fp = b.footprint;
      const edgeIdx = deterministicIndex(b.id + 33) % Math.max(1, fp.length - 1);
      const p0 = fp[edgeIdx], p1 = fp[(edgeIdx + 1) % fp.length];
      const edx = p1.x - p0.x, edz = p1.y - p0.y;
      const elen = Math.hypot(edx, edz);
      if (elen > 0.5) {
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        const nx = -edz / elen, nz = edx / elen;
        const toCx = cx - mx, toCz = cy - mz;
        const pipSign = (toCx * nx + toCz * nz) < 0 ? 1 : -1;
        const pipeR = 0.05 + (deterministicIndex(b.id + 55) % 30) / 1000;
        pipeInstanceList.push({
          x: mx + nx * 0.12 * pipSign,
          y: baseY,
          z: mz + nz * 0.12 * pipSign,
          height: b.height,
          radius: pipeR,
        });
      }
    }

    // ── Masonry 3D balconies (Barcelona Eixample — residential/commercial/office) ──
    if (BALCONY_CATEGORIES.has(category) && b.shapeType !== 'cylinder'
        && b.height >= 6 && b.footprint?.length >= 3
        && balconySlabVerts < BALCONY_VERT_CAP) {
      const fp = setbackFootprint || b.footprint;
      const floorH = 3.0;
      const numFloors = Math.floor(b.height / floorH);
      const SLAB_DEPTH = 0.9;
      const SLAB_THICK = 0.25;
      const RAIL_H = 0.85;
      const RAIL_BAR_W = 0.04;
      const RAIL_BAR_SPACING = 0.25;
      const FLOOR_BAND_H = 0.12;
      const FLOOR_BAND_DEPTH = 0.06;

      let fcx = 0, fcz = 0;
      for (const p of fp) { fcx += p.x; fcz += p.y; }
      fcx /= fp.length; fcz /= fp.length;

      for (let ei = 0; ei < fp.length; ei++) {
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 2.0) continue;

        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - fcx) * nx + (mz - fcz) * nz < 0) { nx = -nx; nz = -nz; }

        // ── Cornice: projecting roofline lip (the uniform Eixample skyline) ──
        if (balconySlabVerts < BALCONY_VERT_CAP) {
          const CORNICE_D = 0.4, CORNICE_H = 0.5;
          balconySlabGeoms.push(makeBoxGeom(p0.x, p0.y, p1.x, p1.y, nx, nz, CORNICE_D, baseY + b.height - CORNICE_H, CORNICE_H));
          balconySlabVerts += 8;
        }

        const edgeHash = deterministicIndex(b.id * 31 + ei * 7);
        const edgeHasBalconies = (edgeHash % 100) < 55;

        const SLOT_W = 2.5;
        const SLOT_GAP = 0.4;
        const SLOT_INSET = 0.5;
        const availLen = edgeLen - SLOT_INSET * 2;
        if (availLen < SLOT_W) continue;
        const numSlots = Math.max(1, Math.floor(availLen / (SLOT_W + SLOT_GAP)));
        const actualSpacing = availLen / numSlots;
        const slotStart = SLOT_INSET;

        for (let fi = 1; fi < numFloors; fi++) {
          const floorY = baseY + fi * floorH;
          if (balconySlabVerts >= BALCONY_VERT_CAP) break;

          // Floor band
          balconySlabGeoms.push(makeBoxGeom(p0.x, p0.y, p1.x, p1.y, nx, nz, FLOOR_BAND_DEPTH, floorY - FLOOR_BAND_H, FLOOR_BAND_H));
          balconySlabVerts += 8;

          if (!edgeHasBalconies) continue;

          for (let si2 = 0; si2 < numSlots; si2++) {
            if (balconySlabVerts >= BALCONY_VERT_CAP) break;
            const slotHash = deterministicIndex(b.id * 17 + ei * 113 + fi * 53 + si2 * 7);
            if ((slotHash % 100) >= 55) continue;

            const slotT0 = (slotStart + si2 * actualSpacing) / edgeLen;
            const slotT1 = (slotStart + si2 * actualSpacing + SLOT_W) / edgeLen;
            const sx0 = p0.x + edx * slotT0, sz0 = p0.y + edz * slotT0;
            const sx1 = p0.x + edx * slotT1, sz1 = p0.y + edz * slotT1;

            const SLAB_INSET = 0.15;
            const ix0 = sx0 - nx * SLAB_INSET, iz0 = sz0 - nz * SLAB_INSET;
            const ix1 = sx1 - nx * SLAB_INSET, iz1 = sz1 - nz * SLAB_INSET;
            balconySlabGeoms.push(makeBoxGeom(ix0, iz0, ix1, iz1, nx, nz, SLAB_DEPTH + SLAB_INSET, floorY, SLAB_THICK));
            balconySlabVerts += 8;

            // Railing
            const railBaseY = floorY + SLAB_THICK;
            const d = SLAB_DEPTH;
            const hw = RAIL_BAR_W * 1.5;
            // Front railing panel
            balconyRailGeoms.push(makeBoxGeom(sx0 + nx * d, sz0 + nz * d, sx1 + nx * d, sz1 + nz * d, nx, nz, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;
            // Left side return
            balconyRailGeoms.push(makeBoxGeom(sx0, sz0, sx0 + nx * d, sz0 + nz * d, -ex, -ez, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;
            // Right side return
            balconyRailGeoms.push(makeBoxGeom(sx1 + nx * d, sz1 + nz * d, sx1, sz1, ex, ez, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;

            // Vertical bars
            const slotLen = Math.hypot(sx1 - sx0, sz1 - sz0);
            const numBars = Math.max(2, Math.floor(slotLen / RAIL_BAR_SPACING));
            for (let bi = 0; bi <= numBars; bi++) {
              if (balconyRailVerts >= BALCONY_VERT_CAP) break;
              const bt = bi / numBars;
              const bpx = sx0 + (sx1 - sx0) * bt + nx * d;
              const bpz = sz0 + (sz1 - sz0) * bt + nz * d;
              const bhw = RAIL_BAR_W / 2;
              // Flat quad per baluster (2 tris) instead of a solid box (12 tris) — 6x fewer triangles on a
              // major building sink; thin bars read identically face-on and details render DoubleSide.
              balconyRailGeoms.push(makeQuadGeom(bpx - ex * bhw, bpz - ez * bhw, bpx + ex * bhw, bpz + ez * bhw, nx, nz, railBaseY, RAIL_H));
              balconyRailVerts += 4;
            }
          }
        }
      }
    }

    // ── Commercial 3D details ──
    // !isBulletTower: parapets/bars trace the RECTANGULAR footprint at full height — on a bullet
    // tower the crown has converged inward there, leaving the frames floating in the air.
    if (isCommercial && b.shapeType !== 'cylinder' && !isBulletTower
        && b.footprint?.length >= 3 && b.height >= 5
        && commercialVerts < COMMERCIAL_VERT_CAP) {
      const fp = b.footprint;
      const floorH = 3.0;
      const numFloors = Math.floor(b.height / floorH);

      let ccx = 0, ccz = 0;
      for (const p of fp) { ccx += p.x; ccz += p.y; }
      ccx /= fp.length; ccz /= fp.length;

      for (let ei = 0; ei < fp.length; ei++) {
        if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 2.5) continue;

        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - ccx) * nx + (mz - ccz) * nz < 0) { nx = -nx; nz = -nz; }

        const edgeHash = deterministicIndex(b.id * 31 + ei * 13);

        // v3 P0-16: Delhi-era ground-floor pillars / shop awnings / signboard panels DELETED.
        // They intersected the Barcelona shopfront, awning and shop-sign renderers on exactly the
        // arterial buildings the player drives past. The Barcelona versions live in
        // map/shopfrontRenderer.js, map/awningRenderer.js and map/shopSignRenderer.js.

        // AC outdoor units ── Barcelona: removed (Delhi facade clutter).
        if (ENABLE_DELHI_DETAILS && edgeLen >= 3) {
          const AC_W = 0.7, AC_H = 0.5, AC_D = 0.3;
          const AC_OFFSET = 0.15;
          const AC_SPACING = 2.2;
          const maxACs = Math.floor((edgeLen - 1.0) / AC_SPACING);
          for (let fi = 1; fi < numFloors; fi++) {
            if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
            const floorHash = deterministicIndex(b.id * 7 + ei * 53 + fi * 11);
            if ((floorHash % 100) >= 60) continue;
            const numAC = Math.max(1, Math.min(maxACs, 1 + (floorHash % Math.max(1, maxACs))));
            const startT = 0.1;
            const endT = 0.9;
            for (let ai = 0; ai < numAC; ai++) {
              if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
              const acSlotHash = deterministicIndex(b.id * 13 + ei * 37 + fi * 19 + ai * 7);
              if ((acSlotHash % 100) >= 70) continue;
              const t = numAC === 1
                ? 0.5
                : startT + (endT - startT) * (ai / (numAC - 1));
              const acx = p0.x + edx * t;
              const acz = p0.y + edz * t;
              const acY = baseY + fi * floorH + 0.3 + (acSlotHash % 30) / 100;
              const ox = acx + nx * AC_OFFSET;
              const oz = acz + nz * AC_OFFSET;
              acUnitGeoms.push(makeBoxGeom(
                ox - ex * AC_W / 2, oz - ez * AC_W / 2,
                ox + ex * AC_W / 2, oz + ez * AC_W / 2,
                nx, nz, AC_D, acY, AC_H
              ));
              commercialVerts += 8;

              // AC fan disc on front face
              const fanR = Math.min(AC_W, AC_H) * 0.35;
              const fanCx = ox + nx * (AC_D + 0.01);
              const fanCz = oz + nz * (AC_D + 0.01);
              const fanCy = acY + AC_H * 0.5;
              acFanGeoms.push(createOrientedDisc(fanR, 10, fanCx, fanCy, fanCz, nx, nz));
              commercialVerts += 12;
            }
          }
        }

        // Parapet wall
        if (b.height >= 6) {
          const PARAPET_H = 0.5;
          const PARAPET_D = 0.15;
          parapetGeoms.push(makeBoxGeom(
            p0.x, p0.y, p1.x, p1.y,
            nx, nz, PARAPET_D, baseY + b.height, PARAPET_H
          ));
          commercialVerts += 8;
        }

        // Decorative bar extrusions
        if (edgeLen >= 4 && numFloors >= 2) {
          const BAR_H = 0.15;
          const BAR_D = 0.2;
          const BAR_OFFSET = 0.02;
          const numBarsDeco = 1 + (edgeHash % 3);
          for (let bi = 0; bi < numBarsDeco; bi++) {
            if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
            const barHash = deterministicIndex(b.id * 23 + ei * 41 + bi * 67);
            const barFloor = 1 + (barHash % Math.max(1, numFloors - 1));
            const barY = baseY + barFloor * floorH - 0.1;
            const barStartT = (barHash % 20) / 100;
            const barEndT = 0.8 + (barHash % 20) / 100;
            barExtrudeGeoms.push(makeBoxGeom(
              p0.x + edx * barStartT + nx * BAR_OFFSET,
              p0.y + edz * barStartT + nz * BAR_OFFSET,
              p0.x + edx * barEndT + nx * BAR_OFFSET,
              p0.y + edz * barEndT + nz * BAR_OFFSET,
              nx, nz, BAR_D, barY, BAR_H
            ));
            commercialVerts += 8;
          }
        }
      }
    }

    // ── Mall billboard + sign ── Barcelona: removed (Delhi ad panels).
    const isMallType = (b.type === 'shop' || b.type === 'mall' || b.type === 'retail');
    if (ENABLE_DELHI_DETAILS && isMallType && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 6
        && mallVerts < MALL_VERT_CAP) {
      const fp = b.footprint;

      let mcx = 0, mcz = 0;
      for (const p of fp) { mcx += p.x; mcz += p.y; }
      mcx /= fp.length; mcz /= fp.length;

      const edges = [];
      for (let ei = 0; ei < fp.length; ei++) {
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 3) continue;
        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        const mmx = (p0.x + p1.x) / 2, mmz = (p0.y + p1.y) / 2;
        if ((mmx - mcx) * nx + (mmz - mcz) * nz < 0) { nx = -nx; nz = -nz; }
        edges.push({ p0, p1, edx, edz, edgeLen, ex, ez, nx, nz, ei });
      }
      edges.sort((a, b2) => b2.edgeLen - a.edgeLen);

      // "SHOPPING MALL" sign on longest edge
      if (edges.length > 0) {
        const e = edges[0];
        const SIGN_H = 1.5;
        const SIGN_D = 0.08;
        const signY = baseY + b.height - SIGN_H - 0.3;
        const signW = Math.min(e.edgeLen * 0.7, 12);
        const halfW = signW / 2;
        const emx = (e.p0.x + e.p1.x) / 2, emz = (e.p0.y + e.p1.y) / 2;
        const s0x = emx - e.ex * halfW + e.nx * SIGN_D;
        const s0z = emz - e.ez * halfW + e.nz * SIGN_D;
        const s1x = emx + e.ex * halfW + e.nx * SIGN_D;
        const s1z = emz + e.ez * halfW + e.nz * SIGN_D;
        const signVerts = new Float32Array([
          s0x, signY, s0z,
          s1x, signY, s1z,
          s1x, signY + SIGN_H, s1z,
          s0x, signY + SIGN_H, s0z,
          s1x, signY, s1z,
          s0x, signY, s0z,
          s0x, signY + SIGN_H, s0z,
          s1x, signY + SIGN_H, s1z,
        ]);
        const signUvs = new Float32Array([
          0, 0, 1, 0, 1, 1, 0, 1,
          0, 0, 1, 0, 1, 1, 0, 1,
        ]);
        const signIdx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
        mallSignGeoms.push(createQuadBuffers(signVerts, signUvs, signIdx));
        mallVerts += 8;
      }

      // Billboard ad panels
      const maxBillboards = Math.min(3, edges.length - 1);
      for (let bi = 0; bi < maxBillboards; bi++) {
        if (mallVerts >= MALL_VERT_CAP) break;
        const e = edges[1 + bi];
        if (!e || e.edgeLen < 5) continue;
        const BB_H = 2.5;
        const BB_D = 0.1;
        const bbFloor = 1 + deterministicIndex(b.id * 11 + bi * 37) % Math.max(1, Math.floor(b.height / 3) - 1);
        const bbY = baseY + bbFloor * 3;
        if (bbY + BB_H > baseY + b.height - 2) continue;
        const bbW = Math.min(e.edgeLen * 0.6, 8);
        const halfBB = bbW / 2;
        const emx = (e.p0.x + e.p1.x) / 2, emz = (e.p0.y + e.p1.y) / 2;
        const b0x = emx - e.ex * halfBB + e.nx * BB_D;
        const b0z = emz - e.ez * halfBB + e.nz * BB_D;
        const b1x = emx + e.ex * halfBB + e.nx * BB_D;
        const b1z = emz + e.ez * halfBB + e.nz * BB_D;
        const bbVerts = new Float32Array([
          b0x, bbY, b0z,
          b1x, bbY, b1z,
          b1x, bbY + BB_H, b1z,
          b0x, bbY + BB_H, b0z,
          b1x, bbY, b1z,
          b0x, bbY, b0z,
          b0x, bbY + BB_H, b0z,
          b1x, bbY + BB_H, b1z,
        ]);
        const bbUvs = new Float32Array([
          0, 0, 1, 0, 1, 1, 0, 1,
          0, 0, 1, 0, 1, 1, 0, 1,
        ]);
        const bbIdx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
        const bbBufs = createQuadBuffers(bbVerts, bbUvs, bbIdx);
        bbBufs.billboardSeed = deterministicIndex(b.id * 7 + bi * 31);
        mallBillboardGeoms.push(bbBufs);
        mallVerts += 8;
      }
    }

    // ── Religious (Hindu temple) 3D details ── Barcelona: removed (replaced by church below).
    if (ENABLE_DELHI_DETAILS && category === 'religious' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 4
        && religiousVerts < RELIGIOUS_VERT_CAP) {
      const fp = b.footprint;
      const roofY = baseY + b.height;

      let tmnX = Infinity, tmxX = -Infinity, tmnZ = Infinity, tmxZ = -Infinity;
      let tcx = 0, tcz = 0;
      for (const p of fp) {
        if (p.x < tmnX) tmnX = p.x; if (p.x > tmxX) tmxX = p.x;
        if (p.y < tmnZ) tmnZ = p.y; if (p.y > tmxZ) tmxZ = p.y;
        tcx += p.x; tcz += p.y;
      }
      tcx /= fp.length; tcz /= fp.length;
      const bboxW = tmxX - tmnX, bboxD = tmxZ - tmnZ;
      const minDim = Math.min(bboxW, bboxD);

      // Shikhara (tiered cones)
      const shikharaR = Math.min(minDim * 0.35, 3.0);
      const shikharaH = Math.max(b.height * 0.6, 4);
      const SHIKHARA_SEGS = 8;
      const tiers = 3;
      for (let ti = 0; ti < tiers; ti++) {
        const tFrac = ti / tiers;
        const tFracNext = (ti + 1) / tiers;
        const rBot = shikharaR * (1 - tFrac * 0.7);
        const rTop = shikharaR * (1 - tFracNext * 0.7);
        const tierH = shikharaH / tiers;
        const tierY = roofY + ti * tierH;
        const tier = createCylinderFull(rTop, rBot, tierH, SHIKHARA_SEGS);
        applyTranslation(tier, tcx, tierY + tierH / 2, tcz);
        shikharaGeoms.push(tier);
        religiousVerts += SHIKHARA_SEGS * 4;
      }

      // Amalaka disc (torus)
      const amalakaR = shikharaR * 0.4;
      const amalaka = createTorus(amalakaR, amalakaR * 0.25, 6, SHIKHARA_SEGS);
      applyTranslation(amalaka, tcx, roofY + shikharaH + 0.1, tcz);
      shikharaGeoms.push(amalaka);
      religiousVerts += 50;

      // Kalasha (finial sphere)
      const kalasha = createSphere(amalakaR * 0.5, 6, 4);
      applyTranslation(kalasha, tcx, roofY + shikharaH + amalakaR * 0.5 + 0.2, tcz);
      shikharaGeoms.push(kalasha);
      religiousVerts += 30;

      // Corner mini-shikharas
      if (minDim > 6) {
        const cornerR = shikharaR * 0.35;
        const cornerH = shikharaH * 0.5;
        const corners = [
          { x: tmnX + bboxW * 0.15, z: tmnZ + bboxD * 0.15 },
          { x: tmxX - bboxW * 0.15, z: tmnZ + bboxD * 0.15 },
          { x: tmnX + bboxW * 0.15, z: tmxZ - bboxD * 0.15 },
          { x: tmxX - bboxW * 0.15, z: tmxZ - bboxD * 0.15 },
        ];
        const maxCorners = Math.min(4, 1 + deterministicIndex(b.id + 77) % 4);
        for (let ci = 0; ci < maxCorners; ci++) {
          if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
          if (!pointInFootprint(corners[ci].x, corners[ci].z, fp)) continue;
          const cc = createCylinderFull(cornerR * 0.3, cornerR, cornerH, 6);
          applyTranslation(cc, corners[ci].x, roofY + cornerH / 2, corners[ci].z);
          shikharaGeoms.push(cc);
          religiousVerts += 30;
          // Small kalasha on top
          const ck = createSphere(cornerR * 0.3, 5, 3);
          applyTranslation(ck, corners[ci].x, roofY + cornerH + cornerR * 0.3, corners[ci].z);
          shikharaGeoms.push(ck);
          religiousVerts += 20;
        }
      }

      // Stepped plinth/base
      const STEP_H = 0.3;
      const STEP_OUT = 0.5;
      for (let si = 0; si < 2; si++) {
        if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
        const stepY = baseY - (si + 1) * STEP_H;
        const expand = (si + 1) * STEP_OUT;
        const sx0 = tmnX - expand, sx1 = tmxX + expand;
        const sz0 = tmnZ - expand, sz1 = tmxZ + expand;
        // 4 walls of step
        templeBaseGeoms.push(makeBoxGeom(sx0, sz0, sx1, sz0, 0, 0, 0.01, stepY, STEP_H));
        templeBaseGeoms.push(makeBoxGeom(sx0, sz1, sx1, sz1, 0, 0, -0.01, stepY, STEP_H));
        templeBaseGeoms.push(makeBoxGeom(sx0, sz0, sx0, sz1, 0, 0, 0.01, stepY, STEP_H));
        templeBaseGeoms.push(makeBoxGeom(sx1, sz0, sx1, sz1, 0, 0, -0.01, stepY, STEP_H));
        // Top surface
        templeBaseGeoms.push(createPlaneXZ(sx1 - sx0, sz1 - sz0, (sx0 + sx1) / 2, stepY + STEP_H, (sz0 + sz1) / 2));
        religiousVerts += 36;
      }

      // Ornamental bands
      const templeFloorH = 3.0;
      const templeNumFloors = Math.floor(b.height / templeFloorH);
      let bfcx = 0, bfcz = 0;
      for (const p of fp) { bfcx += p.x; bfcz += p.y; }
      bfcx /= fp.length; bfcz /= fp.length;
      for (let ei = 0; ei < fp.length; ei++) {
        if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 1.5) continue;
        let bnx = -edz / edgeLen, bnz = edx / edgeLen;
        const bmx = (p0.x + p1.x) / 2, bmz = (p0.y + p1.y) / 2;
        if ((bmx - bfcx) * bnx + (bmz - bfcz) * bnz < 0) { bnx = -bnx; bnz = -bnz; }

        for (let fi = 1; fi <= templeNumFloors; fi++) {
          if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
          const bandY = baseY + fi * templeFloorH - 0.2;
          const BAND_H = 0.2;
          const BAND_D = 0.15;
          templeBandGeoms.push(makeBoxGeom(
            p0.x + bnx * 0.01, p0.y + bnz * 0.01,
            p1.x + bnx * 0.01, p1.y + bnz * 0.01,
            bnx, bnz, BAND_D, bandY, BAND_H
          ));
          religiousVerts += 8;
        }
      }

      // Flag pole
      const flagPoleH = 2.0;
      const poleR = 0.04;
      const poleBaseY = roofY + shikharaH + amalakaR * 0.5 + 0.2;
      const pole = createCylinderFull(poleR, poleR, flagPoleH, 4);
      applyTranslation(pole, tcx, poleBaseY + flagPoleH / 2, tcz);
      flagPoleGeoms.push(pole);
      religiousVerts += 12;

      // Triangular flag
      const FLAG_W = 1.2;
      const FLAG_H = 0.8;
      const flagTopY = poleBaseY + flagPoleH;
      const flagVerts = new Float32Array([
        tcx, flagTopY, tcz,
        tcx + FLAG_W, flagTopY - FLAG_H * 0.5, tcz,
        tcx, flagTopY - FLAG_H, tcz,
        tcx, flagTopY, tcz,
        tcx, flagTopY - FLAG_H, tcz,
        tcx + FLAG_W, flagTopY - FLAG_H * 0.5, tcz,
      ]);
      const flagNormals = computeVertexNormals(flagVerts, [0, 1, 2, 3, 4, 5]);
      flagGeoms.push({
        positions: flagVerts,
        normals: flagNormals,
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      });
      religiousVerts += 6;
    }

    // ── Barcelona CHURCH: bell tower + belfry + spire + pinnacles + cross, buttresses, rose window ──
    // shikharaGeoms → sandstone (tower/buttresses), templeBandGeoms → light stone (cornice/cross),
    // flagPoleGeoms → dark slate (spire/pinnacles/belfry openings/rose window/portal).
    if (category === 'religious' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 4
        && religiousVerts < RELIGIOUS_VERT_CAP) {
      const fp = b.footprint;
      let cmnX = Infinity, cmxX = -Infinity, cmnZ = Infinity, cmxZ = -Infinity, ccx = 0, ccz = 0;
      for (const p of fp) {
        if (p.x < cmnX) cmnX = p.x; if (p.x > cmxX) cmxX = p.x;
        if (p.y < cmnZ) cmnZ = p.y; if (p.y > cmxZ) cmxZ = p.y;
        ccx += p.x; ccz += p.y;
      }
      ccx /= fp.length; ccz /= fp.length;
      const minDim = Math.min(cmxX - cmnX, cmxZ - cmnZ);

      // ── BELL TOWER (makeBoxGeom — reliably lit sandstone) ──
      const towerW = Math.max(2.8, Math.min(minDim * 0.5, 6));
      const hw = towerW / 2;
      // Place the tower 55% of the way from the centroid toward a bbox corner — this stays INSIDE
      // irregular/concave footprints (a raw bbox corner can fall in empty space → a floating tower+cross).
      const tcorners = [
        { x: ccx + (cmnX - ccx) * 0.55, z: ccz + (cmnZ - ccz) * 0.55 },
        { x: ccx + (cmxX - ccx) * 0.55, z: ccz + (cmnZ - ccz) * 0.55 },
        { x: ccx + (cmnX - ccx) * 0.55, z: ccz + (cmxZ - ccz) * 0.55 },
        { x: ccx + (cmxX - ccx) * 0.55, z: ccz + (cmxZ - ccz) * 0.55 },
      ];
      const tc = tcorners[deterministicIndex(b.id + 91) % 4];
      const twx = tc.x, twz = tc.z;
      // Cap the tower so tall building-parts don't shoot a 50 m+ spire (the floating-cross-in-the-sky look).
      const towerExtra = Math.min(Math.max(b.height * 0.6, 7), 14);
      const towerH = b.height + towerExtra;
      const towerTopY = baseY + towerH;
      // shaft (centered square box)
      shikharaGeoms.push(makeBoxGeom(twx - hw, twz - hw, twx + hw, twz - hw, 0, 1, towerW, baseY, towerH));
      religiousVerts += 24;
      // ── Tower detail: cornice bands + tall window slots on every face (per level) ──
      const tLevels = Math.max(2, Math.floor(towerH / 6));
      const slotW = Math.min(0.45, hw * 0.4);
      for (let lv = 1; lv <= tLevels && religiousVerts < RELIGIOUS_VERT_CAP - 400; lv++) {
        const ly = baseY + towerH * (lv / (tLevels + 1));
        // cornice band (light stone, slightly proud all round)
        templeBandGeoms.push(makeBoxGeom(twx - hw - 0.15, twz - hw - 0.15, twx + hw + 0.15, twz - hw - 0.15, 0, 1, towerW + 0.3, ly - 0.15, 0.3));
        religiousVerts += 24;
        // tall arched-window slots (dark) — one per face, between bands
        const slotY = ly + 0.4, slotH = Math.min(2.0, (towerH / (tLevels + 1)) * 0.6);
        flagPoleGeoms.push(makeBoxGeom(twx - slotW, twz - hw, twx + slotW, twz - hw, 0, -1, 0.12, slotY, slotH)); // -Z
        flagPoleGeoms.push(makeBoxGeom(twx - slotW, twz + hw, twx + slotW, twz + hw, 0, 1, 0.12, slotY, slotH));  // +Z
        flagPoleGeoms.push(makeBoxGeom(twx - hw, twz - slotW, twx - hw, twz + slotW, -1, 0, 0.12, slotY, slotH)); // -X
        flagPoleGeoms.push(makeBoxGeom(twx + hw, twz - slotW, twx + hw, twz + slotW, 1, 0, 0.12, slotY, slotH));  // +X
        religiousVerts += 96;
      }
      // belfry openings — dark band near the top (the bell windows)
      const belfryH = Math.min(towerExtra * 0.30, 2.2);
      const belfryY = towerTopY - belfryH - 0.7;
      flagPoleGeoms.push(makeBoxGeom(twx - hw - 0.06, twz - hw - 0.06, twx + hw + 0.06, twz - hw - 0.06, 0, 1, towerW + 0.12, belfryY, belfryH));
      religiousVerts += 24;
      // cornice ring (lighter stone, wider) at the top
      const cornH = 0.6;
      templeBandGeoms.push(makeBoxGeom(twx - hw - 0.35, twz - hw - 0.35, twx + hw + 0.35, twz - hw - 0.35, 0, 1, towerW + 0.7, towerTopY - cornH, cornH));
      religiousVerts += 24;
      // tapered slate spire (renders lit — same primitive as the old shikhara tiers)
      const spireH = towerW * 1.8;
      const spire = createCylinderFull(0.0, towerW * 0.62, spireH, 4);
      applyRotationY(spire, Math.PI / 4);
      applyTranslation(spire, twx, towerTopY + spireH / 2, twz);
      flagPoleGeoms.push(spire);
      religiousVerts += 16;
      // 4 corner pinnacles
      const pinR = towerW * 0.16, pinH = towerW * 0.75;
      for (const s of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const pin = createCylinderFull(0.0, pinR, pinH, 4);
        applyRotationY(pin, Math.PI / 4);
        applyTranslation(pin, twx + s[0] * (hw - pinR), towerTopY + pinH / 2, twz + s[1] * (hw - pinR));
        flagPoleGeoms.push(pin);
        religiousVerts += 16;
      }
      // cross at the apex
      const apexY = towerTopY + spireH;
      const crossV = createCylinderFull(0.09, 0.09, 1.8, 4);
      applyTranslation(crossV, twx, apexY + 0.9, twz);
      templeBandGeoms.push(crossV);
      templeBandGeoms.push(makeBoxGeom(twx - 0.5, twz, twx + 0.5, twz, 0, 1, 0.16, apexY + 1.1, 0.16));
      religiousVerts += 20;

      // ── BUTTRESSES on long body edges (Gothic) ──
      for (let i = 0; i < fp.length && religiousVerts < RELIGIOUS_VERT_CAP - 300; i++) {
        const p0 = fp[i], p1 = fp[(i + 1) % fp.length];
        const ex = p1.x - p0.x, ez = p1.y - p0.y;
        const elen = Math.hypot(ex, ez);
        if (elen < 7) continue;
        const ux = ex / elen, uz = ez / elen;
        let nx = -uz, nz = ux;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - ccx) * nx + (mz - ccz) * nz < 0) { nx = -nx; nz = -nz; }
        const nb = Math.max(2, Math.floor(elen / 6));
        for (let k = 1; k < nb; k++) {
          const t = k / nb;
          const bx = p0.x + ex * t, bz = p0.y + ez * t;
          const BW = 0.7, BD = 0.6, BH = b.height * 0.85;
          shikharaGeoms.push(makeBoxGeom(bx - ux * BW / 2, bz - uz * BW / 2, bx + ux * BW / 2, bz + uz * BW / 2, nx, nz, BD, baseY, BH));
          religiousVerts += 24;
        }
      }

      // ── ROSE WINDOW + arched PORTAL on the longest edge (the facade) ──
      let fei = -1, felen = 0;
      for (let i = 0; i < fp.length; i++) {
        const p0 = fp[i], p1 = fp[(i + 1) % fp.length];
        const l = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (l > felen) { felen = l; fei = i; }
      }
      if (fei >= 0 && b.height >= 8 && religiousVerts < RELIGIOUS_VERT_CAP - 100) {
        const p0 = fp[fei], p1 = fp[(fei + 1) % fp.length];
        const ex = p1.x - p0.x, ez = p1.y - p0.y;
        const elen = Math.hypot(ex, ez);
        const ux = ex / elen, uz = ez / elen;
        let nx = -uz, nz = ux;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - ccx) * nx + (mz - ccz) * nz < 0) { nx = -nx; nz = -nz; }
        const roseR = Math.min(elen * 0.12, b.height * 0.12, 2.2);
        const rose = createOrientedDisc(roseR, 12, mx + nx * 0.12, baseY + b.height * 0.72, mz + nz * 0.12, nx, nz);
        flagPoleGeoms.push(rose);
        religiousVerts += 28;
        const portW = Math.min(elen * 0.2, 3);
        flagPoleGeoms.push(makeBoxGeom(mx - ux * portW / 2, mz - uz * portW / 2, mx + ux * portW / 2, mz + uz * portW / 2, nx, nz, 0.3, baseY, Math.min(b.height * 0.35, 4)));
        religiousVerts += 24;
      }

      // ── Small central fléche on the roof ridge (CAPPED so big footprints don't blow up) ──
      if (religiousVerts < RELIGIOUS_VERT_CAP - 40 && minDim >= 6) {
        const flH = Math.min(Math.max(minDim * 0.25, 4), 9);
        const fleche = createCylinderFull(0.0, Math.min(0.6, minDim * 0.03), flH, 4);
        applyRotationY(fleche, Math.PI / 4);
        applyTranslation(fleche, ccx, baseY + b.height + flH / 2, ccz);
        flagPoleGeoms.push(fleche);
        religiousVerts += 16;
      }
    }

    // ── Residential boundary wall + gate ── Barcelona: removed (fronts the street directly).
    if (ENABLE_DELHI_DETAILS && category === 'residential' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && boundaryVerts < BOUNDARY_VERT_CAP) {
      const fp = b.footprint;
      const WALL_H = 2.2;
      const WALL_THICK = 0.15;
      const GATE_W = 3.5;
      const PILLAR_W = 0.35;
      const PILLAR_H = 2.8;
      const GATE_BAR_W = 0.03;
      const GATE_H = 2.0;

      let wcx = 0, wcz = 0;
      for (const p of fp) { wcx += p.x; wcz += p.y; }
      wcx /= fp.length; wcz /= fp.length;

      let bestEdgeIdx = -1;
      const nearest = findNearestRoadSegment(roads, cx, cy);
      if (nearest && nearest.distance < 25) {
        let bestEdgeDist = Infinity;
        for (let ei = 0; ei < fp.length; ei++) {
          const pp0 = fp[ei], pp1 = fp[(ei + 1) % fp.length];
          const emx = (pp0.x + pp1.x) / 2, emz = (pp0.y + pp1.y) / 2;
          if (Math.hypot(pp1.x - pp0.x, pp1.y - pp0.y) < 3) continue;
          const roadPts = nearest.road.points || [];
          let minDSq = Infinity;
          for (let ri = 0; ri < roadPts.length - 1; ri++) {
            const ra = roadPts[ri], rb = roadPts[ri + 1];
            const rdx = rb.x - ra.x, rdz = rb.y - ra.y;
            const rlenSq = rdx * rdx + rdz * rdz;
            let t = rlenSq > 0 ? ((emx - ra.x) * rdx + (emz - ra.y) * rdz) / rlenSq : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ra.x + t * rdx, qz = ra.y + t * rdz;
            const dSq = (emx - qx) ** 2 + (emz - qz) ** 2;
            if (dSq < minDSq) minDSq = dSq;
          }
          if (minDSq < bestEdgeDist) { bestEdgeDist = minDSq; bestEdgeIdx = ei; }
        }
        if (bestEdgeDist > 20 * 20) bestEdgeIdx = -1;
      }

      for (let ei = 0; ei < fp.length; ei++) {
        if (boundaryVerts >= BOUNDARY_VERT_CAP) break;
        const ep0 = fp[ei], ep1 = fp[(ei + 1) % fp.length];
        const edx = ep1.x - ep0.x, edz = ep1.y - ep0.y;
        const elen = Math.hypot(edx, edz);
        if (elen < 1) continue;
        const eex = edx / elen, eez = edz / elen;
        let enx = -eez, enz = eex;
        const emx = (ep0.x + ep1.x) / 2, emz = (ep0.y + ep1.y) / 2;
        if ((emx - wcx) * enx + (emz - wcz) * enz < 0) { enx = -enx; enz = -enz; }

        const isGateEdge = (ei === bestEdgeIdx && elen > GATE_W + PILLAR_W * 2 + 1);

        if (!isGateEdge) {
          const WALL_OFFSET = 0.3;
          const ox0 = ep0.x + enx * WALL_OFFSET, oz0 = ep0.y + enz * WALL_OFFSET;
          const ox1 = ep1.x + enx * WALL_OFFSET, oz1 = ep1.y + enz * WALL_OFFSET;
          boundaryWallGeoms.push(makeBoxGeom(ox0, oz0, ox1, oz1, enx, enz, WALL_THICK, baseY, WALL_H));
          boundaryVerts += 8;
        } else {
          const gateCT = 0.5;
          const gateHalfT = (GATE_W / 2) / elen;
          const pillarT = PILLAR_W / elen;

          // Left wall segment
          const glt = gateCT - gateHalfT - pillarT;
          if (glt > 0.02) {
            const a = { x: ep0.x, y: ep0.y };
            const b2 = { x: ep0.x + edx * glt, y: ep0.y + edz * glt };
            boundaryWallGeoms.push(makeBoxGeom(a.x, a.y, b2.x, b2.y, enx, enz, WALL_THICK, baseY, WALL_H));
            boundaryVerts += 8;
          }
          // Right wall segment
          const grt = gateCT + gateHalfT + pillarT;
          if (grt < 0.98) {
            const a = { x: ep0.x + edx * grt, y: ep0.y + edz * grt };
            boundaryWallGeoms.push(makeBoxGeom(a.x, a.y, ep1.x, ep1.y, enx, enz, WALL_THICK, baseY, WALL_H));
            boundaryVerts += 8;
          }
          // Gate pillars
          const plt0 = gateCT - gateHalfT - pillarT, plt1 = gateCT - gateHalfT;
          boundaryWallGeoms.push(makeBoxGeom(ep0.x + edx * plt0, ep0.y + edz * plt0, ep0.x + edx * plt1, ep0.y + edz * plt1, enx, enz, WALL_THICK + 0.05, baseY, PILLAR_H));
          boundaryVerts += 8;
          const prt0 = gateCT + gateHalfT, prt1 = gateCT + gateHalfT + pillarT;
          boundaryWallGeoms.push(makeBoxGeom(ep0.x + edx * prt0, ep0.y + edz * prt0, ep0.x + edx * prt1, ep0.y + edz * prt1, enx, enz, WALL_THICK + 0.05, baseY, PILLAR_H));
          boundaryVerts += 8;

          // Gate bars
          const gx0 = ep0.x + edx * plt1, gz0 = ep0.y + edz * plt1;
          const gx1 = ep0.x + edx * prt0, gz1 = ep0.y + edz * prt0;
          const hw = GATE_BAR_W / 2;
          // Top + middle horizontal bars
          gateGeoms.push(makeBoxGeom(gx0, gz0, gx1, gz1, enx, enz, hw * 3, baseY + GATE_H, hw * 3));
          gateGeoms.push(makeBoxGeom(gx0, gz0, gx1, gz1, enx, enz, hw * 2, baseY + GATE_H * 0.5, hw * 2));
          // Vertical bars
          const numBarGate = Math.max(3, Math.floor(GATE_W / 0.12));
          for (let bi = 0; bi <= numBarGate; bi++) {
            if (boundaryVerts >= BOUNDARY_VERT_CAP) break;
            const bt = bi / numBarGate;
            const bpx = gx0 + (gx1 - gx0) * bt, bpz = gz0 + (gz1 - gz0) * bt;
            gateGeoms.push(makeBoxGeom(bpx - eex * hw, bpz - eez * hw, bpx + eex * hw, bpz + eez * hw, enx, enz, hw * 2, baseY, GATE_H));
            boundaryVerts += 8;
          }
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Merge and output
  // ────────────────────────────────────────────────────────────────────────

  const buildingGroups = [];
  for (const [materialKey, entry] of byMaterial.entries()) {
    if (entry.geoms.length === 0) continue;
    const merged = mergeBufferSets(entry.geoms);
    if (merged) {
      buildingGroups.push({
        materialKey,
        positions: merged.positions,
        normals: merged.normals,
        uvs: merged.uvs || null,
        indices: merged.indices,
        colors: merged.colors || null,
        wash: merged.wash || null,   // facade ground-glow factor (night shader)
        ao: merged.ao || null,       // baked sky-AO darkening (0 = open sky; v9 tiles)
      });
    }
  }

  const roofGroups = [];
  for (const [materialKey, entry] of roofByMaterial.entries()) {
    if (entry.geoms.length === 0) continue;
    const merged = mergeBufferSets(entry.geoms);
    if (merged) {
      roofGroups.push({
        materialKey,
        positions: merged.positions,
        normals: merged.normals,
        uvs: merged.uvs || null,
        indices: merged.indices,
        colors: merged.colors || null,
      });
    }
  }

  // ── Detail groups ──
  const detailGroups = [];

  function mergeAndPush(geoms, type, materialKey) {
    if (geoms.length === 0) return;
    const merged = mergeBufferSets(geoms);
    if (merged) {
      detailGroups.push({
        type,
        materialKey: materialKey || type,
        positions: merged.positions,
        normals: merged.normals,
        uvs: merged.uvs || null,
        indices: merged.indices,
      });
    }
  }

  mergeAndPush(balconySlabGeoms, 'balconySlab', 'balconySlab');
  mergeAndPush(balconyRailGeoms, 'balconyRail', 'balconyRail');
  mergeAndPush(boundaryWallGeoms, 'boundaryWall', 'boundaryWall');
  mergeAndPush(gateGeoms, 'gate', 'gate');
  mergeAndPush(acUnitGeoms, 'acUnit', 'acUnit');
  mergeAndPush(acFanGeoms, 'acFan', 'acFan');
  mergeAndPush(parapetGeoms, 'parapet', 'parapet');
  mergeAndPush(barExtrudeGeoms, 'barExtrude', 'barExtrude');
  mergeAndPush(shikharaGeoms, 'shikhara', 'shikhara');
  mergeAndPush(templeBaseGeoms, 'templeBase', 'templeBase');
  mergeAndPush(templeBandGeoms, 'templeBand', 'templeBand');
  mergeAndPush(flagPoleGeoms, 'flagPole', 'flagPole');
  mergeAndPush(flagGeoms, 'flag', 'flag');

  // Mall sign
  if (mallSignGeoms.length > 0) {
    const merged = mergeBufferSets(mallSignGeoms);
    if (merged) {
      detailGroups.push({
        type: 'mallSign',
        materialKey: 'mallSign',
        positions: merged.positions,
        normals: merged.normals,
        uvs: merged.uvs || null,
        indices: merged.indices,
      });
    }
  }

  // Mall billboards: each needs its own seed for texture, so output individually
  for (const bb of mallBillboardGeoms) {
    const seed = bb.billboardSeed || 0;
    detailGroups.push({
      type: 'mallBillboard',
      materialKey: 'mallBillboard_' + seed,
      positions: bb.positions,
      normals: bb.normals,
      uvs: bb.uvs || null,
      indices: bb.indices,
    });
  }

  // ── Instance data as column-major 4x4 matrices ──
  let tankResult = null;
  if (tankInstanceList.length > 0) {
    const count = tankInstanceList.length;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const t = tankInstanceList[i];
      const sy = 0.8 + (deterministicIndex(i * 11 + 77) % 40) / 100;
      const rotY = deterministicIndex(i * 3 + 60) % 628 / 100;
      const q = eulerYToQuaternion(rotY);
      composeMatrix4(t.x, t.y, t.z, q.x, q.y, q.z, q.w, t.scale, sy, t.scale, matrices, i * 16);
    }
    tankResult = { matrices, count };
  }

  let pipeResult = null;
  if (pipeInstanceList.length > 0) {
    const count = pipeInstanceList.length;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const p = pipeInstanceList[i];
      // Identity quaternion (no rotation)
      composeMatrix4(p.x, p.y, p.z, 0, 0, 0, 1, p.radius, p.height, p.radius, matrices, i * 16);
    }
    pipeResult = { matrices, count };
  }

  return {
    buildingGroups,
    roofGroups,
    detailGroups,
    tankInstances: tankResult,
    pipeInstances: pipeResult,
    heroSpills: heroSpills.length ? new Float32Array(heroSpills) : null,
    beaconPoints: beaconPoints.length ? new Float32Array(beaconPoints) : null,
  };
}

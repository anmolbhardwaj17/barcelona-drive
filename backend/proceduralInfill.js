/**
 * Procedural building infill for empty landuse=residential and landuse=commercial areas.
 * Subdivides into parcels, places rectangular buildings avoiding existing buildings and roads.
 */
const ENABLE_PROCEDURAL_INFILL = process.env.ENABLE_PROCEDURAL_INFILL !== 'false';

const MIN_PARCEL_SIZE = 12;
const MAX_PARCEL_SIZE = 28;
const MIN_BUILDING_SIZE = 6;
const MAX_BUILDING_SIZE = 22;
const HEIGHT_RESIDENTIAL = [6, 16];
const HEIGHT_COMMERCIAL = [10, 20];
const MAX_INFILL_PER_TILE = 80;

function seeded(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    if (yi > py !== yj > py && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonArea(poly) {
  let area = 0;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(area) / 2;
}

function bboxOverlap(aMinX, aMinY, aMaxX, aMaxY, bMinX, bMinY, bMaxX, bMaxY) {
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;
}

function rectPolygon(cx, cy, w, h, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: cx + (-hw) * cos - (-hh) * sin, y: cy + (-hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (-hh) * sin, y: cy + (hw) * sin + (-hh) * cos },
    { x: cx + (hw) * cos - (hh) * sin, y: cy + (hw) * sin + (hh) * cos },
    { x: cx + (-hw) * cos - (hh) * sin, y: cy + (-hw) * sin + (hh) * cos },
  ];
}

function getBbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function polygonsOverlap(polyA, polyB) {
  const a = getBbox(polyA);
  const b = getBbox(polyB);
  if (!bboxOverlap(a.minX, a.minY, a.maxX, a.maxY, b.minX, b.minY, b.maxX, b.maxY)) return false;
  for (const p of polyA) {
    if (pointInPolygon(p.x, p.y, polyB)) return true;
  }
  for (const p of polyB) {
    if (pointInPolygon(p.x, p.y, polyA)) return true;
  }
  return false;
}

/** Road buffer: for each segment, a rectangle of half-width each side. */
function getRoadBufferPolys(roads) {
  const polys = [];
  for (const road of roads || []) {
    const pts = road.points || [];
    const half = (road.width ?? 8) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      polys.push([
        { x: a.x + nx * half, y: a.y + ny * half },
        { x: b.x + nx * half, y: b.y + ny * half },
        { x: b.x - nx * half, y: b.y - ny * half },
        { x: a.x - nx * half, y: a.y - ny * half },
      ]);
    }
  }
  return polys;
}

function buildingFootprints(processedBuildings) {
  return (processedBuildings || []).map((b) => {
    const f = b.footprint || [];
    return f.length > 1 && f[0].x === f[f.length - 1].x && f[0].y === f[f.length - 1].y ? f.slice(0, -1) : f;
  });
}

function gridSampleInPolygon(polygon, cellSize, seed) {
  const { minX, minY, maxX, maxY } = getBbox(polygon);
  const points = [];
  let idx = 0;
  for (let x = minX + cellSize / 2; x < maxX; x += cellSize) {
    for (let y = minY + cellSize / 2; y < maxY; y += cellSize) {
      if (pointInPolygon(x, y, polygon)) {
        points.push({ x, y, seed: seed + idx * 0.1 });
        idx++;
      }
    }
  }
  return points;
}

/**
 * Generate procedural buildings inside landuse polygons.
 * @param {object[]} landuse - { id, type: 'residential'|'commercial', polygon }
 * @param {object[]} processedBuildings - after processBuilding (have footprint)
 * @param {object[]} roads - processed roads (have points, width)
 * @returns {object[]} Buildings in same shape as processBuilding + isProcedural: true
 */
export function generateInfillBuildings(landuse, processedBuildings, roads) {
  if (!ENABLE_PROCEDURAL_INFILL || !landuse?.length) return [];

  const existingFootprints = buildingFootprints(processedBuildings);
  const roadPolys = getRoadBufferPolys(roads);
  const out = [];
  let proceduralId = -1;

  for (const area of landuse) {
    const poly = area.polygon || [];
    if (poly.length < 3) continue;
    const areaM2 = polygonArea(poly);
    if (areaM2 < 200) continue;

    const cellSize = MIN_PARCEL_SIZE + seeded(area.id) * (MAX_PARCEL_SIZE - MIN_PARCEL_SIZE);
    const candidates = gridSampleInPolygon(poly, cellSize, area.id);
    const heightRange = area.type === 'commercial' ? HEIGHT_COMMERCIAL : HEIGHT_RESIDENTIAL;

    for (const c of candidates) {
      if (out.length >= MAX_INFILL_PER_TILE) break;

      const w = MIN_BUILDING_SIZE + seeded(c.seed) * (MAX_BUILDING_SIZE - MIN_BUILDING_SIZE);
      const h = Math.max(MIN_BUILDING_SIZE * 0.6, w * (0.6 + seeded(c.seed + 1) * 0.6));
      const angle = seeded(c.seed + 2) * Math.PI * 2;
      const footprint = rectPolygon(c.x, c.y, w, h, angle);

      let overlaps = false;
      for (const existing of existingFootprints) {
        if (polygonsOverlap(footprint, existing)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (const rp of roadPolys) {
        if (polygonsOverlap(footprint, rp)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const height = heightRange[0] + seeded(c.seed + 3) * (heightRange[1] - heightRange[0]);
      proceduralId -= 1;
      out.push({
        id: proceduralId,
        height,
        shapeType: 'polygon',
        footprint: [...footprint, footprint[0]],
        tags: { building: area.type },
        isProcedural: true,
      });
      existingFootprints.push(footprint);
    }
  }

  return out;
}

export { ENABLE_PROCEDURAL_INFILL };

/**
 * Filter out buildings that overlap road buffers (half-width per segment).
 * Prevents buildings from visually covering roads.
 */

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

function bboxOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
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

function polygonsIntersect(polyA, polyB) {
  const a = getBbox(polyA);
  const b = getBbox(polyB);
  if (!bboxOverlap(a, b)) return false;
  for (const p of polyA) {
    if (pointInPolygon(p.x, p.y, polyB)) return true;
  }
  for (const p of polyB) {
    if (pointInPolygon(p.x, p.y, polyA)) return true;
  }
  return false;
}

function getRoadBufferPolygons(roads) {
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

/**
 * Remove buildings whose footprint overlaps any road buffer (road half-width).
 * @param {object[]} buildings - Each has footprint: {x,y}[]
 * @param {object[]} roads - Processed roads with points and width
 * @returns {object[]} Filtered buildings (no overlap with roads)
 */
export function filterBuildingsAwayFromRoads(buildings, roads) {
  if (!buildings?.length || !roads?.length) return buildings || [];
  const roadPolys = getRoadBufferPolygons(roads);
  if (roadPolys.length === 0) return buildings;

  return buildings.filter((b) => {
    const footprint = b.footprint || [];
    if (footprint.length < 3) return true;
    const closed = footprint[0].x === footprint[footprint.length - 1].x && footprint[0].y === footprint[footprint.length - 1].y
      ? footprint
      : [...footprint, footprint[0]];
    for (const rp of roadPolys) {
      if (polygonsIntersect(closed, rp)) return false;
    }
    return true;
  });
}

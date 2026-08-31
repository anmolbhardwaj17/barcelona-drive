/**
 * roadClearance.js — "is this spot in the carriageway, and if so where is the nearest spot that
 * isn't?" Shared by streetlights and traffic signals.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * Both placers offset their pole from ONE road: the polyline being walked (streetlights) or the
 * nearest road (signals). That is correct along a street and wrong wherever streets meet. A lamp
 * on Rambla de Catalunya offset 0.5*width + margin from Rambla's centreline is genuinely clear of
 * Rambla — and standing in the middle of the cross street, which the calculation never looked at.
 * The user's shot shows exactly that: a pole planted in open asphalt at an intersection.
 *
 * The junction-skip guard the streetlight placer already has cannot cover this. It tests against a
 * LIST of junction points, so it misses every merge, slip road and roundabout that never made the
 * list, and it is a radius rather than a shape — it deletes good poles well clear of a narrow
 * junction while passing bad ones beside a wide one.
 *
 * ── THE TEST IS AGAINST DRAWN GEOMETRY, NOT AGAINST TOPOLOGY ──────────────────────────────────
 * A point is "on the road" if it falls within half the PAVED width of any drivable segment on the
 * same layer. That is the surface the player actually drives on, so a pole that passes this test
 * cannot be in the road no matter what the junction table says.
 *
 * Layer matters: a surface pole must not be rejected because a tunnel runs beneath it, and a
 * bridge-deck pole must not be rejected because a street passes underneath. Segments only block
 * candidates on their own layer.
 */
import { pavedWidth } from './roadWidths.js';

/** Types a car drives on. Footways/cycleways/steps do not block a pole — poles belong on them. */
const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'residential', 'unclassified', 'living_street', 'service', 'busway', 'road',
]);

/** Stride of the flat segment array: ax, az, bx, bz, halfWidth, layer. */
const STRIDE = 6;

/**
 * Flatten every drivable carriageway into [ax, az, bx, bz, halfW, layer, ...].
 * Flat and typed because this is queried once per candidate pole per tile.
 * @param {object[]} roads
 * @returns {Float64Array}
 */
export function buildCarriagewaySegments(roads) {
  const out = [];
  for (const road of roads || []) {
    if (!DRIVABLE.has(road.highwayType)) continue;
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const halfW = pavedWidth(road) / 2;
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    // ⚠ road.points are {x, y} where y is the WORLD Z. Same convention buildBridgeSegments uses.
    for (let i = 0; i < pts.length - 1; i++) {
      out.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, halfW, layer);
    }
  }
  return Float64Array.from(out);
}

/** Squared distance from (px,pz) to segment (ax,az)-(bx,bz). */
function distSqToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx, cz = az + t * dz;
  const ex = px - cx, ez = pz - cz;
  return ex * ex + ez * ez;
}

/**
 * Is (x, z) inside any drivable carriageway on `layer`, allowing `clearance` metres of slack?
 * @param {Float64Array} segs from buildCarriagewaySegments
 * @returns {boolean}
 */
export function isOnCarriageway(x, z, segs, layer = 0, clearance = 0.35) {
  for (let k = 0; k < segs.length; k += STRIDE) {
    if (segs[k + 5] !== layer) continue;
    const lim = segs[k + 4] + clearance;
    if (distSqToSeg(x, z, segs[k], segs[k + 1], segs[k + 2], segs[k + 3]) < lim * lim) return true;
  }
  return false;
}

/**
 * Find the nearest spot to (x, z) that is off every carriageway, searching along ±the given normal
 * first and then in a widening ring.
 *
 * Direction order is deliberate. The caller already picked a side for a reason (kerb side, wire
 * continuity), so the preferred normal is tried first, then its mirror — a lamp that hops to the
 * far pavement is still a lamp on a pavement. Only when both fail does this fan out, because at
 * that point the original intent is unrecoverable anyway.
 *
 * @returns {{x:number, z:number, moved:number} | null} null when nothing within `maxPush` is clear
 */
export function pushOffCarriageway(x, z, nx, nz, segs, layer = 0, clearance = 0.35, maxPush = 6) {
  if (!isOnCarriageway(x, z, segs, layer, clearance)) return { x, z, moved: 0 };
  const STEP = 0.5;
  for (let d = STEP; d <= maxPush; d += STEP) {
    for (const s of (nx || nz) ? [1, -1] : []) {
      const cx = x + nx * d * s, cz = z + nz * d * s;
      if (!isOnCarriageway(cx, cz, segs, layer, clearance)) return { x: cx, z: cz, moved: d };
    }
    // Ring fallback: 8 compass directions, so a pole boxed in by two roads can still escape
    // diagonally instead of being deleted.
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      const cx = x + Math.cos(th) * d, cz = z + Math.sin(th) * d;
      if (!isOnCarriageway(cx, cz, segs, layer, clearance)) return { x: cx, z: cz, moved: d };
    }
  }
  return null;
}

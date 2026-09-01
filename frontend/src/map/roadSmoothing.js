/**
 * roadSmoothing.js — round off the visible kinks in road centrelines.
 *
 * ── WHY, AND WHY IT IS CHEAP ──────────────────────────────────────────────────────────────────
 * Measured with `backend/tools/cornerAudit.mjs` across all 432 tiles: 8,665 drivable ways, 53,062
 * vertices, 992 km. Only **16.4% of interior corners turn by 10 degrees or more** — those are the
 * kinks you actually see. Capping every turn at 10 degrees costs **+23% road vertices**, which is
 * ~123 vertices per tile before, ~150 after, against 9-18 resident tiles.
 *
 * That is the budget roads are NOT spending. Roads are the largest screen coverage in the game and
 * sit on a MeshStandardMaterial, so their cost is FILL — which is exactly why `?roadv2=0` exists as
 * an attribution switch. Smoothing adds **zero fragments**: the same asphalt area, a rounder edge.
 *
 * Part of the faceting is self-inflicted: the bake runs Douglas-Peucker at 1.2 m, which by
 * definition removes vertices from curves until the polyline deviates by more than the tolerance.
 * This puts them back where curvature says they belong, rather than lowering the tolerance
 * everywhere and paying for straight roads too.
 *
 * ── THE TWO INVARIANTS ────────────────────────────────────────────────────────────────────────
 * 1. **ENDPOINTS ARE NEVER MOVED.** Junction continuity is built on ways agreeing about a shared
 *    node's position (N-57..N-61 took drivable junction steps 130 -> 102 on exactly that basis).
 *    Nudging an endpoint by even a few centimetres would re-open steps that took four measured
 *    passes to close. Only INTERIOR vertices are touched, and each fillet stays inside its own two
 *    legs, so a way's path is preserved and its ends are bit-identical.
 * 2. **THE FILLET CANNOT EAT ITS NEIGHBOUR.** The radius is capped at a fraction of the SHORTER
 *    adjacent leg, so two corners on a short link can never overlap and cross the line over itself.
 */

/** Below this, the kink is invisible and rounding it would only add vertices. */
const MIN_TURN_DEG = 8;
/** Hard cap on the fillet radius, metres. Beyond this a corner stops reading as a corner. */
const MAX_RADIUS_M = 6.0;
/** Fraction of the shorter adjacent leg the fillet may consume. Two fillets share a leg, so < 0.5. */
const LEG_FRACTION = 0.35;
/** Target arc resolution — one sample per this many degrees of turn. */
const DEG_PER_STEP = 10;

/**
 * Round the interior corners of a polyline of `{x, y, elevation?}` points.
 * `y` is the WORLD Z here — the convention road.points uses everywhere in this codebase.
 *
 * @param {{x:number, y:number, elevation?:number}[]} pts
 * @returns {{x:number, y:number, elevation?:number}[]} a new array; the input is not mutated
 */
export function smoothPolyline(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return pts;

  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const P = pts[i], A = pts[i - 1], B = pts[i + 1];
    let ax = P.x - A.x, ay = P.y - A.y;
    let bx = B.x - P.x, by = B.y - P.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 0.01 || lb < 0.01) { out.push(P); continue; }
    ax /= la; ay /= la; bx /= lb; by /= lb;

    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const turnDeg = Math.acos(dot) * 180 / Math.PI;
    if (turnDeg < MIN_TURN_DEG) { out.push(P); continue; }

    const r = Math.min(MAX_RADIUS_M, LEG_FRACTION * Math.min(la, lb));
    if (r < 0.25) { out.push(P); continue; }   // no room to round; leave the corner alone

    // Quadratic Bezier across the corner: leave the incoming leg at S, arrive on the outgoing at E,
    // with P as the control point. That IS the corner rounded, and it stays strictly inside the two
    // legs, so the way's path and its endpoints are untouched.
    const S = { x: P.x - ax * r, y: P.y - ay * r };
    const E = { x: P.x + bx * r, y: P.y + by * r };
    // ⚠ MEASURED, NOT PICKED. `Math.max(2, round(turn/10) + 1)` spent 3 points on an 8-degree kink
    // that needs one, and cost +69.2% vertices across the city. A shallow corner is already almost
    // straight — one intermediate point removes the visible break. Steep corners still get up to 8.
    const steps = Math.max(1, Math.min(8, Math.round(turnDeg / DEG_PER_STEP)));
    // Elevation is carried across the fillet by interpolating the two NEIGHBOURS through P, so a
    // rounded corner on a ramp keeps its grade instead of flattening to the corner's own height.
    const eS = lerpElev(A, P, 1 - r / la), eE = lerpElev(P, B, r / lb);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      const q = {
        x: u * u * S.x + 2 * u * t * P.x + t * t * E.x,
        y: u * u * S.y + 2 * u * t * P.y + t * t * E.y,
      };
      if (eS !== undefined && eE !== undefined) q.elevation = eS + (eE - eS) * t;
      else if (P.elevation !== undefined) q.elevation = P.elevation;
      out.push(q);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function lerpElev(p, q, t) {
  if (p.elevation === undefined || q.elevation === undefined) return undefined;
  return p.elevation + (q.elevation - p.elevation) * t;
}

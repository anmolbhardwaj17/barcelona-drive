/**
 * pathCoverageClipper: clip path-family polylines OUT of carriageway coverage (bake Phase 1 of
 * docs/context/bake-surface-clipping.md).
 *
 * Footways/paths/cycleways/pedestrian ways that run across or along a drivable road used to be
 * drawn as co-planar ribbons ON TOP of the carriageway at runtime (z-fighting / "roads crossing
 * over" artifacts). This region-wide pass removes every path portion whose CENTERLINE lies inside
 * a same-layer drivable road's ribbon, splitting the polyline into the surviving uncovered runs.
 * Each run is emitted as its own road record with the SAME id — identical to how tile splitting
 * already fragments ways, so every downstream consumer (spatial index, traffic grid, streetlights,
 * tile splitter itself) is structurally unaffected.
 *
 * Ways in `skipIds` (marked crossings — footway=crossing etc.) are left intact: they live inside
 * the carriageway by definition and would vanish. The runtime skips their ribbon instead (the
 * `crossing` payload field), keeping the polyline available to gameplay systems.
 *
 * Geometry notes:
 * - Points are [mercX, yUp, mercZ, elev]; distances are computed in Mercator and converted to
 *   real metres via cosLat (Mercator stretch at region latitude) before threshold comparison.
 * - Coverage threshold per drivable segment: realDist < roadWidth/2 + MARGIN_M.
 * - Boundary points are found by bisection on the coverage test, then lerped (all 4 components).
 */

const MARGIN_M = 0.3;        // small skirt beyond the carriageway half-width
const MIN_RUN_M = 2.5;       // drop fragments shorter than this (real metres)
const CELL_M = 32;           // grid cell (real metres) — must exceed max half-width + margin

export const PATH_TYPES = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'track']);
const DRIVABLE_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/**
 * @param {object[]} roads  post-simplify road records ({ id, points, width, highwayType, ... })
 * @param {{ cosLat: number, skipIds?: Set }} opts
 * @returns {{ roads: object[], stats: object }}
 */
export function clipPathsAgainstCarriageways(roads, { cosLat, skipIds = new Set() }) {
  const cellMerc = CELL_M / cosLat;

  // ── Build the drivable-segment hash grid ──────────────────────────────────
  // Each entry: [ax, az, bx, bz, thresholdMerc] (threshold pre-converted to Mercator units).
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  let segCount = 0;
  for (const r of roads) {
    if (!DRIVABLE_TYPES.has(r.highwayType)) continue;
    if (r.tunnel || r.bridge || (r.layer || 0) !== 0) continue;
    const half = ((Number(r.width) > 0 ? Number(r.width) : 6) / 2 + MARGIN_M) / cosLat;
    const pts = r.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][2], bx = pts[i + 1][0], bz = pts[i + 1][2];
      const seg = [ax, az, bx, bz, half];
      const minCx = Math.floor((Math.min(ax, bx) - half) / cellMerc);
      const maxCx = Math.floor((Math.max(ax, bx) + half) / cellMerc);
      const minCz = Math.floor((Math.min(az, bz) - half) / cellMerc);
      const maxCz = Math.floor((Math.max(az, bz) + half) / cellMerc);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const k = key(cx, cz);
          let a = grid.get(k);
          if (!a) grid.set(k, a = []);
          a.push(seg);
        }
      }
      segCount++;
    }
  }

  /** true when the (mercator) point sits inside any drivable ribbon (its own threshold). */
  function covered(x, z) {
    const cx = Math.floor(x / cellMerc), cz = Math.floor(z / cellMerc);
    const a = grid.get(key(cx, cz));
    if (a) { if (hit(a, x, z)) return true; }
    // Segments are inserted into every cell their padded bbox overlaps, so the home cell is
    // sufficient — no neighbour scan needed.
    return false;
  }
  function hit(list, x, z) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 0 ? ((x - s[0]) * dx + (z - s[1]) * dz) / lenSq : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = s[0] + t * dx, qz = s[1] + t * dz;
      const ddx = x - qx, ddz = z - qz;
      if (ddx * ddx + ddz * ddz < s[4] * s[4]) return true;
    }
    return false;
  }

  const lerpPt = (p, q, t) => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
    (p[3] ?? p[1]) + ((q[3] ?? q[1]) - (p[3] ?? p[1])) * t,
  ];

  /** Bisect the coverage boundary between an uncovered and a covered endpoint (8 steps ≈ cm). */
  function boundary(pOut, pIn) {
    let lo = 0, hi = 1;   // lo → pOut side (uncovered), hi → pIn side (covered)
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const m = lerpPt(pOut, pIn, mid);
      if (covered(m[0], m[2])) hi = mid; else lo = mid;
    }
    return lerpPt(pOut, pIn, (lo + hi) / 2);
  }

  const runLenM = (run) => {
    let L = 0;
    for (let i = 0; i < run.length - 1; i++) {
      L += Math.hypot(run[i + 1][0] - run[i][0], run[i + 1][2] - run[i][2]);
    }
    return L * cosLat;
  };

  // ── Clip the path-family roads ─────────────────────────────────────────────
  const out = [];
  const stats = { paths: 0, clipped: 0, dropped: 0, runs: 0, segGrid: segCount };

  for (const r of roads) {
    const isPath = PATH_TYPES.has(r.highwayType) && !r.tunnel && !r.bridge && (r.layer || 0) === 0;
    if (!isPath || skipIds.has(r.id)) { out.push(r); continue; }
    stats.paths++;

    const pts = r.points;
    const cov = pts.map((p) => covered(p[0], p[2]));
    if (!cov.some(Boolean)) { out.push(r); continue; }   // fully clear — common case

    stats.clipped++;
    const runs = [];
    let run = [];
    for (let i = 0; i < pts.length; i++) {
      if (!cov[i]) {
        if (run.length === 0 && i > 0 && cov[i - 1]) run.push(boundary(pts[i], pts[i - 1]));
        run.push(pts[i]);
        if (i < pts.length - 1 && cov[i + 1]) {
          run.push(boundary(pts[i], pts[i + 1]));
          runs.push(run);
          run = [];
        } else if (i < pts.length - 1 && !cov[i + 1]) {
          // Both endpoints clear, but a long segment can still dip THROUGH a carriageway
          // mid-segment (sparse-vertex crossings). Sample at ~4 m; split around any covered span.
          const p = pts[i], q = pts[i + 1];
          const lenM = Math.hypot(q[0] - p[0], q[2] - p[2]) * cosLat;
          if (lenM > 6) {
            const steps = Math.ceil(lenM / 4);
            let tFirst = -1, tLast = -1;
            for (let s = 1; s < steps; s++) {
              const t = s / steps;
              const m = lerpPt(p, q, t);
              if (covered(m[0], m[2])) { if (tFirst < 0) tFirst = t; tLast = t; }
            }
            if (tFirst >= 0) {
              run.push(boundary(p, lerpPt(p, q, tFirst)));   // close run at entry into coverage
              runs.push(run);
              run = [boundary(q, lerpPt(p, q, tLast))];      // reopen after exiting coverage
            }
          }
        }
      }
    }
    if (run.length) runs.push(run);

    let emitted = 0;
    for (const rr of runs) {
      if (rr.length < 2 || runLenM(rr) < MIN_RUN_M) continue;
      out.push({ ...r, points: rr });
      emitted++;
    }
    stats.runs += emitted;
    if (emitted === 0) stats.dropped++;
  }

  return { roads: out, stats };
}

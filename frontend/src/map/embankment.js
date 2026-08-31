/**
 * embankment.js — the pure geometry decisions behind N-54's approach embankments.
 *
 * These two functions live here rather than inside `roadRenderer.js` because they are the only
 * parts of the skirt builder that can be wrong in a way a test can catch: everything else in that
 * builder is THREE.js buffer plumbing, but these decide WHERE a wall exists and how finely it
 * follows the ground. `roadRenderer.js` cannot be imported by a node test (it pulls three, the
 * loaders and the config), so anything worth asserting has to be reachable without it.
 *
 * See the N-54 block in roadRenderer.js for why embankments exist at all.
 */

/**
 * Resample a road polyline to a fixed arc-length step, interpolating heights alongside.
 *
 * ⚠ WHY THE ROAD'S OWN POINTS ARE NOT ENOUGH. A skirt's TOP follows the deck and its BASE follows
 * the terrain. OSM road points can sit 50 m apart on a straight ramp, which describes the deck
 * perfectly and the ground not at all — sampling there would straight-line the terrain between two
 * points and bury or float the entire span between them. The step is therefore set by how fast
 * GROUND can move, not by how the road was drawn.
 *
 * The last point is always emitted: a run that stops one step short leaves the end of the
 * embankment open, and the end cap would then be built at the wrong cross-section.
 *
 * @param {{x:number,y:number}[]} pts road points (`y` is the world Z coordinate)
 * @param {number[]} heights per-point deck height
 * @param {number} step metres between output samples
 * @returns {{pts:{x:number,y:number}[], heights:number[]}|null} null if fewer than 2 samples
 */
export function resampleForSkirt(pts, heights, step) {
  if (!pts || pts.length < 2 || !(step > 0)) return null;
  const out = [], outH = [];
  let acc = 0, next = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.y - a.y;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;          // duplicate points: no length to walk, and t would divide by 0
    while (next <= acc + L) {
      const t = (next - acc) / L;
      out.push({ x: a.x + t * dx, y: a.y + t * dz });
      outH.push((heights[i] ?? 0) + t * ((heights[i + 1] ?? 0) - (heights[i] ?? 0)));
      next += step;
    }
    acc += L;
  }
  const last = pts[pts.length - 1];
  if (out.length === 0
      || Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].y - last.y) > 0.5) {
    out.push({ x: last.x, y: last.y });
    outH.push(heights[heights.length - 1] ?? 0);
  }
  return out.length >= 2 ? { pts: out, heights: outH } : null;
}

/**
 * Group a per-cross-section eligibility mask into the contiguous runs a wall can be built along.
 *
 * A run needs at least TWO cross-sections. A single eligible sample between two rejected ones has
 * no length to build along — it would emit zero wall quads and two coincident end caps, which is a
 * flat sliver standing in the road rather than an embankment.
 *
 * @param {boolean[]} ok
 * @returns {{s:number,e:number}[]} inclusive start/end index pairs
 */
export function findEmbankedRuns(ok) {
  const runs = [];
  let s = 0;
  while (s < ok.length) {
    if (!ok[s]) { s++; continue; }
    let e = s;
    while (e + 1 < ok.length && ok[e + 1]) e++;
    if (e > s) runs.push({ s, e });
    s = e + 1;
  }
  return runs;
}

/**
 * Keep only runs that are an APPROACH — one that reaches ground level at an end.
 *
 * ⚠ WHY THIS EXISTS. The rule "clear ground beneath -> embankment" cannot tell two different
 * structures apart, and shipped the wrong one. An embankment is FILL: the ground rises to the road,
 * so the run must come down to grade somewhere. A deck crossing open parkland is a VIADUCT — clear
 * ground beneath it too, but held up at points, not filled under.
 *
 * Measured on the first drive that showed it: `embanked 67` pillar spots against `built 5` pillars,
 * so the skirt was claiming nearly every support in the city, and a flyover over a park rendered as
 * two long hollow concrete boxes under the deck (user screenshot, 2026-08-31).
 *
 * A run bounded by an at-grade section is a bridge approach and gets its skirt. A run bounded at
 * BOTH ends by more elevated road is mid-span, and mid-span is what piers are for.
 *
 * A run touching the way's own first/last index is kept: the road continues into another way there,
 * and refusing would drop the approach at every tile boundary.
 *
 * @param {{s:number,e:number}[]} runs
 * @param {boolean[]} atGrade per-section "this cross-section is below the float minimum"
 * @param {number} n total cross-sections
 */
export function keepApproachRuns(runs, atGrade, n) {
  return runs.filter(({ s, e }) => {
    const startsAtWayEnd = s === 0;
    const endsAtWayEnd = e === n - 1;
    const dropsBefore = s > 0 && atGrade[s - 1];
    const dropsAfter = e < n - 1 && atGrade[e + 1];
    return startsAtWayEnd || endsAtWayEnd || dropsBefore || dropsAfter;
  });
}

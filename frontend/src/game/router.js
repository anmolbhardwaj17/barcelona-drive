/**
 * router.js — road-network routing for objective directions. Google-Maps-shaped, not crow-flies.
 *
 * Every mode until now pointed at its objective with a BEARING: a triangle that says "that way" and
 * an as-the-crow-flies distance. In a city on a grid that is actively misleading — the marker reads
 * 180 m north-west while the only way there is 400 m round two blocks of Eixample, and the number on
 * screen goes UP as you drive the correct route. This plans an actual path over the loaded road
 * network and returns both the polyline (to draw) and the turns (to announce).
 *
 * ── COORDINATES ───────────────────────────────────────────────────────────────────────────────
 * WORLD throughout, in road-point form: `{x: easting, y: northing}` — the same objects
 * `getRoadSegments()[].points` hands out, so nothing is converted on the way in. Callers that think
 * in `{wx, wz}` map `wz → y`. No physics frame, no X-mirror: this never touches the scene.
 *
 * ── WHY THE GRAPH IS BUILT PER REQUEST AND BOUNDED ────────────────────────────────────────────
 * The loaded network is 9-18 tiles of 500 m; walking every point of every road builds a graph of
 * order 10^5 nodes, which is tens of milliseconds on the main thread — a visible hitch, to plan a
 * 300 m trip. The graph is therefore clipped to the bounding box of (start, goal) plus a margin, so
 * the work scales with the TRIP, not with how much city happens to be resident. A 300 m fare builds
 * a few thousand nodes.
 */

const Q = 1.0;   // metres — node snap. OSM ways share nodes exactly, but tile clipping leaves
                 // near-duplicates at the seams; without a snap the graph is a set of disconnected
                 // per-tile islands and every route fails at a tile boundary.

/** Types a car can actually use. A footway shortcut through a plaza is not a route. */
const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'residential', 'living_street', 'unclassified', 'service', 'road',
]);

/** Rough per-class speed (m/s) — routing on TIME, like a real navigator, not on raw distance. */
const SPEED = {
  motorway: 25, motorway_link: 16, trunk: 20, trunk_link: 14,
  primary: 14, primary_link: 11, secondary: 12, secondary_link: 10,
  tertiary: 11, tertiary_link: 9, residential: 8, living_street: 5,
  unclassified: 9, service: 5, road: 9,
};

const key = (x, y) => `${Math.round(x / Q)},${Math.round(y / Q)}`;

/** Minimal binary heap on `f`. A sorted array is O(n) per pop and dominates the search at 10^4 nodes. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, f) {
    const a = this.a; a.push({ node, f });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Build a routing graph from road segments, clipped to a bounding box.
 * @returns {{xs:Float64Array, ys:Float64Array, adj:Array<Array<{t:number,w:number,name:string}>>, index:Map<string,number>, n:number}}
 */
export function buildGraph(segs, bbox) {
  const [minX, minY, maxX, maxY] = bbox;
  const index = new Map();
  const xs = [], ys = [], adj = [];
  const nodeAt = (x, y) => {
    const k = key(x, y);
    let i = index.get(k);
    if (i === undefined) { i = xs.length; index.set(k, i); xs.push(x); ys.push(y); adj.push([]); }
    return i;
  };
  for (const s of segs || []) {
    if (!DRIVABLE.has(s.highwayType)) continue;
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    const speed = SPEED[s.highwayType] || 8;
    const name = s.name || '';
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      // Keep an edge whose own AABB overlaps the box — NOT "either endpoint is inside", which was
      // the first cut and is wrong in the case that matters: an arterial crossing a 700 m trip box
      // with its next node a kilometre away has NEITHER end inside and would vanish from the graph
      // entirely, so the route would detour around the one street that actually goes there.
      // Conservative on diagonals (a few extra edges, no wrong answers) and exact on the grid.
      if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX
       || Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;
      const ia = nodeAt(a.x, a.y), ib = nodeAt(b.x, b.y);
      if (ia === ib) continue;
      const w = len / speed;
      adj[ia].push({ t: ib, w, name, len });
      // ⚠ UNDIRECTED ON PURPOSE, oneway tag or not. This routes a PLAYER, who can and will turn
      // around, and a one-way graph over tile-clipped OSM strands the goal behind an unreachable
      // kerb often enough to be worse than the occasional wrong-way leg. Revisit when the network
      // is proven connected, not before.
      adj[ib].push({ t: ia, w, name, len });
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), adj, index, n: xs.length };
}

/** Nearest graph node to a point, or -1 if nothing is within `maxD`. */
export function nearestNode(g, x, y, maxD = 60) {
  let best = -1, bestD = maxD * maxD;
  for (let i = 0; i < g.n; i++) {
    const d = (g.xs[i] - x) ** 2 + (g.ys[i] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * A* from `from` to `to` over the loaded roads.
 *
 * @param {Array} segs   getRoadSegments() output
 * @param {{x:number,y:number}} from  world
 * @param {{x:number,y:number}} to    world
 * @param {{margin?:number, snapRadius?:number}} [opts]
 * @returns {{points:{x:number,y:number}[], names:string[], lengthM:number, timeS:number, legs:object[]}|null}
 */
export function planRoute(segs, from, to, { margin = 260, snapRadius = 70 } = {}) {
  const bbox = [
    Math.min(from.x, to.x) - margin, Math.min(from.y, to.y) - margin,
    Math.max(from.x, to.x) + margin, Math.max(from.y, to.y) + margin,
  ];
  const g = buildGraph(segs, bbox);
  if (!g.n) return null;
  const s = nearestNode(g, from.x, from.y, snapRadius);
  const t = nearestNode(g, to.x, to.y, snapRadius);
  if (s < 0 || t < 0) return null;
  if (s === t) return { points: [{ x: g.xs[s], y: g.ys[s] }], names: [], lengthM: 0, timeS: 0, legs: [] };

  // Admissible heuristic: straight-line distance at the FASTEST class in the table. Using an average
  // speed here would overestimate the remaining cost and quietly make A* return non-optimal routes —
  // the failure mode that looks like "the nav sends me the long way round" and is never traced back
  // to the heuristic.
  const VMAX = 25;
  const h = (i) => Math.hypot(g.xs[i] - g.xs[t], g.ys[i] - g.ys[t]) / VMAX;

  const gScore = new Float64Array(g.n).fill(Infinity);
  const came = new Int32Array(g.n).fill(-1);
  const closed = new Uint8Array(g.n);
  const open = new Heap();
  gScore[s] = 0;
  open.push(s, h(s));

  let found = false;
  while (open.size) {
    const { node: cur } = open.pop();
    if (closed[cur]) continue;
    if (cur === t) { found = true; break; }
    closed[cur] = 1;
    for (const e of g.adj[cur]) {
      if (closed[e.t]) continue;
      const ng = gScore[cur] + e.w;
      if (ng < gScore[e.t]) { gScore[e.t] = ng; came[e.t] = cur; open.push(e.t, ng + h(e.t)); }
    }
  }
  if (!found) return null;

  const points = [];
  for (let i = t; i !== -1; i = came[i]) points.push({ x: g.xs[i], y: g.ys[i] });
  points.reverse();

  let lengthM = 0;
  for (let i = 1; i < points.length; i++) {
    lengthM += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  // Street name per LEG of the path, recovered from the edge that was actually taken. "Turn left"
  // is a compass instruction; "Turn left onto Carrer d'Aragó" is a direction — and the names are
  // already in the tiles, parsed and, per CLAUDE.md's census, otherwise discarded.
  const names = [];
  for (let i = 1; i < points.length; i++) {
    const from = index(g, points[i - 1]), to = index(g, points[i]);
    let nm = '';
    if (from >= 0) for (const e of g.adj[from]) if (e.t === to) { nm = e.name; break; }
    names.push(nm);
  }
  // ⚠ `gScore[t]` is the SEARCH's own answer in seconds — A* minimises it, so the trip time was
  // being computed on every plan and then dropped on the floor. An ETA derived afterwards from
  // length ÷ some average speed would be a second, worse estimate that disagrees with the route the
  // player was actually given.
  return { points, names, lengthM, timeS: gScore[t], legs: maneuvers(points, names) };
}

const index = (g, p) => { const i = g.index.get(key(p.x, p.y)); return i === undefined ? -1 : i; };

const TURN_MIN_DEG = 28;   // below this a junction is a bend in the road, not an instruction

/**
 * Turn list from a route polyline. What makes this feel like a navigator rather than a compass: the
 * NEXT instruction, at a distance, in words.
 */
export function maneuvers(points, names = null) {
  const out = [];
  if (!points || points.length < 3) return out;
  let run = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    run += Math.hypot(b.x - a.x, b.y - a.y);
    const inB = Math.atan2(b.x - a.x, b.y - a.y);
    const outB = Math.atan2(c.x - b.x, c.y - b.y);
    let d = (outB - inB) * 180 / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (Math.abs(d) < TURN_MIN_DEG) continue;
    out.push({
      at: { x: b.x, y: b.y },
      distFromStart: run,
      deg: d,
      dir: turnWord(d),
      onto: names ? (names[i] || '') : '',   // the street you end up on, not the one you leave
    });
  }
  return out;
}

export function turnWord(deg) {
  const a = Math.abs(deg);
  if (a > 150) return 'U-turn';
  if (a > 105) return deg > 0 ? 'Sharp right' : 'Sharp left';
  if (a > 55) return deg > 0 ? 'Turn right' : 'Turn left';
  return deg > 0 ? 'Bear right' : 'Bear left';
}

/**
 * How far the car has strayed from a route, and how far along it is.
 * Callers replan on `offBy` — a route the player has left is worse than no route, because it draws
 * a confident line down a street they are not on.
 */
export function projectOnRoute(points, x, y) {
  let best = { d2: Infinity, seg: 0, t: 0, along: 0 };
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 < best.d2) best = { d2, seg: i, t, along: acc + Math.sqrt(L2) * t };
    acc += Math.sqrt(L2);
  }
  return { offBy: Math.sqrt(best.d2), along: best.along, total: acc, seg: best.seg, t: best.t };
}

/**
 * Objective routing (router.js).
 *
 * The modes used to point at an objective with a BEARING — a triangle and a crow-flies distance. On
 * an Eixample grid that is misleading: the marker reads 180 m north-west while the only way there is
 * 400 m round two blocks, and the number on screen goes UP as you drive the correct route. These
 * pin the replacement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, buildGraph, nearestNode, maneuvers, turnWord, projectOnRoute } from '../src/game/router.js';

/** A grid of `n`×`n` blocks, `step` metres apart, as road segments. */
function grid(n = 5, step = 100, type = 'residential') {
  const segs = [];
  for (let r = 0; r < n; r++) {
    segs.push({ highwayType: type, name: `Carrer ${r}`, points: Array.from({ length: n }, (_, c) => ({ x: c * step, y: r * step })) });
    segs.push({ highwayType: type, name: `Avinguda ${r}`, points: Array.from({ length: n }, (_, c) => ({ x: r * step, y: c * step })) });
  }
  return segs;
}

test('a route follows the ROADS, not the crow — the whole point of the module', () => {
  const segs = grid(4, 100);
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 300, y: 300 });
  assert.ok(r, 'no route');
  // Crow-flies is 424 m; on a grid with no diagonals the shortest legal path is 600 m.
  const crow = Math.hypot(300, 300);
  assert.ok(r.lengthM > crow * 1.3, `route ${r.lengthM.toFixed(0)} m vs crow ${crow.toFixed(0)} m`);
  assert.ok(Math.abs(r.lengthM - 600) < 1, `expected 600 m of grid, got ${r.lengthM.toFixed(1)}`);
  assert.equal(r.points[0].x, 0);
  assert.deepEqual({ x: r.points.at(-1).x, y: r.points.at(-1).y }, { x: 300, y: 300 });
});

test('A* finds the SHORTEST path, not merely a path', () => {
  const segs = grid(5, 100);
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 400, y: 0 });
  assert.ok(r);
  assert.ok(Math.abs(r.lengthM - 400) < 1, `straight down one street should be 400 m, got ${r.lengthM.toFixed(1)}`);
});

test('a footway is not a route — pedestrian shortcuts must not be planned through', () => {
  // Two parallel streets 100 m apart, joined ONLY by a footway across the middle.
  const segs = [
    { highwayType: 'residential', name: 'North', points: [{ x: 0, y: 100 }, { x: 200, y: 100 }] },
    { highwayType: 'residential', name: 'South', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
    { highwayType: 'footway', name: 'Passatge', points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] },
  ];
  assert.equal(planRoute(segs, { x: 0, y: 0 }, { x: 0, y: 100 }), null);
  // Add a real connection and the same trip becomes routable.
  segs.push({ highwayType: 'service', name: 'Link', points: [{ x: 200, y: 0 }, { x: 200, y: 100 }] });
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 0, y: 100 });
  assert.ok(r && Math.abs(r.lengthM - 500) < 1, `expected 500 m round the block, got ${r?.lengthM}`);
});

test('THE TILE SEAM: near-duplicate nodes are snapped, or every route dies at a tile boundary', () => {
  // Tile clipping leaves the same junction as two points a few centimetres apart. Without the snap
  // the graph is a set of disconnected per-tile islands and this returns null.
  const segs = [
    { highwayType: 'residential', name: 'A', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { highwayType: 'residential', name: 'B', points: [{ x: 100.18, y: -0.09 }, { x: 200, y: 0 }] },
  ];
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 200, y: 0 });
  assert.ok(r, 'the seam broke the graph');
  assert.ok(r.lengthM > 190 && r.lengthM < 210, r?.lengthM);
});

test('routing is on TIME, so it prefers the faster class when both reach the goal', () => {
  // Two ways from A to B: 300 m of primary (14 m/s = 21.4 s) or 260 m of service (5 m/s = 52 s).
  const segs = [
    { highwayType: 'primary', name: 'Gran Via', points: [{ x: 0, y: 0 }, { x: 150, y: 60 }, { x: 300, y: 0 }] },
    { highwayType: 'service', name: 'Back lane', points: [{ x: 0, y: 0 }, { x: 150, y: -20 }, { x: 300, y: 0 }] },
  ];
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 300, y: 0 });
  assert.ok(r);
  const viaGranVia = r.points.some((p) => p.y > 30);
  assert.ok(viaGranVia, 'took the shorter but far slower back lane');
  assert.ok(r.lengthM > 300, `and it should be LONGER in metres: ${r.lengthM.toFixed(0)}`);
});

test('an unreachable objective returns null rather than a straight line', () => {
  const segs = [
    { highwayType: 'residential', name: 'Here', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { highwayType: 'residential', name: 'There', points: [{ x: 5000, y: 5000 }, { x: 5100, y: 5000 }] },
  ];
  assert.equal(planRoute(segs, { x: 0, y: 0 }, { x: 5000, y: 5000 }), null);
});

test('the graph is clipped to the TRIP, not to the resident city', () => {
  // 18 tiles of road either side must not end up in the graph for a 200 m fare — that is the
  // difference between a few thousand nodes and 10^5, i.e. between instant and a visible hitch.
  const near = grid(3, 100);
  const far = [];
  for (let i = 0; i < 400; i++) {
    far.push({ highwayType: 'residential', name: `Far ${i}`, points: [{ x: 9000 + i, y: 0 }, { x: 9000 + i, y: 400 }] });
  }
  const all = near.concat(far);
  const bbox = [-260, -260, 460, 460];
  const g = buildGraph(all, bbox);
  assert.ok(g.n < 200, `graph took in ${g.n} nodes; the far city leaked in`);
  assert.ok(g.n > 5, 'and it must not be empty');
});

test('an edge that merely CROSSES the box is kept — clipping to both ends frays the boundary', () => {
  const segs = [{ highwayType: 'residential', name: 'Long', points: [{ x: -500, y: 0 }, { x: 500, y: 0 }] }];
  const g = buildGraph(segs, [-100, -100, 100, 100]);
  assert.equal(g.n, 2, 'the crossing edge was dropped');
});

test('turn words read like a navigator, and a bend in the road is not an instruction', () => {
  assert.equal(turnWord(90), 'Turn right');
  assert.equal(turnWord(-90), 'Turn left');
  assert.equal(turnWord(-170), 'U-turn');
  assert.equal(turnWord(35), 'Bear right');
  assert.equal(turnWord(-120), 'Sharp left');
  // A 15° kink mid-street must NOT produce "Bear right" — the announcement would never stop.
  const gentle = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 27, y: 200 }];
  assert.equal(maneuvers(gentle).length, 0);
  // A right-angle junction must.
  const corner = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
  const m = maneuvers(corner);
  assert.equal(m.length, 1);
  assert.equal(m[0].dir, 'Turn right');
  assert.ok(Math.abs(m[0].distFromStart - 100) < 1e-6);
});

test('straying off the route is measurable, so a mode knows when to replan', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const on = projectOnRoute(pts, 50, 0);
  assert.ok(on.offBy < 1e-9);
  assert.ok(Math.abs(on.along - 50) < 1e-9);
  assert.ok(Math.abs(on.total - 200) < 1e-9);
  const off = projectOnRoute(pts, 50, 40);
  assert.ok(Math.abs(off.offBy - 40) < 1e-9, `off by ${off.offBy}`);
});

test('nearestNode refuses a snap that is further than the radius', () => {
  const g = buildGraph(grid(2, 100), [-300, -300, 400, 400]);
  assert.ok(nearestNode(g, 3, 4, 60) >= 0);
  assert.equal(nearestNode(g, 900, 900, 60), -1);
});

test('a turn names the street you end up ON, not the one you leave', () => {
  const segs = [
    { highwayType: 'residential', name: "Carrer de Balmes", points: [{ x: 0, y: 0 }, { x: 0, y: 100 }] },
    { highwayType: 'residential', name: "Carrer d'Aragó", points: [{ x: 0, y: 100 }, { x: 120, y: 100 }] },
  ];
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 120, y: 100 });
  assert.ok(r, 'no route');
  assert.equal(r.legs.length, 1);
  assert.equal(r.legs[0].dir, 'Turn right');
  assert.equal(r.legs[0].onto, "Carrer d'Aragó");
});

// ── M-9: the ETA ───────────────────────────────────────────────────────────────────────────────
// A* minimises TIME, so the trip time is the search's own answer. It was being computed on every
// plan and dropped on the floor, and any ETA derived afterwards from length ÷ average speed would
// be a second, worse estimate that disagrees with the route the player was given.

test('a route reports the travel time the search actually minimised', () => {
  const segs = grid(5, 100, 'residential');            // residential = 8 m/s in the speed table
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 400, y: 0 });
  assert.ok(r, 'no route');
  assert.ok(Math.abs(r.lengthM - 400) < 1, r.lengthM);
  assert.ok(Math.abs(r.timeS - 400 / 8) < 0.5, `400 m of residential should be ~50 s, got ${r.timeS}`);
});

test('the ETA follows the CLASS, not just the distance', () => {
  // The whole reason to report the search's own number: the same metres take different time.
  const slow = [{ highwayType: 'service', name: 'Lane', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] }];
  const fast = [{ highwayType: 'primary', name: 'Gran Via', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] }];
  const a = planRoute(slow, { x: 0, y: 0 }, { x: 300, y: 0 });
  const b = planRoute(fast, { x: 0, y: 0 }, { x: 300, y: 0 });
  assert.ok(Math.abs(a.lengthM - b.lengthM) < 1, 'same distance');
  assert.ok(a.timeS > b.timeS * 2, `service ${a.timeS.toFixed(0)}s vs primary ${b.timeS.toFixed(0)}s`);
});

test('a zero-length route reports zero time, not undefined', () => {
  const segs = grid(3, 100);
  const r = planRoute(segs, { x: 0, y: 0 }, { x: 0, y: 0 });
  assert.ok(r);
  assert.equal(r.timeS, 0);
  assert.equal(r.lengthM, 0);
});

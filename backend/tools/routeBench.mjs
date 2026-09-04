#!/usr/bin/env node
/**
 * routeBench.mjs — M-10. How long does `planRoute` actually take, on real Barcelona roads?
 *
 * ═══ WHY ════════════════════════════════════════════════════════════════════════════════════════
 * The router runs A* on the MAIN THREAD. It is bounded (the graph is clipped to the trip) and
 * throttled (≥1.1 s between searches, replan only when off-route), and no hitch has been reported —
 * but "no hitch reported" is not a measurement, and the case that would hurt has never been tried:
 * a long trip through the densest tiles in the city.
 *
 * The board says a worker is the fix ONLY IF A NUMBER SAYS SO. This produces the number.
 *
 * ⚠ Roads are stored MERCATOR in the tiles (N-25/N-7 in the tracker are both this mistake). Mercator
 * metres at 41.39°N are 1/cos ≈ 1.33× ground metres, so they are scaled here — otherwise every
 * distance, the 260 m graph margin and the whole speed table are 33% wrong and the timing is of a
 * different problem.
 *
 * Usage:  node backend/tools/routeBench.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { planRoute, buildGraph } from '../../frontend/src/game/router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILE_DIR = path.join(HERE, '..', 'tiles', 'barcelona');
const COS = Math.cos(41.39 * Math.PI / 180);

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.name.endsWith('.bin') && e.name !== 'citymap.bin') out.push(f);
  }
  return out;
}

/** Roads from one tile, in the {x, y} world-metre form the router expects. */
function readRoads(file) {
  const b = fs.readFileSync(file);
  const hl = b.readUInt32LE(0);
  let end = 4 + hl;
  while (end > 4 && b[end - 1] === 0) end--;
  let h; try { h = JSON.parse(b.slice(4, end).toString('utf8')); } catch { return []; }
  const base = 4 + hl;
  const out = [];
  for (const r of h.roads || []) {
    if (!r.pointCount || r.pointCount < 2) continue;
    const a = new Float32Array(b.buffer, b.byteOffset + base + r.pointsOffset, r.pointCount * 3);
    const points = new Array(r.pointCount);
    for (let i = 0; i < r.pointCount; i++) points[i] = { x: a[i * 3] * COS, y: a[i * 3 + 2] * COS };
    out.push({ highwayType: r.highwayType, name: r.name || '', points });
  }
  return out;
}

// The 18 tiles nearest the Gran Via spawn — the resident set at its densest, which is where the
// v3 benchmark measures and the only place a p95 answer means anything.
const SPAWN = { x: 2.1640 * 6378137 * Math.PI / 180 * COS, y: 0 };
const files = walk(TILE_DIR);
const scored = files.map((f) => {
  const m = f.match(/16\/(\d+)\/(\d+)\.bin$/);
  return { f, x: m ? +m[1] : 0, z: m ? +m[2] : 0 };
});
// tile 16_33161_24477 is the spawn tile (CLAUDE.md)
scored.sort((a, b) => ((a.x - 33161) ** 2 + (a.z - 24477) ** 2) - ((b.x - 33161) ** 2 + (b.z - 24477) ** 2));
let segs = [];
for (const t of scored.slice(0, 18)) segs = segs.concat(readRoads(t.f));

const drivable = segs.filter((s) => s.points.length >= 2);
console.log(`loaded ${scored.slice(0, 18).length} tiles · ${segs.length} road segments`);

// Pick start/goal pairs at target crow distances, from real road vertices.
const verts = [];
for (const s of drivable) for (const p of s.points) verts.push(p);
const pick = (from, target) => {
  let best = null, bestErr = Infinity;
  for (let i = 0; i < verts.length; i += 7) {
    const d = Math.hypot(verts[i].x - from.x, verts[i].y - from.y);
    const err = Math.abs(d - target);
    if (err < bestErr) { bestErr = err; best = verts[i]; }
  }
  return best;
};

const origin = verts[(verts.length / 2) | 0];
console.log('\ntrip     graph nodes   plan ms (p50 / worst of 15)   route');
for (const target of [200, 500, 1000, 2000]) {
  const goal = pick(origin, target);
  if (!goal) continue;
  const g = buildGraph(segs, [
    Math.min(origin.x, goal.x) - 260, Math.min(origin.y, goal.y) - 260,
    Math.max(origin.x, goal.x) + 260, Math.max(origin.y, goal.y) + 260]);
  const times = [];
  let r = null;
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    r = planRoute(segs, origin, goal);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[7], worst = times[14];
  console.log(`${String(target).padStart(4)} m   ${String(g.n).padStart(11)}   `
    + `${p50.toFixed(1).padStart(6)} / ${worst.toFixed(1).padStart(6)}            `
    + (r ? `${(r.lengthM / 1000).toFixed(2)} km, ${r.legs.length} turns` : 'NO ROUTE'));
}

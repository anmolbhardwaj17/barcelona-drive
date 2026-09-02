/**
 * CAN OUR OWN GRAPH SAY WHERE A ROAD GOES?
 *
 * The shipped direction-board logic (roadInfraRenderer.js:1028) signs "unique names of OTHER roads
 * branching off at this junction" — a street NAME, not a DESTINATION. A real Spanish sign says where
 * the road leads. This asks whether the baked graph can answer that WITHOUT OSM destination tags,
 * before anyone writes a renderer for it.
 *
 * Method: build the drivable graph from baked tiles, find junctions, and from each exit run a
 * best-first walk (preferring higher road class) out to REACH_M, recording the most important named
 * road found. Read-only.
 */
import fs from 'node:fs'; import path from 'node:path';
const R = 6378137, K = Math.cos(41.350 * Math.PI / 180);
const REACH_M = 1500;
// Lower = more important. This IS the "our own logic" ranking — nothing here reads a destination tag.
const CLASS_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
  residential: 6, unclassified: 6, living_street: 7, service: 8 };
const LINKS = { motorway_link: 0, trunk_link: 1, primary_link: 2, secondary_link: 3, tertiary_link: 4 };
const rankOf = (t) => (CLASS_RANK[t] ?? LINKS[t] ?? 9);
const DRIVABLE = new Set([...Object.keys(CLASS_RANK), ...Object.keys(LINKS)]);

const files = [];
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):e.name.endsWith('.bin')&&files.push(p);}})('backend/tiles/barcelona');
const ways = new Map();
for (const f of files) {
  let b; try { b = fs.readFileSync(f); } catch { continue; } if (b.length < 8) continue;
  const hl = b.readUInt32LE(0); let x = hl; while (x > 0 && b[4+x-1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4+x)); } catch { continue; }
  const ab = b.buffer.slice(b.byteOffset+4+hl, b.byteOffset+b.length);
  for (const r of h.roads || []) {
    if (ways.has(r.id) || !DRIVABLE.has(r.highwayType) || r.pointCount < 2) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount*3), pts = [];
    for (let i = 0; i < r.pointCount; i++) pts.push({ x: p[i*3]*K, z: p[i*3+2]*K });
    ways.set(r.id, { id: r.id, name: r.name || '', type: r.highwayType, rank: rankOf(r.highwayType), pts });
  }
}

// Node graph: snap endpoints to a 1 m grid; a node with >=3 way-ends is a junction.
const SNAP = 1.0;
const key = (x,z) => `${Math.round(x/SNAP)},${Math.round(z/SNAP)}`;
const nodes = new Map();
for (const w of ways.values()) {
  for (const [p, end] of [[w.pts[0],'A'],[w.pts[w.pts.length-1],'B']]) {
    const k = key(p.x,p.z); if (!nodes.has(k)) nodes.set(k, { x:p.x, z:p.z, ends:[] });
    nodes.get(k).ends.push({ w, end });
  }
}
const junctions = [...nodes.values()].filter(n => n.ends.length >= 3);

/**
 * Best-first outward walk from ONE exit, COMMITTED TO ITS HEADING.
 *
 * ⚠ The first version omitted the cone and reported 100% coverage while every exit at a junction
 * returned the same answer ("Via Augusta" for all 8 samples). A free-fanning walk finds the most
 * important road ANYWHERE within reach, which is not what a direction sign says. Two constraints
 * make it directional: every expanded way must lie inside a cone around the exit bearing, and must
 * make radial progress away from the junction. Without both, the percentage is meaningless.
 */
const CONE_COS = Math.cos((62 * Math.PI) / 180);   // 62 deg half-angle around the exit bearing
function destinationFor(startWay, j) {
  const far = (w) => {
    const a = w.pts[0], b = w.pts[w.pts.length - 1];
    return (Math.hypot(a.x - j.x, a.z - j.z) > Math.hypot(b.x - j.x, b.z - j.z)) ? a : b;
  };
  // Exit bearing: from the junction toward this way's far end.
  const f0 = far(startWay);
  let bx = f0.x - j.x, bz = f0.z - j.z;
  const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;

  let best = null;
  const seen = new Set([startWay.id]);
  let frontier = [{ way: startWay, dist: 0, radius: bl }];
  for (let depth = 0; depth < 40 && frontier.length; depth++) {
    frontier.sort((a, b) => a.way.rank - b.way.rank || a.dist - b.dist);
    const next = [];
    for (const cur of frontier.slice(0, 12)) {
      const w = cur.way;
      let len = 0;
      for (let i = 0; i < w.pts.length - 1; i++) len += Math.hypot(w.pts[i+1].x - w.pts[i].x, w.pts[i+1].z - w.pts[i].z);
      const d = cur.dist + len;
      if (w.name && (!best || w.rank < best.rank || (w.rank === best.rank && d < best.dist))) {
        best = { name: w.name, type: w.type, rank: w.rank, dist: d };
      }
      if (d > REACH_M) continue;
      for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
        const n = nodes.get(key(p.x, p.z)); if (!n) continue;
        for (const e of n.ends) {
          if (seen.has(e.w.id)) continue;
          const fp = far(e.w);
          const rx = fp.x - j.x, rz = fp.z - j.z;
          const rr = Math.hypot(rx, rz) || 1;
          if (rr <= cur.radius) continue;                       // must move AWAY from the junction
          if ((rx / rr) * bx + (rz / rr) * bz < CONE_COS) continue;  // and stay in this exit's cone
          seen.add(e.w.id);
          next.push({ way: e.w, dist: d, radius: rr });
        }
      }
    }
    frontier = next;
  }
  return best;
}

let exits = 0, named = 0, majorNamed = 0;
const byRank = new Map();
const samples = [];
const jSample = junctions.filter(j => j.ends.some(e => e.w.rank <= 3));
for (const j of jSample.slice(0, 400)) {
  const perJ = [];
  for (const e of j.ends) {
    exits++;
    const dest = destinationFor(e.w, j);
    if (dest) { named++; byRank.set(dest.type, (byRank.get(dest.type)||0)+1); if (dest.rank <= 3) majorNamed++; }
    if (dest) perJ.push({ from: e.w.name || `(unnamed ${e.w.type})`, to: dest.name, type: dest.type, d: dest.dist });
  }
  // Keep a junction whose exits DISAGREE — that is the whole point of a direction sign.
  if (samples.length < 4 && perJ.length >= 3 && new Set(perJ.map(d => d.to)).size >= 3) samples.push(perJ);
}
console.log(`\ndrivable ways ${ways.size.toLocaleString()}  ·  graph nodes ${nodes.size.toLocaleString()}  ·  junctions (3+ ways) ${junctions.length.toLocaleString()}`);
console.log(`junctions touching a primary-or-better road: ${jSample.length.toLocaleString()}\n`);
console.log(`sampled ${Math.min(400,jSample.length)} such junctions -> ${exits} exits`);
console.log(`  exit resolves to a NAMED destination : ${named} (${(named/exits*100).toFixed(1)}%)`);
console.log(`  ...and it is primary-or-better       : ${majorNamed} (${(majorNamed/exits*100).toFixed(1)}%)\n`);
console.log('destination road class:');
[...byRank.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([t,n])=>console.log(`  ${t.padEnd(16)} ${n}`));
const divergent = samples.length;
console.log(`\njunctions whose exits give 3+ DIFFERENT destinations (of 400 sampled): shown below`);
for (const g of samples) {
  console.log('  --- one junction ---');
  for (const s of g) console.log(`    exit ${s.from.slice(0,30).padEnd(32)} -> ${s.to.slice(0,32).padEnd(34)} ${s.type} @ ${(s.d/1000).toFixed(1)} km`);
}

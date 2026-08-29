/**
 * ROADS THAT SHOULD MERGE AND DO NOT.
 *
 * User: "2 roads very close to each other but no ramp and just exiting like this thats wrong for
 * sure — they should have a smooth ramp or just a ramp for now, first lets connect the roads".
 *
 * `rule7_missingLinkSynthesiser` already joins two free ends FACING each other (cos >= 0.90). A
 * MERGE is a different shape and rule 7 cannot see it: a slip road ends ALONGSIDE the carriageway
 * it should join, pointing roughly the SAME way, not at another dead end. Its endpoint lands on the
 * other road's INTERIOR, not on its endpoint.
 *
 * So this measures free ends that die beside another road's flank, before any rule is written for
 * them — a stub-connect rule that fires on the wrong population would weld slip roads into
 * buildings.
 *
 * Read-only over baked tiles.
 */
import fs from 'node:fs'; import path from 'node:path';
const ROOT = 'backend/tiles/barcelona', R = 6378137;
const NEAR_M   = Number(process.env.NEAR_M   ?? 14);  // how close the dead end is to the other flank
const JOIN_TOL = Number(process.env.JOIN_TOL ?? 3);   // endpoints this close already count as joined
const PARALLEL = Number(process.env.PARALLEL ?? 0.7); // |cos| between the stub and the road it dies beside
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);

const files = [];
(function w(d){ for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name.endsWith('.bin')) files.push(p);
} })(ROOT);

// ── one pass: gather every drivable way's polyline in metres, deduped by id (H18) ──
const ways = new Map();
for (const f of files) {
  const b = fs.readFileSync(f); const hl = b.readUInt32LE(0);
  let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  for (const r of h.roads || []) {
    if (ways.has(r.id) || r.pointsOffset === undefined || r.pointCount < 2) continue;
    if (!DRIVABLE.has(r.highwayType)) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount * 3);
    const pts = [];
    for (let i = 0; i < r.pointCount; i++) {
      const lon = (p[i*3] / R) * (180/Math.PI);
      const lat = (2*Math.atan(Math.exp(p[i*3+2]/R)) - Math.PI/2) * (180/Math.PI);
      const k = Math.cos(lat * Math.PI/180);
      pts.push({ x: p[i*3] * k, z: p[i*3+2], y: p[i*3+1], lat, lon });
    }
    ways.set(r.id, { id: r.id, type: r.highwayType, name: r.name || '', tunnel: !!r.tunnel,
                     bridge: !!r.bridge, layer: r.layer ?? 0, pts });
  }
}

// ── spatial grid over all vertices, so "near another road" is not O(n^2) ──
const CELL = 40;
const grid = new Map();
const key = (x, z) => `${Math.floor(x/CELL)}|${Math.floor(z/CELL)}`;
for (const w of ways.values())
  for (let i = 0; i < w.pts.length; i++) {
    const k = key(w.pts[i].x, w.pts[i].z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ w, i });
  }
const around = (x, z) => {
  const out = [];
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const c = grid.get(`${Math.floor(x/CELL)+cx}|${Math.floor(z/CELL)+cz}`);
    if (c) out.push(...c);
  }
  return out;
};

let freeEnds = 0, beside = 0;
const rows = [];
for (const w of ways.values()) {
  for (const endIdx of [0, w.pts.length - 1]) {
    const e = w.pts[endIdx];
    const nb = around(e.x, e.z);
    // FREE END? nothing else's vertex sits on it
    let joined = false;
    for (const { w: o } of nb) {
      if (o.id === w.id) continue;
      for (const q of [o.pts[0], o.pts[o.pts.length - 1]])
        if (Math.hypot(q.x - e.x, q.z - e.z) <= JOIN_TOL) { joined = true; break; }
      if (joined) break;
    }
    if (joined) continue;
    freeEnds++;
    // direction of the stub AT the end, pointing outward
    const inner = w.pts[endIdx === 0 ? Math.min(1, w.pts.length-1) : w.pts.length - 2];
    let sx = e.x - inner.x, sz = e.z - inner.z;
    const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
    // nearest INTERIOR segment of another way
    let best = null;
    for (const { w: o, i } of nb) {
      if (o.id === w.id || i >= o.pts.length - 1) continue;
      const a = o.pts[i], b2 = o.pts[i+1];
      const dx = b2.x - a.x, dz = b2.z - a.z; const l2 = dx*dx + dz*dz;
      if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((e.x-a.x)*dx + (e.z-a.z)*dz) / l2));
      if (t <= 0.01 || t >= 0.99) continue;         // near an END is rule 7's job, not a merge
      const d = Math.hypot(e.x - (a.x + t*dx), e.z - (a.z + t*dz));
      if (d > NEAR_M) continue;
      const ol = Math.sqrt(l2);
      const cos = Math.abs((sx*dx + sz*dz) / ol);
      if (cos < PARALLEL) continue;                  // crossing it, not merging into it
      if (!best || d < best.d) best = { d, o, dy: Math.abs(e.y - (a.y + t*(b2.y - a.y))) };
    }
    if (!best) continue;
    beside++;
    rows.push({ id: w.id, type: w.type, name: w.name, into: best.o.type, intoName: best.o.name,
                gap: +best.d.toFixed(1), dy: +best.dy.toFixed(1),
                at: `${e.lat.toFixed(5)},${e.lon.toFixed(5)}` });
  }
}
rows.sort((a, b) => a.gap - b.gap);
const flat = rows.filter(r => r.dy <= 1.0).length;
console.log(`drivable ways                                    : ${ways.size.toLocaleString()}`);
console.log(`free ends (nothing joins them)                   : ${freeEnds.toLocaleString()}`);
console.log(`…dying BESIDE another road's flank (<= ${NEAR_M} m, |cos| >= ${PARALLEL}) : ${beside}`);
console.log(`   of those, within 1 m of it VERTICALLY          : ${flat}  <- connectable at grade`);
console.log(`   the rest need a ramp (height gap > 1 m)        : ${beside - flat}`);
console.log('\nclosest 15:');
console.log('   gap    dY   stub                    merging into');
for (const r of rows.slice(0, 15))
  console.log(`  ${String(r.gap).padStart(5)} ${String(r.dy).padStart(5)}   ${String(r.type).padEnd(14)} ${(r.name||'(unnamed)').slice(0,22).padEnd(23)} ${String(r.into).padEnd(14)} ${(r.intoName||'(unnamed)').slice(0,20)}   ?spawn=${r.at}`);

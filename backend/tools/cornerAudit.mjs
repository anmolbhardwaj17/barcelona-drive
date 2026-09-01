/**
 * cornerAudit.mjs — HOW SHARP ARE THE ROAD CORNERS, AND WHAT WOULD SMOOTHING COST?
 *
 * The user asked whether road corners can be rounded off, or whether that is too expensive for a
 * browser. Both halves are measurable, so neither gets guessed at.
 *
 * The suspicion going in: the bake runs Douglas-Peucker at 1.2 m tolerance, which by definition
 * DELETES vertices from curves until the remaining polyline deviates by more than the tolerance. So
 * some faceting is self-inflicted rather than OSM's sparseness. This asks how much.
 *
 * Read-only, against the shipped tiles.
 */
import fs from 'node:fs'; import path from 'node:path';
const R = 6378137;
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : e.name.endsWith('.bin') && files.push(p);
  }
})('backend/tiles/barcelona');

const ways = new Map();
for (const f of files) {
  const b = fs.readFileSync(f), hl = b.readUInt32LE(0);
  let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  for (const r of h.roads || []) {
    if (ways.has(r.id) || r.pointsOffset === undefined || r.pointCount < 3) continue;
    if (!DRIVABLE.has(r.highwayType)) continue;
    const p = new Float32Array(ab, r.pointsOffset, r.pointCount * 3), pts = [];
    for (let i = 0; i < r.pointCount; i++) {
      const lat = (2 * Math.atan(Math.exp(p[i*3+2] / R)) - Math.PI / 2) * (180 / Math.PI);
      pts.push({ x: p[i*3] * Math.cos(lat * Math.PI / 180), z: p[i*3+2] });
    }
    ways.set(r.id, { type: r.highwayType, pts });
  }
}

// ── Turn angle at every interior vertex ───────────────────────────────────────────────────────
const BINS = [0, 2, 5, 10, 20, 30, 45, 60, 90, 180];
const hist = new Array(BINS.length - 1).fill(0);
let verts = 0, interior = 0, totalLenM = 0;
let extra6 = 0, extra10 = 0, extra15 = 0;
const worst = [];

for (const w of ways.values()) {
  const p = w.pts;
  verts += p.length;
  for (let i = 0; i < p.length - 1; i++) totalLenM += Math.hypot(p[i+1].x - p[i].x, p[i+1].z - p[i].z);
  for (let i = 1; i < p.length - 1; i++) {
    const ax = p[i].x - p[i-1].x, az = p[i].z - p[i-1].z;
    const bx = p[i+1].x - p[i].x, bz = p[i+1].z - p[i].z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 0.01 || lb < 0.01) continue;
    interior++;
    const dot = Math.max(-1, Math.min(1, (ax*bx + az*bz) / (la * lb)));
    const deg = Math.acos(dot) * 180 / Math.PI;
    for (let k = 0; k < hist.length; k++) if (deg >= BINS[k] && deg < BINS[k+1]) { hist[k]++; break; }
    // Extra vertices to cap each turn at N degrees per step (arc subdivision).
    if (deg > 6)  extra6  += Math.ceil(deg / 6) - 1;
    if (deg > 10) extra10 += Math.ceil(deg / 10) - 1;
    if (deg > 15) extra15 += Math.ceil(deg / 15) - 1;
    if (deg > 25) worst.push({ deg, shorter: Math.min(la, lb) });
  }
}

const pct = (n) => ((n / interior) * 100).toFixed(1) + '%';
console.log(`\nDrivable ways: ${ways.size} · vertices ${verts.toLocaleString()} · interior corners ${interior.toLocaleString()}`);
console.log(`Total drivable length: ${(totalLenM / 1000).toFixed(1)} km · mean segment ${(totalLenM / (verts - ways.size)).toFixed(1)} m\n`);
console.log('Turn angle at each interior vertex:');
for (let k = 0; k < hist.length; k++) {
  const bar = '#'.repeat(Math.round((hist[k] / interior) * 60));
  console.log(`  ${String(BINS[k]).padStart(3)}-${String(BINS[k+1]).padEnd(3)} deg  ${String(hist[k]).padStart(7)}  ${pct(hist[k]).padStart(6)}  ${bar}`);
}
const visible = hist.slice(3).reduce((a, b) => a + b, 0);   // >= 10 deg
console.log(`\nCorners >= 10 deg (the ones you can SEE as a kink): ${visible.toLocaleString()} (${pct(visible)})`);
console.log(`Corners >= 30 deg (genuine junctions/turns):        ${hist.slice(5).reduce((a,b)=>a+b,0).toLocaleString()}`);

console.log('\nCost of smoothing — extra vertices to cap every turn at:');
for (const [lbl, n] of [['6 deg', extra6], ['10 deg', extra10], ['15 deg', extra15]]) {
  console.log(`  ${lbl.padEnd(7)} +${n.toLocaleString().padStart(9)} verts  = +${((n / verts) * 100).toFixed(1)}% road vertices`);
}
worst.sort((a, b) => b.deg - a.deg);
const med = worst.length ? worst[Math.floor(worst.length / 2)] : null;
if (med) console.log(`\nOf the ${worst.length.toLocaleString()} corners > 25 deg, median shorter leg is ${med.shorter.toFixed(1)} m` +
  ` — that is the room a fillet has to work in.`);

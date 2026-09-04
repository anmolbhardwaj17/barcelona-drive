#!/usr/bin/env node
/**
 * coastlineProbe.mjs — where IS the shoreline, according to the baked tiles?
 *
 * ═══ WHY ════════════════════════════════════════════════════════════════════════════════════════
 * `coastline.js` defines the Mediterranean with a HAND TRACE, because the bake ships no open-sea
 * polygon and the DEM puts the sea at 2–5.8 m. That trace is accurate to "~±100 m; nudge points
 * when a screenshot shows the waterline off" — and a user screenshot at Passeig Marítim de la Mar
 * Bella showed the sea covering several blocks of Diagonal Mar.
 *
 * Nudging by eye is how the trace got wrong in the first place. The tiles DO carry
 * `natural=coastline` as polyline water features (`pbfWater.js:185`), so the real shoreline is
 * measurable. This prints it, and prints how far the hand trace sits from it at each of its own
 * points — so a correction is a number, not a guess.
 *
 * Usage:  node backend/tools/coastlineProbe.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILE_DIR = path.join(HERE, '..', 'tiles', 'barcelona');

// ⚠ WATER POLYGONS ARE STORED AS ABSOLUTE MERCATOR, not world. `readFloat32Pairs` subtracts the
// tile origin and applies MERCATOR_UNSTRETCH only because the worker passes it ox/oy; the bytes on
// disk are raw. The first run of this probe read them as world coordinates and reported the
// Barcelona coastline at 14°S — which is the signature of a coordinate-space mistake, not of bad
// data, and is the same class of error as N-7 and N-25 in this codebase.
//
// Inverting Mercator directly on the stored values needs no origin at all, so there is nothing left
// to get wrong.
const R = 6378137;
const toLatLon = (mx, my) => ({
  lat: (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI,
  lon: (mx / R) * 180 / Math.PI,
});
const toMerc = (lat, lon) => ({
  x: R * (lon * Math.PI / 180),
  y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)),
});
// Mercator metres → ground metres at Barcelona's latitude.
const GROUND = Math.cos(41.39 * Math.PI / 180);

function readWater(file) {
  const b = fs.readFileSync(file);
  const headerLen = b.readUInt32LE(0);
  let end = 4 + headerLen;
  while (end > 4 && b[end - 1] === 0) end--;
  let header;
  try { header = JSON.parse(b.slice(4, end).toString('utf8')); } catch { return []; }
  const binOffset = 4 + headerLen;
  const out = [];
  for (const w of header.water || []) {
    if (w.type !== 'coastline' || !w.polygonCount) continue;
    const a = new Float32Array(b.buffer, b.byteOffset + binOffset + w.polygonOffset, w.polygonCount * 2);
    const pts = [];
    for (let i = 0; i < w.polygonCount; i++) pts.push({ x: a[i * 2], z: a[i * 2 + 1] });   // raw Mercator
    out.push({ id: w.id, closed: w.closed, pts });
  }
  return out;
}

// Tiles are nested z/x/y.bin — a flat readdir finds only citymap.bin, which is how the first run of
// this probe concluded "NO COASTLINE IN THE TILES" from a sample of one file.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.bin') && e.name !== 'citymap.bin') out.push(full);
  }
  return out;
}
const files = walk(TILE_DIR);
let ways = [], tilesWith = 0;
for (const f of files) {
  let w = [];
  try { w = readWater(f); } catch { continue; }
  if (w.length) { tilesWith++; ways = ways.concat(w); }
}
// Dedupe by id — noClipTileStrategy hands the same way to every tile it touches.
const byId = new Map();
for (const w of ways) if (!byId.has(w.id)) byId.set(w.id, w);
const uniq = [...byId.values()];
const len = (p) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z) * GROUND; return l; };
const total = uniq.reduce((s, w) => s + len(w.pts), 0);

console.log(`tiles: ${files.length}, with coastline: ${tilesWith}`);
console.log(`coastline ways: ${ways.length} raw, ${uniq.length} unique, ${(total / 1000).toFixed(2)} km total`);
if (!uniq.length) { console.log('\nNO COASTLINE IN THE TILES — the hand trace is the only sea signal there will ever be.'); process.exit(0); }
uniq.sort((a, b) => len(b.pts) - len(a.pts));
for (const w of uniq.slice(0, 8)) {
  const a = toLatLon(w.pts[0].x, w.pts[0].z), b = toLatLon(w.pts.at(-1).x, w.pts.at(-1).z);
  console.log(`  way ${w.id}: ${w.pts.length} pts, ${(len(w.pts) / 1000).toFixed(2)} km  `
    + `${a.lat.toFixed(4)},${a.lon.toFixed(4)} → ${b.lat.toFixed(4)},${b.lon.toFixed(4)}`);
}

// ── how far is the hand trace from the real shore, at each of its own points? ──
const HAND = [
  [41.4210, 2.2300], [41.4110, 2.2210], [41.4040, 2.2120], [41.3985, 2.2060], [41.3935, 2.2020],
  [41.3878, 2.1990], [41.3855, 2.1965], [41.3810, 2.1945], [41.3765, 2.1920], [41.3722, 2.1905],
  [41.3688, 2.1898], [41.3672, 2.1870], [41.3665, 2.1820], [41.3630, 2.1750], [41.3585, 2.1690],
  [41.3510, 2.1610], [41.3420, 2.1530], [41.3300, 2.1430], [41.3180, 2.1320],
];
const all = [];
for (const w of uniq) for (const p of w.pts) all.push(p);
console.log('\nhand-trace point → nearest real coastline point (metres, and the real lat/lon):');
for (const [lat, lon] of HAND) {
  const t = toMerc(lat, lon);
  let best = Infinity, bp = null;
  for (const p of all) { const d = (p.x - t.x) ** 2 + (p.z - t.y) ** 2; if (d < best) { best = d; bp = p; } }
  const d = Math.sqrt(best) * GROUND;
  const ll = toLatLon(bp.x, bp.z);
  const flag = d > 150 ? '   <<< OFF' : '';
  console.log(`  ${lat.toFixed(4)},${lon.toFixed(4)}  ${d.toFixed(0).padStart(5)} m   real ${ll.lat.toFixed(4)},${ll.lon.toFixed(4)}${flag}`);
}

/**
 * N-25 · HOW MANY BAKED TREES STAND IN A DRAWN CARRIAGEWAY, AND WHICH PRODUCER MADE THEM?
 *
 * The previous attempt deleted 99,715 trees and left the offender count at 4,029 — the IDENTICAL
 * absolute number. That is the signature of a guard that never fires (D-23). This measures the
 * offenders directly in the shipped tiles, and splits them by which coordinate space they were
 * baked in, so a fix can be aimed at the producer that actually makes them.
 *
 * WIDTH: uses the R-W1 baked road widths, never a re-derived constant — CLAUDE.md is explicit that
 * widths are read through the width model, not guessed.
 *
 * ⚠ TWO THRESHOLDS, AND ONLY ONE IS A DEFECT. Reporting against `kerbToKerbW` alone gives 73% of all
 * baked trees, which is not a finding — it is an artefact. `vegetationBaker` plants at
 * `ROAD_WIDTH_BY_TYPE/2 + 0.1..0.5`, and for a residential street that is 5.1-5.5 m against a baked
 * kerb at 5.2 m, so trees STRADDLE the kerb line by centimetres and a hard `< half` test counts most
 * of them. A tree 10 cm inside the kerb is a tree in the gutter, correctly planted and drawn on the
 * pavement edge. A tree inside `carriagewayW` is standing in a LANE. This reports both, plus how
 * deep the intrusion goes, so the fix can be aimed at the ones that are actually wrong.
 *
 * Read-only. Usage: node backend/tools/vegRoadAudit.mjs [tileLimit]
 */
import fs from 'node:fs';
import path from 'node:path';

const R = 6378137;
const ORIGIN_LAT = 41.350, ORIGIN_LON = 2.115;
const UNSTRETCH = Math.cos((ORIGIN_LAT * Math.PI) / 180);
const OX = R * (ORIGIN_LON * Math.PI / 180);
const OY = R * Math.log(Math.tan(Math.PI / 4 + (ORIGIN_LAT * Math.PI / 180) / 2));
const mercToWorld = (mx, my) => [(mx - OX) * UNSTRETCH, (my - OY) * UNSTRETCH];
const isMercator = (x) => x > 100000;

// ⚠ DRIVABLE ONLY. The first run counted footway (24,086), pedestrian (8,215) and cycleway (5,591)
// among the offenders — 63% of the total — because a street tree planted on a 2 m-wide footway is
// "inside" it. That is a tree on a pavement, which is where trees go. The ticket is trees standing
// in the ROAD. Same DRIVABLE set the junction and dead-end audits use.
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary',
  'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'living_street', 'service']);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bin')) files.push(p);
  }
})('backend/tiles/barcelona');

const limit = Number(process.argv[2] || 0) || files.length;
let inKerb = 0, inLane = 0, fromMerc = 0, fromWorld = 0, treesTested = 0, tiles = 0;
const byType = new Map();
const depths = [];   // metres INSIDE the driving surface, for the lane offenders

function distSqToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qz = az + dz * t;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

for (const f of files.slice(0, limit)) {
  const b = fs.readFileSync(f);
  const hl = b.readUInt32LE(0);
  let x = hl; while (x > 0 && b[4 + x - 1] === 0) x--;
  let h; try { h = JSON.parse(b.toString('utf8', 4, 4 + x)); } catch { continue; }
  const bv = h.bakedVegetation;
  if (!bv?.treePositionsCount || !h.roads?.length) continue;
  const ab = b.buffer.slice(b.byteOffset + 4 + hl, b.byteOffset + b.length);
  const tp = new Float32Array(ab, bv.treePositionsOffset, bv.treePositionsCount);
  tiles++;

  // Drawn carriageways, in WORLD metres, with their baked half-width.
  const lines = [];
  for (const r of h.roads) {
    if (r.tunnel || r.pointCount < 2 || !DRIVABLE.has(r.highwayType)) continue;
    // kerbToKerbW is what is actually PAVED; carriagewayW is the driving surface inside it.
    const kerb = Number(r.kerbToKerbW) || Number(r.width) || 0;
    const lane = Number(r.carriagewayW) || kerb;
    if (!(kerb > 0)) continue;
    const src = new Float32Array(ab, r.pointsOffset, r.pointCount * 3);
    const pts = new Float32Array(r.pointCount * 2);
    for (let i = 0; i < r.pointCount; i++) {
      const [wx, wz] = mercToWorld(src[i * 3], src[i * 3 + 2]);
      pts[i * 2] = wx; pts[i * 2 + 1] = wz;
    }
    lines.push({ pts, kerbHalf: kerb / 2, laneHalf: lane / 2, type: r.highwayType || '?' });
  }
  if (!lines.length) continue;

  for (let i = 0; i < tp.length; i += 2) {
    const merc = isMercator(tp[i]);
    // Put both producers into world so they are comparable — this is the step the baker omits.
    const [wx, wz] = merc ? mercToWorld(tp[i], tp[i + 1]) : [tp[i], tp[i + 1]];
    treesTested++;
    let bestKerb = false, bestLaneDepth = -1, bestType = null;
    for (const L of lines) {
      let d2 = Infinity;
      for (let j = 0; j + 1 < L.pts.length / 2; j++) {
        const q = distSqToSeg(wx, wz, L.pts[j * 2], L.pts[j * 2 + 1], L.pts[j * 2 + 2], L.pts[j * 2 + 3]);
        if (q < d2) d2 = q;
      }
      const d = Math.sqrt(d2);
      if (d < L.kerbHalf) bestKerb = true;
      const depth = L.laneHalf - d;                 // >0 means inside the DRIVING surface
      if (depth > bestLaneDepth) { bestLaneDepth = depth; bestType = L.type; }
    }
    if (bestKerb) inKerb++;
    if (bestLaneDepth > 0) {
      inLane++;
      depths.push(bestLaneDepth);
      if (merc) fromMerc++; else fromWorld++;
      byType.set(bestType, (byType.get(bestType) || 0) + 1);
    }
  }
}

console.log(`tiles measured          : ${tiles}`);
console.log(`baked trees tested      : ${treesTested}`);
console.log(`inside kerb-to-kerb (gutter included)  : ${inKerb}  (${(inKerb / treesTested * 100).toFixed(2)}%)  <- NOT the defect, see header`);
console.log(`INSIDE THE DRIVING SURFACE (the defect): ${inLane}  (${(inLane / treesTested * 100).toFixed(2)}%)`);
console.log(`  baked in MERCATOR (roadside producer)  : ${fromMerc}`);
console.log(`  baked in WORLD    (perimeter producer) : ${fromWorld}`);
depths.sort((a, b) => a - b);
const q = (n) => depths.length ? depths[Math.min(depths.length - 1, Math.floor(depths.length * n))].toFixed(2) : '-';
console.log(`  how deep into the lane: p50 ${q(0.5)} m · p90 ${q(0.9)} m · max ${depths.length ? depths[depths.length - 1].toFixed(2) : '-'} m`);
console.log('\nlane offenders by road type:');
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(6)}  ${t}`);
}

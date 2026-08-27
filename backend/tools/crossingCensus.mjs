#!/usr/bin/env node
/**
 * crossingCensus.mjs — P-R1 for M1 (implied-bridge), over the BAKED tiles.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════════
 *
 * `osm-repair-layer.md` §3 states the gate plainly: **"P-R1 gates everything: no repair rule is
 * written before its defect class has a count."** M1 has never had one. What we do know is the
 * imbalance, read off the v10 tiles: **47 roads tagged `bridge=yes` against 864 tagged `tunnel=yes`,
 * out of 39,142** — 0.12% of the city. A real city does not have eighteen times more tunnels than
 * bridges; every road that passes over another one is a bridge, tagged or not.
 *
 * That under-tagging is the recorded root cause of two things the user has reported: flyovers with
 * no railings (nothing marks them elevated, so `isElevatedGuardRailRoad` never fires) and roads that
 * appear to float or sink where they cross.
 *
 * ═══ WHAT IS COUNTED ════════════════════════════════════════════════════════════════════════════
 *
 * A **2D crossing** — two road polylines whose segments properly intersect. Then, because the tile
 * format does not carry node ids, the crossing is classified by whether the intersection point sits
 * on a VERTEX of both roads:
 *
 *   · vertex on both      → a real at-grade junction. Expected, not a defect.
 *   · mid-segment on one
 *     or both             → the ways cross without meeting. One is above the other, and SOMETHING
 *                           should say so. This is the M1 candidate set.
 *
 * Candidates are then split by what the data already says:
 *   `explained-bridge` / `explained-tunnel`  — one side is tagged; the stack is known.
 *   `explained-layer`                        — the two carry different `layer` values.
 *   `explained-ramp`                         — one side is a resolved ramp.
 *   `UNEXPLAINED`                            — nothing marks either as over or under. **M1.**
 *
 * ═══ LIMITS, STATED ═════════════════════════════════════════════════════════════════════════════
 *
 * · Tile-local. Roads are compared only against others in the same tile, so a crossing split across
 *   a tile seam is missed. This UNDER-counts; it cannot invent a defect.
 * · Vertex matching stands in for node sharing, at VERTEX_TOL. Douglas-Peucker can delete a shared
 *   vertex, which would show a real junction as a crossing — so `UNEXPLAINED` is an upper bound and
 *   the number to trust is its ORDER, not its last digit.
 * · Detection only. Zero repairs, zero writes to the tiles.
 *
 * Run: node tools/crossingCensus.mjs [--region barcelona] [--json out.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const REGION = argOf('--region', 'barcelona');
const JSON_OUT = argOf('--json', null);

/** Two roads count as meeting at a node if the crossing lands this close to a vertex of both. */
const VERTEX_TOL = 3.0;   // m — generous, so a real junction is not miscounted as a crossing

/** Classes that are actually carriageways. A footbridge over a road is a different (real) case. */
const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'unclassified', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/** Read a polyline section that follows the same {pointCount, pointsOffset} convention as roads. */
function readPolylines(header, buffer, byteOffset, binOffset, key) {
  const out = [];
  for (const r of header[key] || []) {
    if (!r.pointCount || r.pointCount < 2) continue;
    const a = new Float32Array(buffer, byteOffset + binOffset + r.pointsOffset, r.pointCount * 3);
    const pts = new Array(r.pointCount);
    for (let i = 0; i < r.pointCount; i++) pts[i] = { x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] };
    out.push({ ...r, pts });
  }
  return out;
}

function readTile(file) {
  const b = fs.readFileSync(file);
  const headerLen = b.readUInt32LE(0);
  let end = 4 + headerLen;
  while (end > 4 && b[end - 1] === 0) end--;   // trim the null padding
  let header;
  try { header = JSON.parse(b.slice(4, end).toString('utf8')); } catch { return null; }
  const binOffset = 4 + headerLen;
  const roads = [];
  for (const r of header.roads || []) {
    if (!r.pointCount || r.pointCount < 2) continue;
    const a = new Float32Array(b.buffer, b.byteOffset + binOffset + r.pointsOffset, r.pointCount * 3);
    const pts = new Array(r.pointCount);
    for (let i = 0; i < r.pointCount; i++) pts[i] = { x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] };
    roads.push({ ...r, pts });
  }
  let railways = [];
  try { railways = readPolylines(header, b.buffer, b.byteOffset, binOffset, 'railways'); } catch { /* section absent */ }
  return { header, roads, railways };
}

/** Proper segment intersection in the XZ plane. Returns the point, or null. */
function segIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x, d2z = p4.z - p3.z;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return null;              // parallel
  const ex = p3.x - p1.x, ez = p3.z - p1.z;
  const t = (ex * d2z - ez * d2x) / den;
  const u = (ex * d1z - ez * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;  // outside both segments
  return { x: p1.x + d1x * t, z: p1.z + d1z * t };
}

const bbox = (pts) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
};
const bboxOverlap = (a, b) => !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);

const nearVertex = (pts, q) => {
  for (const p of pts) {
    const dx = p.x - q.x, dz = p.z - q.z;
    if (dx * dx + dz * dz <= VERTEX_TOL * VERTEX_TOL) return true;
  }
  return false;
};

// ── walk the tiles ──────────────────────────────────────────────────────────────────────────────
const root = path.join(__dirname, '..', 'tiles', REGION, '16');
if (!fs.existsSync(root)) {
  console.error(`No baked tiles at ${root}`);
  process.exit(1);
}
const files = [];
for (const x of fs.readdirSync(root)) {
  const d = path.join(root, x);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d)) if (f.endsWith('.bin')) files.push(path.join(d, f));
}

const counts = {
  atGradeJunction: 0,
  explainedBridge: 0,
  explainedTunnel: 0,
  explainedLayer: 0,
  explainedRamp: 0,
  UNEXPLAINED: 0,
};
const examples = [];
const seenPair = new Set();
let tiles = 0, roadsSeen = 0;

for (const file of files) {
  const tile = readTile(file);
  if (!tile) continue;
  const roads = tile.roads.filter((r) => DRIVABLE.has(r.highwayType));
  if (roads.length < 2) continue;
  tiles++;
  roadsSeen += roads.length;
  const boxes = roads.map((r) => bbox(r.pts));

  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      if (roads[i].id === roads[j].id) continue;          // same way, split across the tile
      if (!bboxOverlap(boxes[i], boxes[j])) continue;
      const A = roads[i], B = roads[j];
      let hit = null;
      outer:
      for (let a = 0; a < A.pts.length - 1; a++) {
        for (let b = 0; b < B.pts.length - 1; b++) {
          hit = segIntersect(A.pts[a], A.pts[a + 1], B.pts[b], B.pts[b + 1]);
          if (hit) break outer;
        }
      }
      if (!hit) continue;

      const pairKey = A.id < B.id ? `${A.id}_${B.id}` : `${B.id}_${A.id}`;
      if (seenPair.has(pairKey)) continue;                // the same pair in two tiles
      seenPair.add(pairKey);

      if (nearVertex(A.pts, hit) && nearVertex(B.pts, hit)) { counts.atGradeJunction++; continue; }

      if (A.bridge || B.bridge)                     { counts.explainedBridge++; continue; }
      if (A.tunnel || B.tunnel)                     { counts.explainedTunnel++; continue; }
      if ((A.layer || 0) !== (B.layer || 0))        { counts.explainedLayer++; continue; }
      if (A.isRamp || B.isRamp)                     { counts.explainedRamp++; continue; }

      counts.UNEXPLAINED++;
      if (examples.length < 25) {
        examples.push({
          tile: tile.header.tileId,
          a: { id: A.id, type: A.highwayType, name: A.name || '' },
          b: { id: B.id, type: B.highwayType, name: B.name || '' },
          at: { x: +hit.x.toFixed(1), z: +hit.z.toFixed(1) },
        });
      }
    }
  }
}

const totalCrossings = Object.values(counts).reduce((a, b) => a + b, 0);
const defects = totalCrossings - counts.atGradeJunction;

console.log('');
console.log('=== M1 crossing census (P-R1, detection only) ===');
console.log(`  region ${REGION} · ${tiles} tiles · ${roadsSeen} drivable road records`);
console.log('');
console.log(`  road pairs that cross in 2D          : ${totalCrossings}`);
console.log(`    at-grade junction (vertex on both) : ${counts.atGradeJunction}`);
console.log(`    cross WITHOUT meeting              : ${defects}`);
console.log('');
console.log('  of those, what the data already explains:');
console.log(`    one side tagged bridge             : ${counts.explainedBridge}`);
console.log(`    one side tagged tunnel             : ${counts.explainedTunnel}`);
console.log(`    different layer values             : ${counts.explainedLayer}`);
console.log(`    one side a resolved ramp           : ${counts.explainedRamp}`);
console.log(`    ** UNEXPLAINED (M1)                : ${counts.UNEXPLAINED} **`);
if (defects > 0) {
  console.log(`    -> ${((counts.UNEXPLAINED / defects) * 100).toFixed(1)}% of crossings have nothing saying which road is on top`);
}
console.log('');
if (examples.length) {
  console.log('  examples:');
  for (const e of examples.slice(0, 12)) {
    console.log(`    ${e.tile}  ${e.a.type}#${e.a.id}${e.a.name ? ` (${e.a.name})` : ''}`
              + ` x ${e.b.type}#${e.b.id}${e.b.name ? ` (${e.b.name})` : ''}`);
  }
}
console.log('');
console.log('  ⚠ tile-local and vertex-matched — see the header. UNDER-counts across tile seams,');
console.log('    and UNEXPLAINED is an upper bound. Trust the order of magnitude, not the last digit.');

/**
 * ── ROAD x RAIL ─────────────────────────────────────────────────────────────────────────────────
 *
 * M1's definition is "a road crosses water/rail/a road below with no bridge tag". The road x road
 * half came back at 2 unexplained, so if M1 is real at all it is here. And unlike two roads, a road
 * and a railway crossing in 2D have no legitimate at-grade reading outside a level crossing: one of
 * them IS above the other, always.
 */
const railCounts = { explained: 0, UNEXPLAINED: 0 };
const railExamples = [];
const seenRailPair = new Set();

for (const file of files) {
  const tile = readTile(file);
  if (!tile || !tile.railways.length) continue;
  const roads = tile.roads.filter((r) => DRIVABLE.has(r.highwayType));
  if (!roads.length) continue;
  const rBoxes = roads.map((r) => bbox(r.pts));
  const kBoxes = tile.railways.map((k) => bbox(k.pts));

  for (let i = 0; i < roads.length; i++) {
    for (let j = 0; j < tile.railways.length; j++) {
      if (!bboxOverlap(rBoxes[i], kBoxes[j])) continue;
      const A = roads[i], K = tile.railways[j];
      let hit = null;
      railOuter:
      for (let a = 0; a < A.pts.length - 1; a++) {
        for (let b = 0; b < K.pts.length - 1; b++) {
          hit = segIntersect(A.pts[a], A.pts[a + 1], K.pts[b], K.pts[b + 1]);
          if (hit) break railOuter;
        }
      }
      if (!hit) continue;
      const key = `${A.id}_${K.id}`;
      if (seenRailPair.has(key)) continue;
      seenRailPair.add(key);

      const explained = A.bridge || A.tunnel || K.bridge || K.tunnel
        || (A.layer || 0) !== (K.layer || 0) || A.isRamp;
      if (explained) railCounts.explained++;
      else {
        railCounts.UNEXPLAINED++;
        if (railExamples.length < 12) {
          railExamples.push({
            tile: tile.header.tileId,
            road: `${A.highwayType}#${A.id}${A.name ? ` (${A.name})` : ''}`,
            rail: `${K.railwayType || 'rail'}#${K.id}`,
          });
        }
      }
    }
  }
}

console.log('  ROAD x RAIL (no legitimate at-grade reading outside a level crossing):');
console.log(`    crossings                          : ${railCounts.explained + railCounts.UNEXPLAINED}`);
console.log(`    explained by bridge/tunnel/layer   : ${railCounts.explained}`);
console.log(`    ** UNEXPLAINED                     : ${railCounts.UNEXPLAINED} **`);
if (railExamples.length) {
  console.log('    examples:');
  for (const e of railExamples.slice(0, 8)) console.log(`      ${e.tile}  ${e.road} x ${e.rail}`);
}
console.log('');

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(
    { region: REGION, tiles, roadsSeen, counts, examples, rail: railCounts, railExamples }, null, 2));
  console.log(`\n  wrote ${JSON_OUT}`);
}

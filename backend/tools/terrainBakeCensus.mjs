/**
 * P4-01 step 1 — MEASURE before deleting.
 *
 * The task claims deleting the baked terrain saves "−369 MB of tile payload". That number was
 * estimated during planning, and P4-01 is the highest-risk task in P4 (3.0 d, risk high, requires a
 * re-bake). Confirming what the baked terrain actually costs, and what it would cost to regenerate,
 * is the cheap half — and if the saving is materially smaller than claimed, the risk calculus
 * changes before any destructive work happens rather than after.
 *
 * Reads every baked tile, sums each section from the JSON header's own offsets/counts, and reports
 * the share bakedTerrain occupies. Reads only; writes nothing.
 *
 *   node backend/tools/terrainBakeCensus.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'tiles', 'barcelona');

function parseHeader(buf) {
  const headerLen = buf.readUInt32LE(0);
  let end = headerLen;
  while (end > 0 && buf[4 + end - 1] === 0) end--;
  return { header: JSON.parse(buf.toString('utf8', 4, 4 + end)), binOffset: 4 + headerLen };
}

/** Bytes a section occupies, from its *Offset/*Count pairs. Float32=4, Uint32=4, Uint16=2, Uint8=1. */
const WIDTH = { positions: 4, normals: 4, uvs: 4, indices: 4, elevations: 4 };
function sectionBytes(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node)) {
    if (k.endsWith('Count') && typeof v === 'number') {
      const base = k.slice(0, -5);
      n += v * (WIDTH[base] ?? 4);
    } else if (typeof v === 'object') n += sectionBytes(v);
  }
  return n;
}

const files = [];
for (const z of fs.readdirSync(ROOT)) {
  const zd = path.join(ROOT, z);
  if (!fs.statSync(zd).isDirectory()) continue;
  for (const x of fs.readdirSync(zd)) {
    const xd = path.join(zd, x);
    if (!fs.statSync(xd).isDirectory()) continue;
    for (const f of fs.readdirSync(xd)) if (f.endsWith('.bin')) files.push(path.join(xd, f));
  }
}

let totalFile = 0, totalTerrain = 0, totalElev = 0, withTerrain = 0;
const gridSizes = new Map();
const perTile = [];

for (const f of files) {
  const buf = fs.readFileSync(f);
  totalFile += buf.length;
  let header;
  try { ({ header } = parseHeader(buf)); } catch { continue; }
  const bt = header.bakedTerrain;
  const tb = sectionBytes(bt);
  const eb = sectionBytes(header.elevation ?? header.elevationGrid);
  if (bt) { withTerrain++; gridSizes.set(bt.gridSize, (gridSizes.get(bt.gridSize) ?? 0) + 1); }
  totalTerrain += tb; totalElev += eb;
  perTile.push({ f: path.relative(ROOT, f), file: buf.length, terrain: tb, elev: eb });
}

const MB = (b) => (b / 1048576).toFixed(1);
console.log(`tiles                    ${files.length}  (${withTerrain} carry bakedTerrain)`);
console.log(`total on disk            ${MB(totalFile)} MB`);
console.log(`bakedTerrain             ${MB(totalTerrain)} MB   ${(100 * totalTerrain / totalFile).toFixed(1)}% of payload`);
console.log(`elevation grid (kept)    ${MB(totalElev)} MB`);
console.log(`grid sizes               ${[...gridSizes].map(([g, n]) => `${g}:${n} tiles`).join('  ')}`);
console.log();
console.log('heaviest terrain sections:');
for (const t of perTile.sort((a, b) => b.terrain - a.terrain).slice(0, 5)) {
  console.log(`  ${MB(t.terrain).padStart(6)} MB terrain of ${MB(t.file).padStart(6)} MB tile   ${t.f}`);
}

/**
 * P4-01 step 2 — THE PROOF. Can bakedTerrain be regenerated from the elevation grid alone?
 *
 * P4-01 is "prove-then-delete", and this is the prove half. It must run BEFORE anything is deleted,
 * because the whole task rests on a claim that was never tested: that the 384.6 MB of baked terrain
 * (68.4% of tile payload, measured by terrainBakeCensus.mjs) is redundant with the 55.5 MB grid
 * that ships beside it.
 *
 * WHAT THE SPEC FEARED, AND WHY IT NO LONGER APPLIES. `bakeTerrainMesh` takes five arguments —
 * elevation, tunnelRoads, waterPolygons, approachRoads, crossTileApproaches — and the last one is a
 * cross-TILE dependency. A per-tile parser worker cannot see its neighbours, so if the mesh depended
 * on it, runtime regeneration would be impossible without a second pass. But buildRegion.js:1571
 * calls it as `bakeTerrainMesh(payload.elevation, [], null, [], null)`: every tunnel/water/approach
 * input is EMPTY, because the legacy tunnel carve was disabled when the authored trench moved into
 * the elevation grid itself (slice ②). In current practice the baker is a pure function of the grid.
 *
 * This harness does not take that on faith. It re-runs the real baker against each tile's own stored
 * grid and compares every float and index bit-for-bit against what shipped.
 *
 *   node backend/tools/terrainRegenProof.mjs [sampleCount]
 */
import fs from 'node:fs';
import path from 'node:path';
import { bakeTerrainMesh } from '../worldBuilder/terrainBaker.js';

const ROOT = path.join(import.meta.dirname, '..', 'tiles', 'barcelona');
const SAMPLE = Number(process.argv[2] ?? 20);

function readTile(file) {
  const buf = fs.readFileSync(file);
  const headerLen = buf.readUInt32LE(0);
  let end = headerLen;
  while (end > 0 && buf[4 + end - 1] === 0) end--;
  const header = JSON.parse(buf.toString('utf8', 4, 4 + end));
  const binOffset = 4 + headerLen;
  const ab = buf.buffer.slice(buf.byteOffset + binOffset, buf.byteOffset + buf.length);
  return { header, ab };
}

const f32 = (ab, o, n) => (o === undefined || !n ? null : new Float32Array(ab, o, n));
const u32 = (ab, o, n) => (o === undefined || !n ? null : new Uint32Array(ab, o, n));

/** First index where two typed arrays differ, or -1. NaN==NaN counts as equal (sea tiles carry them). */
function firstDiff(a, b) {
  if (!a && !b) return -1;
  if (!a || !b) return -2;
  if (a.length !== b.length) return -3;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return i;
  }
  return -1;
}

const files = [];
for (const z of fs.readdirSync(ROOT)) {
  const zd = path.join(ROOT, z);
  if (!fs.statSync(zd).isDirectory()) continue;
  for (const x of fs.readdirSync(zd)) {
    const xd = path.join(zd, x);
    if (!fs.statSync(xd).isDirectory()) continue;
    for (const fl of fs.readdirSync(xd)) if (fl.endsWith('.bin')) files.push(path.join(xd, fl));
  }
}
files.sort();

// Deterministic spread across the region, plus every tile carrying NaN normals (the sea tiles the
// spec calls out) so the sample is not accidentally all inland.
const stride = Math.max(1, Math.floor(files.length / SAMPLE));
const picked = new Set(files.filter((_, i) => i % stride === 0).slice(0, SAMPLE));

let nanTiles = 0;
for (const f of files) {
  const { header, ab } = readTile(f);
  const bt = header.bakedTerrain;
  if (!bt) continue;
  const n = f32(ab, bt.normalsOffset, bt.normalsCount);
  if (n && n.some(Number.isNaN)) { picked.add(f); nanTiles++; }
}

console.log(`${files.length} tiles, ${nanTiles} carry NaN normals (all force-included), sampling ${picked.size}\n`);

let pass = 0, fail = 0;
for (const f of [...picked].sort()) {
  const { header, ab } = readTile(f);
  const bt = header.bakedTerrain;
  const rel = path.relative(ROOT, f);
  if (!bt || !header.elevation) { console.log(`  SKIP  ${rel} — no bakedTerrain/elevation`); continue; }

  // `elevations` lives in the BINARY blob, not the JSON header — the header only carries the
  // offset/count pair. The baker guards on `Array.isArray(elevation.elevations)`, so rehydrate it.
  const el = header.elevation;
  const grid = f32(ab, el.elevationsOffset, el.elevationsCount);
  if (!grid) { console.log(`  SKIP  ${rel} — no elevation grid in the blob`); continue; }
  const elevation = { ...el, elevations: Array.from(grid) };

  // The real baker, the tile's own grid, and the arguments buildRegion.js:1571 actually passes.
  const regen = bakeTerrainMesh(elevation, [], null, [], null);
  if (!regen) { console.log(`  FAIL  ${rel} — baker returned null`); fail++; continue; }

  const checks = {
    positions: firstDiff(regen.positions, f32(ab, bt.positionsOffset, bt.positionsCount)),
    normals:   firstDiff(regen.normals,   f32(ab, bt.normalsOffset,   bt.normalsCount)),
    uvs:       firstDiff(regen.uvs,       f32(ab, bt.uvsOffset,       bt.uvsCount)),
    indices:   firstDiff(regen.indices,   u32(ab, bt.indicesOffset,   bt.indicesCount)),
  };
  const bad = Object.entries(checks).filter(([, v]) => v !== -1);
  if (!bad.length) { pass++; console.log(`  ok    ${rel}`); }
  else {
    fail++;
    console.log(`  FAIL  ${rel}`);
    for (const [k, v] of bad) {
      console.log(v === -2 ? `          ${k}: one side missing`
                : v === -3 ? `          ${k}: length differs`
                : `          ${k}: first difference at [${v}]`);
    }
  }
}
console.log(`\n${pass} bit-equal, ${fail} divergent`);
process.exit(fail ? 1 : 0);

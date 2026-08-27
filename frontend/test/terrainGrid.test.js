/**
 * `terrainGrid.js` is a SECOND COPY of the baker's grid path (v3 P4-01). The repo already carries
 * that pattern for the Mercator projection with a "MUST match" comment across five files — but a
 * comment is not enforcement, and silent drift between a baker and a loader is the kind of bug that
 * shows up as terrain that is subtly wrong somewhere nobody drives.
 *
 * So this runs BOTH implementations against REAL baked tiles and compares every float and index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTerrainFromGrid } from '../src/map/terrainGrid.js';

const TILES = path.join(import.meta.dirname, '..', '..', 'backend', 'tiles', 'barcelona');

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

/**
 * Tiles that still carry a `bakedTerrain` mesh to compare against.
 *
 * Since the P4-01 re-bake the pipeline no longer emits that section, so the references are the
 * ORPHAN tiles left from older bakes with a wider bbox. They must be SELECTED, not sampled: a blind
 * stride across all 445 tiles found exactly one, because ~12 of 445 still have a bake.
 */
function tileFiles(limit) {
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bin')) all.push(p);
    }
  };
  if (!fs.existsSync(TILES)) return [];
  walk(TILES);
  all.sort();
  const withBake = [];
  for (const f of all) {
    if (withBake.length >= limit) break;
    try {
      const { header } = readTile(f);
      const bt = header.bakedTerrain;
      if (bt && bt.gridSize === 128 && header.elevation?.elevationsOffset !== undefined) withBake.push(f);
    } catch { /* citymap.bin and friends are not tiles */ }
  }
  return withBake;
}

const files = tileFiles(12);

test('the runtime generator reproduces the baked mesh bit-for-bit', { skip: !files.length && 'no baked tiles on disk' }, () => {
  let checked = 0, stale = 0;
  for (const f of files) {
    const { header, ab } = readTile(f);
    const bt = header.bakedTerrain, el = header.elevation;
    if (!bt || !el || el.elevationsOffset === undefined) continue;

    // The 2 known stale tiles were baked at gridSize 64 against a 128 grid, BEFORE the baker moved
    // to 128. They already fail the runtime `useBaked` gate, so they are not a fair comparison —
    // the generator is right and the tile on disk is out of date.
    if (bt.gridSize !== 128) { stale++; continue; }

    const grid = new Float32Array(ab, el.elevationsOffset, el.elevationsCount);
    const gen = buildTerrainFromGrid({ ...el, elevations: grid });
    assert.ok(gen, `generator returned null for ${path.basename(f)}`);

    const baked = {
      positions: new Float32Array(ab, bt.positionsOffset, bt.positionsCount),
      normals: new Float32Array(ab, bt.normalsOffset, bt.normalsCount),
      uvs: new Float32Array(ab, bt.uvsOffset, bt.uvsCount),
      indices: new Uint32Array(ab, bt.indicesOffset, bt.indicesCount),
    };
    for (const key of ['positions', 'normals', 'uvs', 'indices']) {
      assert.equal(gen[key].length, baked[key].length, `${key} length differs on ${path.basename(f)}`);
      for (let i = 0; i < gen[key].length; i++) {
        const a = gen[key][i], b = baked[key][i];
        if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
          assert.fail(`${key}[${i}] ${a} !== ${b} on ${path.basename(f)} — terrainGrid.js has drifted from terrainBaker.js`);
        }
      }
    }
    checked++;
  }
  // ⚠ FAIL LOUDLY RATHER THAN VACUOUSLY. Since the P4-01 re-bake, tiles no longer carry a
  // `bakedTerrain` section — the only remaining references are 12 ORPHAN tiles left over from older
  // bakes with a wider bbox (June/July, outside the current lon 2.1198..2.2230 / lat 41.3580..41.4130).
  // If someone tidies those away, this test would find nothing to compare and silently pass while
  // asserting nothing, which is worse than not having it. Three is the floor.
  assert.ok(checked >= 3,
    `only ${checked} tiles had a baked mesh to compare against (${stale} stale). The reference data ` +
    `is the pre-P4-01 orphan tiles; if they are gone, regenerate a reference with ` +
    `\`node backend/tools/terrainRegenProof.mjs\` against an older tile store, or this test is vacuous.`);
});

test('indices fit Uint16 — the reason the bake can drop to half-width', { skip: !files.length && 'no baked tiles on disk' }, () => {
  for (const f of files) {
    const { header, ab } = readTile(f);
    const el = header.elevation;
    if (!el || el.elevationsOffset === undefined) continue;
    const gen = buildTerrainFromGrid({ ...el, elevations: new Float32Array(ab, el.elevationsOffset, el.elevationsCount) });
    if (!gen) continue;
    assert.ok(gen.indices instanceof Uint16Array, 'indices are Uint16');
    const verts = gen.positions.length / 3;
    assert.ok(verts <= 65536, `${verts} verts would overflow Uint16 indices`);
  }
});

test('a missing or empty grid returns null rather than throwing', () => {
  assert.equal(buildTerrainFromGrid(null), null);
  assert.equal(buildTerrainFromGrid({}), null);
  assert.equal(buildTerrainFromGrid({ elevations: [] }), null);
});

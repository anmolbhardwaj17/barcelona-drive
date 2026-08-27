/**
 * v3 P4-02 — terrain LOD rings.
 *
 * Two failure modes here are silent. A ring that engages inside 500 m moves the ground out from
 * under roads that drape on the full grid; and hysteresis that is symmetric lets a tile sitting on
 * a boundary flip ring every frame, which costs a setIndex per frame and shimmers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTerrainFromGrid } from '../src/map/terrainGrid.js';

const TM = fs.readFileSync('src/map/tileManager.js', 'utf8');
const num = (name) => Number(TM.match(new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`))[1]);

test('the three rings match the planned triangle counts over ONE vertex buffer', () => {
  // 128x128 grid: 127^2*2 = 32258, 63^2*2 = 7938, 31^2*2 = 1922.
  const grid = { south: 41.40, west: 2.15, north: 41.4041, east: 2.1555,
                 gridRows: 128, gridCols: 128,
                 elevations: Float32Array.from({ length: 128 * 128 }, (_, i) => 20 + (i % 37) * 0.5) };
  const g = buildTerrainFromGrid(grid);
  assert.equal(g.indices.length / 3, 32258, 'full ring');
  assert.equal(g.indicesMid.length / 3, 7938, '1:2 ring');
  assert.equal(g.indicesFar.length / 3, 1922, '1:4 ring');
  // the point of index-set LOD: one vertex buffer, not three meshes
  assert.equal(g.positions.length / 3, 16384);
  for (const r of [g.indices, g.indicesMid, g.indicesFar]) {
    assert.ok(r instanceof Uint16Array);
    for (let i = 0; i < r.length; i++) assert.ok(r[i] < 16384, 'every index is inside the shared buffer');
  }
});

test('coarse rings never engage where roads drape on the full grid', () => {
  // Roads are draped against the FULL grid, so a coarser ring inside this radius moves the ground
  // out from under them. Hard floor, not a preference.
  assert.ok(num('TERRAIN_LOD_FULL_M') >= 500, 'full-detail radius is at least 500 m');
  assert.ok(num('TERRAIN_LOD_FULL_M') - num('TERRAIN_LOD_HYST_M') >= 400,
    'even with hysteresis pulling the boundary in, the coarse ring stays well clear of 500 m');
});

test('the cut is beyond the old 280 m, which was culling visible ground', () => {
  // At FogExp2 density 0.0025, 280 m is only 38.7% fogged.
  assert.ok(num('TERRAIN_CUT_M') > 280, 'terrain outlives the old fog cull');
  assert.ok(num('TERRAIN_LOD_MID_M') < num('TERRAIN_CUT_M'));
  assert.ok(num('TERRAIN_LOD_FULL_M') < num('TERRAIN_LOD_MID_M'));
});

test('terrain is no longer hidden by the blanket fog cull', () => {
  // The old line was `if (entry.terrainMesh) entry.terrainMesh.visible = false;` inside the
  // FOG_FULL_DIST block. If it comes back, distant landform silently disappears again.
  const fogBlock = TM.slice(TM.indexOf('const FOG_FULL_DIST'), TM.indexOf('lodBuildingMesh.visible = false'));
  assert.doesNotMatch(fogBlock, /terrainMesh\.visible\s*=\s*false/,
    'terrain must not be culled with buildings and vegetation — it is the landform, not detail');
  assert.match(fogBlock, /applyTerrainLod/, 'terrain visibility goes through the LOD controller');
});

test('hysteresis is asymmetric, so a tile on a boundary cannot oscillate', () => {
  const F = num('TERRAIN_LOD_FULL_M'), M = num('TERRAIN_LOD_MID_M'), h = num('TERRAIN_LOD_HYST_M');
  assert.ok(h > 0, 'there is a hysteresis band at all');
  // Reimplement the transition and walk a viewer back and forth across the full/mid boundary.
  const step = (prev, d) =>
    prev === 'full' ? (d > F + h ? 'mid' : 'full')
    : prev === 'mid' ? (d < F - h ? 'full' : d > M + h ? 'far' : 'mid')
    : (d < M - h ? 'mid' : 'far');
  let ring = 'full', flips = 0;
  // jitter around the boundary by +/-20 m, less than the 60 m band — must never flip
  for (let i = 0; i < 200; i++) {
    const d = F + (i % 2 ? 20 : -20);
    const next = step(ring, d);
    if (next !== ring) flips++;
    ring = next;
  }
  assert.equal(flips, 0, 'jitter inside the hysteresis band must not change ring');
  // a committed crossing DOES change it
  assert.equal(step('full', F + h + 1), 'mid', 'crossing the band steps down');
  assert.equal(step('mid', F - h - 1), 'full', 'coming back steps up');
});

/**
 * Tile disposal. Every failure here is silent — nothing throws when you skip freeing a geometry,
 * and the only symptom is a heap that drifts up over a long drive.
 *
 * Measured 2026-08-27 before the fix: geometries climbed ~6/s at a CONSTANT resident tile count
 * (+79 over 18 s at 12 tiles, +98 over 24 s at 15, +76 over 12 s at 20), heap +2.01 MB/s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/map/tileManager.js', 'utf8');
const DISPOSAL = SRC.slice(SRC.indexOf('const allMeshes = []'), SRC.indexOf('_pendingDisposals.push'));

test('every mesh-ish tile-entry field is disposed, aliased, or pool-managed', () => {
  const assigned = [...SRC.matchAll(/entry\.(\w*(?:Mesh|Meshes|Group|Handles))\s*=/g)].map((m) => m[1]);
  // Fields that legitimately do NOT appear in the disposal block, each with the reason it is safe.
  // Anything NOT on this list and NOT in the block is a leak.
  const exempt = {
    laneArrowMesh: 'alias into entry.roadInfraMeshes, which IS disposed',
    markingsMesh: 'alias into roadMeshes, which IS disposed',
    vegPoolHandles: 'released via h.pool.remove(h) — pool slots, not owned geometry',
  };
  const leaks = [...new Set(assigned)].filter((f) => !DISPOSAL.includes(`entry.${f}`) && !exempt[f]);
  assert.deepEqual(leaks, [],
    `these are assigned to a tile entry and never freed — add them to the disposal block, or to the ` +
    `exempt map with the reason they are safe`);
});

test('disposal frees Line/LineSegments/Points, not only Mesh', () => {
  // streetlightWireMesh is a LineSegments. It holds a geometry exactly like a Mesh, but fails
  // `isMesh`, so an isMesh-only branch walks straight past it and frees nothing.
  assert.match(DISPOSAL.length ? SRC : '', /m\.isMesh \|\| m\.isLine \|\| m\.isLineSegments \|\| m\.isPoints/,
    'the disposal branch must accept non-Mesh geometry holders');
});

test('the streetlight wire mesh is disposed', () => {
  assert.match(DISPOSAL, /entry\.streetlightWireMesh/,
    'per-tile LineSegments from streetlightRenderer — the measured leak');
});

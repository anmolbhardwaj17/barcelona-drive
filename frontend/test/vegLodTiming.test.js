/**
 * The LOD must be re-invalidated AFTER vegetation is materialized, not only when the tile entry is
 * created. Tree handles are added with startVisible = true, so between "vegetation landed" and
 * "an LOD pass ran" a tile draws every tree at full density regardless of distance — and the pass
 * only runs once the viewer has moved 15 m.
 *
 * The symptom is a pop in BOTH directions and it is easy to misread as an LOD-distance problem:
 * trees appear as you cross into a tile, then thin as you approach. User-reported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/map/tileManager.js', 'utf8');

test('the LOD is invalidated after vegetation is materialized, not just at tile creation', () => {
  const vegLanded = SRC.indexOf("(zoneResult.poolHandles || []).forEach");
  assert.ok(vegLanded > 0, 'zone vegetation handles are pushed somewhere');
  // the invalidation must appear AFTER vegetation, not only in the entry-creation block above it
  const after = SRC.slice(vegLanded, vegLanded + 2000);
  assert.match(after, /_lastLodX = -Infinity/,
    'vegetation lands at the END of the build; the entry-creation invalidation has already run by then');
});

test('the entry-creation invalidation is still there too', () => {
  // Both are needed: one covers meshes built early, the other vegetation built late.
  const hits = SRC.match(/_lastLodX = -Infinity/g) || [];
  assert.ok(hits.length >= 2, `expected at least 2 invalidation points, found ${hits.length}`);
});

test('trees are still added visible — the fix is the invalidation, not the default', () => {
  // If someone "fixes" this by adding trees hidden instead, a tile built between LOD passes shows
  // NOTHING until the viewer moves 15 m, which is worse. Keep the default and invalidate promptly.
  const pools = fs.readFileSync('src/map/vegPools.js', 'utf8');
  assert.match(pools, /startVisible = true/, 'add() still defaults to visible');
});

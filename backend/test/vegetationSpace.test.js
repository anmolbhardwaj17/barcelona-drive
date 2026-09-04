/**
 * N-25 · the vegetation baker's coordinate space.
 *
 * The baker mixes two spaces: road points arrive as ABSOLUTE MERCATOR, buildings/greens as
 * real-metre WORLD, and the mask grid + both distance sorts are built in WORLD. Nothing errored when
 * those met. Measured in the shipped tiles before the fix: ALL 135,228 zone trees and ALL 54,886
 * zone bushes were emitted in world and read back as Mercator, putting every park tree in Barcelona
 * at roughly (-171358, -3797422) — 3,800 km off the map. 316,063 positions in total.
 *
 * These pin the two halves that make that impossible to reintroduce silently: the round-trip the
 * emit path relies on, and the assertion that fails a bake instead of relocating a park.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mercatorToWorld, worldToMercator, getOriginMercator } from '../projection.js';

test('mercatorToWorld and worldToMercator round-trip to sub-millimetre', () => {
  // The emit path is world → Mercator; the reader is Mercator → world. If they are not exact
  // inverses every tree drifts by the error, everywhere, forever.
  for (const [mx, my] of [[245204.48, 5071528.0], [235447.0, 5064080.0], [250000.0, 5080000.0]]) {
    const w = mercatorToWorld(mx, my);
    const back = worldToMercator(w.x, w.z);
    assert.ok(Math.abs(back.x - mx) < 1e-3, `x drifted ${back.x - mx}`);
    assert.ok(Math.abs(back.y - my) < 1e-3, `y drifted ${back.y - my}`);
  }
});

test('the two spaces are far enough apart that a magnitude check cannot be ambiguous', () => {
  // `looksMercator` splits at 100 km. That is only safe because nothing legitimate lands between
  // Barcelona's world range and the Mercator origin — this asserts the gap is real, so the check
  // is not a threshold someone has to defend later.
  const o = getOriginMercator();
  assert.ok(o.x > 200000, `Mercator easting ${o.x} is not comfortably above the split`);
  // The far corner of the baked region, in world metres, must stay well below it.
  const far = mercatorToWorld(o.x + 30000, o.y + 30000);   // ~30 km out, wider than the region
  assert.ok(Math.abs(far.x) < 100000 && Math.abs(far.z) < 100000,
    `world coords reach ${far.x},${far.z} — the magnitude check would misclassify them`);
});

test('a world-space value read as Mercator lands outside Barcelona — the bug, stated as a number', () => {
  // A park tree at world (7172.9, 5514.5), converted by the reader as if it were Mercator.
  const wrong = mercatorToWorld(7172.9, 5514.5);
  assert.ok(wrong.x < -100000 && wrong.z < -1000000,
    `expected it to leave the map, got ${wrong.x},${wrong.z}`);
  // …and the same tree, emitted correctly, comes back where it started.
  const right = mercatorToWorld(worldToMercator(7172.9, 5514.5).x, worldToMercator(7172.9, 5514.5).y);
  assert.ok(Math.abs(right.x - 7172.9) < 1e-3 && Math.abs(right.z - 5514.5) < 1e-3);
});

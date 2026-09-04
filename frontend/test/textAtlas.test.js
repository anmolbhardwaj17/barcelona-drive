/**
 * P4-11 · the bounded text page.
 *
 * This exists to replace three UNBOUNDED CanvasTexture caches keyed by street name — 1.00 MB per
 * distinct name for direction boards, 0.50 MB for gantries, never evicted, marked `sharedMaterial`
 * so the tile-unload walk skips them. 2,427 distinct street names exist in the region, so the cost
 * is a function of how long you play, against a 200 MiB budget for all textures.
 *
 * The page is fixed at 2 MB. The part that can be subtly wrong is the eviction policy, so it is
 * pure integer arithmetic here and the GPU upload is a thin caller on top.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextAtlas, CELL_COUNT, COLS, PAGE_W, PAGE_H } from '../src/map/signage/textAtlas.js';

test('the page is fixed-size, and that is the whole point', () => {
  const a = createTextAtlas();
  assert.equal(a.capacity, 128);
  assert.equal(a.bytes(), 2 * 1024 * 1024, 'R8 2048x1024 = 2 MB');
  // For scale: the cache this replaces costs 1.00 MB for ONE direction board texture.
  assert.ok(a.bytes() < 3 * 1024 * 1024);
});

test('a repeated name reuses its cell instead of allocating a second', () => {
  const a = createTextAtlas();
  const first = a.acquire('Carrer d\'Aragó', 50);
  assert.equal(first.fresh, true, 'first acquire must ask the caller to draw');
  const second = a.acquire('Carrer d\'Aragó', 60);
  assert.equal(second.fresh, false, 'a hit must not ask for a redraw');
  assert.equal(second.cell, first.cell);
  assert.equal(a.size, 1);
});

test('UVs address the right rectangle and stay inside the page', () => {
  const a = createTextAtlas();
  for (let i = 0; i < CELL_COUNT; i++) {
    const s = a.acquire('name' + i, i);
    assert.ok(s.u0 >= 0 && s.u1 <= 1 && s.v0 >= 0 && s.v1 <= 1, `cell ${i} UVs out of range`);
    assert.ok(s.x >= 0 && s.x < PAGE_W && s.y >= 0 && s.y < PAGE_H);
    assert.equal(s.x, (s.cell % COLS) * 256);
  }
  assert.equal(a.size, CELL_COUNT, 'every cell should be usable');
});

test('when full, the FURTHEST sign is evicted — not the oldest', () => {
  // The distinction matters: a sign you drove past an hour ago but is still 20 m away is more worth
  // keeping than one 400 m ahead that you just asked for.
  const a = createTextAtlas();
  a.acquire('far-away', 900);
  for (let i = 1; i < CELL_COUNT; i++) a.acquire('near' + i, 10 + i);
  assert.equal(a.size, CELL_COUNT);

  const s = a.acquire('newcomer', 25);
  assert.ok(s && s.fresh, 'a nearer newcomer must get a cell');
  assert.equal(a.has('far-away'), false, 'the furthest resident should have been evicted');
  assert.ok(a.has('near5'), 'a nearby one must survive');
});

test('THE TRAP: a hit refreshes the distance, or the page fossilises', () => {
  // Without refreshing `dist` on a hit, an entry keeps the distance it had when first drawn. A sign
  // seen once at 5 m claims to be 5 m away forever, can never be evicted, and the page fills with
  // the first 128 names of the session — every later sign refused. Same failure as the unbounded
  // caches this replaces, just in less memory.
  const a = createTextAtlas();
  a.acquire('stale', 5);                         // drawn while very close
  for (let i = 1; i < CELL_COUNT; i++) a.acquire('other' + i, 100 + i);
  a.acquire('stale', 5000);                      // we have driven far away from it
  const s = a.acquire('newcomer', 50);
  assert.ok(s && s.fresh, 'newcomer refused — distances are not being refreshed');
  assert.equal(a.has('stale'), false, 'the now-distant sign should have been the eviction victim');
});

test('a request further away than everything resident is REFUSED, not thrashed in', () => {
  // Evicting a sign the player can read in order to draw one they cannot is strictly worse than
  // drawing nothing.
  const a = createTextAtlas();
  for (let i = 0; i < CELL_COUNT; i++) a.acquire('near' + i, 10 + i);
  const s = a.acquire('miles-away', 5000);
  assert.equal(s, null);
  assert.equal(a.size, CELL_COUNT, 'nothing should have been disturbed');
  assert.equal(a.stats().refused, 1);
});

test('clear() releases every cell', () => {
  const a = createTextAtlas();
  for (let i = 0; i < 40; i++) a.acquire('n' + i, i);
  a.clear();
  assert.equal(a.size, 0);
  assert.equal(a.acquire('n0', 1).fresh, true, 'after a clear, everything must be redrawn');
});

test('no two resident names ever share a cell', () => {
  // A collision would draw one street name over another and neither would be right.
  const a = createTextAtlas();
  const seen = new Set();
  for (let i = 0; i < CELL_COUNT; i++) {
    const s = a.acquire('n' + i, i);
    assert.equal(seen.has(s.cell), false, `cell ${s.cell} handed out twice`);
    seen.add(s.cell);
  }
});

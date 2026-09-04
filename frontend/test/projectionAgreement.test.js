/**
 * K-1 · one projection, checked — not four copies and a comment asking them to match.
 *
 * ORIGIN_LAT/ORIGIN_LON and MERCATOR_UNSTRETCH were declared in FIVE places: `projection.js`,
 * `tileParserWorker.js`, `vegetationWorker.js`, `buildingWorker.js` and `backend/projection.js`.
 * Each carried a comment saying "MUST match frontend/src/projection.js". A comment is a request, not
 * a guarantee: nothing verified it, and an origin that drifts between the main thread, a worker and
 * the bake moves geometry silently — no error, just everything slightly (or entirely) elsewhere.
 * That failure mode cost a full day in N-25.
 *
 * The three frontend copies are gone; they import now (`projection.js` is a leaf with no imports of
 * its own, so there was never a technical reason for them). The BAKE is a separate package and
 * cannot import across, so this test is what holds it — the bake and the renderer must agree or
 * every baked coordinate lands in the wrong place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as front from '../src/projection.js';
import * as back from '../../backend/projection.js';

test('the bake and the renderer share one projection origin', () => {
  const f = front.getOriginMercator();
  const b = back.getOriginMercator();
  assert.ok(Math.abs(f.x - b.x) < 1e-6, `origin easting differs by ${f.x - b.x} m`);
  assert.ok(Math.abs(f.y - b.y) < 1e-6, `origin northing differs by ${f.y - b.y} m`);
});

test('the bake and the renderer agree on Mercator→world for real Barcelona coordinates', () => {
  // The end-to-end property that actually matters: a point baked by one and read by the other must
  // land in the same place. Sub-millimetre, because float32 storage is ~1.2 mm at this range.
  for (const [mx, my] of [[240776.0, 5069682.0], [245204.5, 5071528.0], [238013.0, 5072888.0]]) {
    const f = front.mercatorToWorld(mx, my);
    const b = back.mercatorToWorld(mx, my);
    assert.ok(Math.abs(f.x - b.x) < 1e-3 && Math.abs(f.z - b.z) < 1e-3,
      `(${mx},${my}) → front (${f.x},${f.z}) vs back (${b.x},${b.z})`);
  }
});

test('no frontend file re-declares the projection origin', () => {
  // The three worker copies are deleted. This fails if one comes back — which is how it would come
  // back: a worker author reasoning "no three.js imports here" and not checking that projection.js
  // has none either.
  const files = ['src/map/tileParserWorker.js', 'src/workers/vegetationWorker.js',
                 'src/workers/buildingWorker.js'];
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^\s*const\s+ORIGIN_LAT\s*=/m, `${f} re-declares ORIGIN_LAT`);
    assert.doesNotMatch(src, /^\s*const\s+ORIGIN_LON\s*=/m, `${f} re-declares ORIGIN_LON`);
    assert.doesNotMatch(src, /Math\.cos\(\(?41\.35/, `${f} inlines cos(41.350) instead of importing`);
  }
});

/**
 * K-1b · the space check itself. It is the guard that would have caught N-25 at load time, so it
 * has to be right about the two things it can get wrong: a false alarm on real data, and silence on
 * the actual bug.
 */
import { looksMercator, checkSpace } from '../src/projection.js';

test('every real Barcelona coordinate is classified correctly, both spaces', () => {
  // World: the baked region spans roughly 0-13 km. Mercator: eastings ~235-250 k here.
  for (const w of [0, -35.2, 4005.1, 7177.7, 12999.0, 19999.0]) {
    assert.equal(looksMercator(w), false, `world ${w} misread as Mercator`);
  }
  for (const m of [235447.0, 240776.0, 245204.5, 250000.0]) {
    assert.equal(looksMercator(m), true, `Mercator ${m} misread as world`);
  }
});

test('the split has real headroom on both sides — it is not a threshold to argue about', () => {
  // The nearest world coord to the boundary is the far edge of the region; the nearest Mercator one
  // is the origin easting. Both must be far from 100 km or the check is a coin toss at the margin.
  const worldFar = front.mercatorToWorld(front.getOriginMercator().x + 30000, front.getOriginMercator().y);
  assert.ok(Math.abs(worldFar.x) < 30000, `world reaches ${worldFar.x}`);
  assert.ok(front.getOriginMercator().x > 200000, 'Mercator origin is too close to the split');
});

test('checkSpace returns false on the N-25 case and true on correct data', () => {
  // A park tree emitted in world and read as Mercator — the exact defect, as a number.
  assert.equal(checkSpace('test.zoneTree', 7172.9, true), false);
  // The same tree emitted correctly.
  assert.equal(checkSpace('test.zoneTreeFixed', 240776.0, true), true);
  // And the shops case, which must NOT be converted.
  assert.equal(checkSpace('test.shop', 7313.9, false), true);
});

test('checkSpace stays quiet on missing data instead of crying wolf', () => {
  // An absent array must not warn: a tile with no vegetation is normal, and a check that fires on
  // normal input gets switched off, after which it catches nothing.
  assert.equal(checkSpace('test.empty', undefined, true), true);
  assert.equal(checkSpace('test.nan', NaN, true), true);
});

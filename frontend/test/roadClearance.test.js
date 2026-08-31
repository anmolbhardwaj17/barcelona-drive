import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCarriagewaySegments, isOnCarriageway, pushOffCarriageway }
  from '../src/map/roadClearance.js';

// A crossroads meeting at the origin. Widths come from pavedWidth()'s type defaults —
// secondary 17.4 m, residential 10.4 m — not from the `width` field below (see the note at line 40).
const AVENUE = { highwayType: 'secondary', width: 20, layer: 0,
                 points: [{ x: -60, y: 0 }, { x: 60, y: 0 }] };
const STREET = { highwayType: 'residential', width: 14, layer: 0,
                 points: [{ x: 0, y: -60 }, { x: 0, y: 60 }] };
const FOOTWAY = { highwayType: 'footway', width: 3, layer: 0,
                  points: [{ x: -60, y: 30 }, { x: 60, y: 30 }] };

test('flattens only drivable roads', () => {
  const segs = buildCarriagewaySegments([AVENUE, STREET, FOOTWAY]);
  assert.equal(segs.length / 6, 2, 'the footway must not block a pole — poles stand ON pavements');
});

test('a point beside the avenue but inside the cross street is ON the carriageway', () => {
  const segs = buildCarriagewaySegments([AVENUE, STREET]);
  // 11 m up the Z axis: clear of the avenue (half-width 10), but dead centre of the cross street.
  assert.equal(isOnCarriageway(0, 11, segs), true,
    'this is the defect — offsetting from one road says clear while standing in the other');
  // The same offset well away from the junction is genuinely clear.
  assert.equal(isOnCarriageway(40, 11, segs), false);
});

test('layers do not block each other', () => {
  const tunnel = { ...STREET, layer: -1 };
  const segs = buildCarriagewaySegments([AVENUE, tunnel]);
  assert.equal(isOnCarriageway(0, 11, segs, 0), false, 'a tunnel below must not delete a surface pole');
  assert.equal(isOnCarriageway(0, 11, segs, -1), true);
});

test('push moves a blocked point clear, and reports how far', () => {
  const segs = buildCarriagewaySegments([AVENUE, STREET]);
  const r = pushOffCarriageway(0, 11, 1, 0, segs);   // preferred normal is along +X
  assert.ok(r, 'a crossroads corner is escapable');
  assert.equal(isOnCarriageway(r.x, r.z, segs), false);
  // ⚠ The fixture's `width: 14` is IGNORED. pavedWidth() reads the baked v10 section and falls back
  // to the type default — 10.4 m for residential — so the half-width is 5.2, not 7. A raw `width`
  // field on a road object is not what any of this measures.
  assert.ok(r.moved >= 5.5 && r.moved <= 6.5, `expected ~6 m to clear a 10.4 m street, got ${r.moved}`);
});

test('an already-clear point is returned untouched', () => {
  const segs = buildCarriagewaySegments([AVENUE, STREET]);
  const r = pushOffCarriageway(40, 11, 1, 0, segs);
  assert.deepEqual(r, { x: 40, z: 11, moved: 0 });
});

test('returns null rather than a wrong answer when nothing within reach is clear', () => {
  const wide = { highwayType: 'motorway', width: 200, layer: 0,
                 points: [{ x: -500, y: 0 }, { x: 500, y: 0 }] };
  const segs = buildCarriagewaySegments([wide]);
  assert.equal(pushOffCarriageway(0, 0, 1, 0, segs, 0, 0.35, 6), null);
});

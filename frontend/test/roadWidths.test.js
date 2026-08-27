/**
 * R-W1 — the frontend width accessor, and the anti-drift guard the old comments failed to be.
 *
 * Three separate files carried the comment "mirror of roadRenderer WIDTH_BY_TYPE" and none of them
 * actually matched it. A comment cannot enforce a mirror; a test can. `roadWidths.js` keeps ONE
 * fallback table for pre-v10 tiles, and the first test here re-derives it from the bake's own model
 * and fails if the two ever drift apart.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roadSection, pavedWidth, carriagewayWidth, kerbOffset, parkingBayOffset, parkingBayWidth,
  sidewalkWidth, corridorWidth, ROAD_WIDTH_FALLBACK, TYPICALLY_ONEWAY,
} from '../src/map/roadWidths.js';
import { computeRoadWidths } from '../../backend/worldBuilder/roads/roadWidthModel.js';

const CLASSES = Object.keys(ROAD_WIDTH_FALLBACK);

test('the fallback table still agrees with the bake model it was copied from', () => {
  // THE anti-drift test. If someone tunes roadWidthModel.js and not this table, a pre-v10 tile
  // silently renders a different city from a v10 one — which is exactly the failure mode the nine
  // hand-mirrored tables produced. The model is the authority; this table follows it.
  for (const t of CLASSES) {
    // Feed the model the TYPICAL way of this class. A motorway is 100% oneway in the measured data;
    // comparing against an untagged two-way one would be comparing against a road that never exists
    // (6 derived lanes, 21 m) and would force the fallback to ship a wrong number to satisfy a test.
    const oneway = TYPICALLY_ONEWAY.has(t);
    const model = computeRoadWidths({ highwayType: t, tags: oneway ? { oneway: 'yes' } : {}, oneway });
    const fb = roadSection({ highwayType: t });   // no baked fields → fallback path
    assert.equal(fb.baked, false, `${t}: this must exercise the FALLBACK, not a baked field`);
    assert.equal(fb.carriagewayW, model.carriagewayW,
      `${t}: fallback carriageway drifted from roadWidthModel.js — update ROAD_WIDTH_FALLBACK`);
    assert.equal(fb.kerbToKerbW, model.kerbToKerbW, `${t}: fallback kerb-to-kerb drifted`);
    assert.equal(fb.sidewalkW, model.sidewalkW, `${t}: fallback sidewalk drifted`);
  }
});

test('baked fields win over the fallback, and say so', () => {
  const road = {
    highwayType: 'residential',
    carriagewayW: 6, parkingLeftW: 2.2, parkingRightW: 2.2,
    shoulderW: 0, kerbToKerbW: 10.4, sidewalkW: 3, corridorW: 16.4,
  };
  const s = roadSection(road);
  assert.equal(s.baked, true);
  assert.equal(s.kerbToKerbW, 10.4);
  assert.equal(pavedWidth(road), 10.4);
  assert.equal(carriagewayWidth(road), 6);
});

test('a pre-v10 tile falls back instead of producing NaN', () => {
  // The v9 tiles on disk have `width` but none of the section fields. Every accessor must still
  // return a usable number — a NaN offset silently places geometry at the world origin.
  const v9 = { highwayType: 'residential', width: 4 };
  for (const fn of [pavedWidth, carriagewayWidth, kerbOffset, sidewalkWidth, corridorWidth]) {
    const v = fn(v9);
    assert.ok(Number.isFinite(v) && v > 0, `${fn.name} returned ${v} for a v9 road`);
  }
  assert.equal(roadSection(v9).baked, false);
});

test('a road record that is missing, empty or nonsense still yields a sane section', () => {
  for (const road of [undefined, null, {}, { highwayType: 'somethingNew' }, { carriagewayW: NaN },
                      { carriagewayW: -3 }, { highwayType: 'residential', carriagewayW: 'wide' }]) {
    const s = roadSection(road);
    assert.ok(Number.isFinite(s.kerbToKerbW) && s.kerbToKerbW > 0,
      `bad input ${JSON.stringify(road)} gave kerbToKerbW=${s.kerbToKerbW}`);
    assert.ok(s.corridorW >= s.kerbToKerbW);
  }
});

test('the section closes: paved == carriageway + parking + shoulders', () => {
  for (const t of CLASSES) {
    const s = roadSection({ highwayType: t });
    const sum = s.carriagewayW + s.parkingLeftW + s.parkingRightW + s.shoulderW * 2;
    assert.ok(Math.abs(s.kerbToKerbW - sum) < 0.02, `${t}: section does not close`);
    assert.ok(Math.abs(s.corridorW - (s.kerbToKerbW + s.sidewalkW * 2)) < 0.02, `${t}: corridor`);
  }
});

test('the paved surface is always at least the carriageway — never narrower', () => {
  // Drawing the ribbon at carriagewayW instead of kerbToKerbW leaves a strip of bare terrain
  // exactly where each street's parking lane should be. This pins the ordering that prevents it.
  for (const t of CLASSES) {
    const road = { highwayType: t };
    assert.ok(pavedWidth(road) >= carriagewayWidth(road), `${t}: paved must cover the lanes`);
    assert.ok(corridorWidth(road) >= pavedWidth(road), `${t}: corridor must cover the paving`);
  }
});

test('a parking bay lies between the running lanes and the kerb, on both sides', () => {
  // The user-reported "cars parked ON the guard rails", as an invariant on the accessor the
  // renderers actually call — not just on the bake model.
  for (const t of CLASSES) {
    const road = { highwayType: t };
    for (const side of ['left', 'right']) {
      const bay = parkingBayWidth(road, side);
      if (!bay) continue;
      const inner = parkingBayOffset(road, side) - bay / 2;
      const outer = parkingBayOffset(road, side) + bay / 2;
      assert.ok(inner >= carriagewayWidth(road) / 2 - 0.01,
        `${t}/${side}: a parked car must not stand in a running lane`);
      assert.ok(outer <= kerbOffset(road) + 0.01,
        `${t}/${side}: a parked car must not stand past the kerb, where the rail is`);
    }
  }
});

test('kerbOffset is exactly half the paved width, for every class', () => {
  // Stated as its own test because EVERY object at the kerb line — kerbs, rails, sidewalk inner
  // edges, streetlights — is placed from this one number. If it stops meaning "half the paving",
  // they all move together, which is at least honest; if a caller halves something else, they drift.
  for (const t of CLASSES) {
    const road = { highwayType: t };
    assert.equal(kerbOffset(road), pavedWidth(road) / 2, t);
  }
});

test('a motorway has no parking, no sidewalk, and real shoulders', () => {
  const m = roadSection({ highwayType: 'motorway' });
  assert.equal(m.parkingLeftW, 0);
  assert.equal(m.parkingRightW, 0);
  assert.equal(m.sidewalkW, 0);
  assert.ok(m.shoulderW > 0, 'an arcén is part of the paved width');
  assert.ok(m.kerbToKerbW > m.carriagewayW, 'and it widens the paving');
});

test('an Eixample residential street is ~10 m of paving, not 4 m', () => {
  // The headline regression, asserted through the accessor the renderers call.
  const r = roadSection({ highwayType: 'residential' });
  assert.ok(r.kerbToKerbW > 9 && r.kerbToKerbW < 12,
    `expected ~10 m of paving, got ${r.kerbToKerbW}`);
  assert.ok(r.parkingLeftW > 0 && r.parkingRightW > 0, 'both kerbs park');
});

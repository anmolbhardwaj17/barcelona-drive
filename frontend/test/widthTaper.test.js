/**
 * R-J1 — the width taper exists TWICE, and this is the guard that keeps the two honest.
 *
 * `backend/worldBuilder/roadBaker.js` bakes the road surface for 260 of 433 Barcelona tiles;
 * `frontend/src/map/roadRenderer.js` builds the ribbon at runtime for the other 173. Both carry
 * their own byte-for-byte copy of `buildJunctionWidthMap` + `computeTaperedWidths`, so the SAME
 * street tapers through one code path or the other depending only on which tile it landed in.
 * Nothing enforced that they agree — the identical R-W1 situation that produced nine disagreeing
 * width tables, and the "assume a second call site" pattern that bit four separate fixes in one day.
 *
 * A comment cannot enforce a mirror. This can. If someone tunes one taper and not the other, the
 * city silently renders two different road networks and the seam moves with the tile grid.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJunctionWidthMap as feMap,
  computeTaperedWidths as feTaper,
} from '../src/map/roadRenderer.js';
import {
  buildJunctionWidthMap as beMap,
  computeTaperedWidths as beTaper,
} from '../../backend/worldBuilder/roadBaker.js';

const TOL = 2;   // JUNCTION_TOLERANCE, identical in both files

/** A road record both sides understand: baked v10 section fields + a polyline. */
function road(id, highwayType, kerbToKerbW, points) {
  return {
    id, highwayType,
    kerbToKerbW, width: kerbToKerbW,
    carriagewayW: kerbToKerbW, parkingLeftW: 0, parkingRightW: 0, shoulderW: 0,
    sidewalkW: 0, corridorW: kerbToKerbW,
    points,
  };
}

/** Straight run of `n` points along +X, `spacing` apart, starting at x0. */
function line(x0, z, n, spacing) {
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * spacing, y: z }));
}

/**
 * The real Barcelona cases, measured off the shipped v10 tiles. The first is the single most
 * common width discontinuity in the city (219 nodes): a 4 m living_street meeting a 10.4 m
 * residential, which R-W1 created the day it widened residential from its 4 m MIN_WIDTH clamp.
 */
const GRAPHS = {
  'living_street 4 m → residential 10.4 m (219 nodes, the most common step)': [
    road(1, 'living_street', 4,    line(0, 0, 11, 10)),      // 100 m, ends at x=100
    road(2, 'residential',   10.4, line(100, 0, 11, 10)),    // starts where 1 ends
  ],
  'residential 10.4 m → tertiary 13.4 m': [
    road(1, 'residential', 10.4, line(0, 0, 9, 12)),
    road(2, 'tertiary',    13.4, line(96, 0, 9, 12)),
  ],
  'secondary 14.15 m → 17.4 m': [
    road(1, 'secondary', 14.15, line(0, 50, 7, 15)),
    road(2, 'secondary', 17.4,  line(90, 50, 7, 15)),
  ],
  'road too short for a full 20 m taper (taper clamps to half its length)': [
    road(1, 'service',     3.5,  line(0, 0, 3, 4)),          // 8 m long
    road(2, 'residential', 10.4, line(8, 0, 9, 12)),
  ],
  'both ends step — narrow road bridging two wide ones': [
    road(1, 'residential',   13.4, line(-100, 0, 11, 10)),
    road(2, 'living_street', 4,    line(0, 0, 6, 6)),         // 30 m between two wide roads
    road(3, 'residential',   13.4, line(30, 0, 11, 10)),
  ],
  'equal widths — neither side should taper at all': [
    road(1, 'residential', 10.4, line(0, 0, 9, 12)),
    road(2, 'residential', 10.4, line(96, 0, 9, 12)),
  ],
  'three-way node takes the widest arm': [
    road(1, 'residential',   10.4, line(0, 0, 9, 12)),
    road(2, 'secondary',     17.4, line(96, 0, 9, 12)),
    road(3, 'living_street', 4,    Array.from({ length: 9 }, (_, i) => ({ x: 96, y: i * 12 }))),
  ],
};

test('the bake and the runtime build the same junction width map', () => {
  for (const [name, roads] of Object.entries(GRAPHS)) {
    const fe = feMap(roads, TOL);
    const be = beMap(roads, TOL);
    assert.deepEqual(
      [...fe.keys()].sort(), [...be.keys()].sort(),
      `${name}: the two width maps disagree about WHICH nodes need a taper`,
    );
    for (const k of fe.keys()) {
      assert.deepEqual(fe.get(k), be.get(k), `${name}: node ${k} — min/max width disagree`);
    }
  }
});

test('the bake and the runtime taper every road identically', () => {
  for (const [name, roads] of Object.entries(GRAPHS)) {
    const fe = feMap(roads, TOL);
    const be = beMap(roads, TOL);
    for (const r of roads) {
      const a = feTaper(r, fe, TOL);
      const b = beTaper(r, be, TOL);
      assert.equal(a === null, b === null,
        `${name}: road ${r.id} — one path tapers and the other does not`);
      if (a === null) continue;
      assert.equal(a.length, b.length, `${name}: road ${r.id} — different point count`);
      for (let i = 0; i < a.length; i++) {
        assert.ok(Math.abs(a[i] - b[i]) < 1e-9,
          `${name}: road ${r.id} point ${i} — bake ${b[i]} vs runtime ${a[i]}`);
      }
    }
  }
});

test('a taper actually fires on a real step, and lands on both widths', () => {
  // Guards the guard: two implementations that both return null would pass the test above vacuously.
  const roads = GRAPHS['living_street 4 m → residential 10.4 m (219 nodes, the most common step)'];
  const map = feMap(roads, TOL);
  assert.equal(map.size, 1, 'exactly one node should need a taper');

  const widths = feTaper(roads[0], map, TOL);   // the 4 m living_street
  assert.ok(widths, 'the narrow road must taper');
  assert.ok(Math.abs(widths[0] - 4) < 1e-6, 'far end stays at its own 4 m');
  assert.ok(Math.abs(widths[widths.length - 1] - 10.4) < 1e-6,
    'the junction end reaches the wider neighbour, so the ribbons meet without a step');
  // Monotonic: a taper that oscillates would read as a bulge in the asphalt.
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1] - 1e-9, `taper must not narrow again at point ${i}`);
  }
});

test('equal widths produce no taper at all — the map is empty, not merely unused', () => {
  const roads = GRAPHS['equal widths — neither side should taper at all'];
  assert.equal(feMap(roads, TOL).size, 0);
  assert.equal(beMap(roads, TOL).size, 0);
  for (const r of roads) assert.equal(feTaper(r, feMap(roads, TOL), TOL), null);
});

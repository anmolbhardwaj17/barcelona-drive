/**
 * v3 P3-03 — building ring winding.
 *
 * Backface culling was switched on and REVERTED on 2026-07-06: "building geometry has inconsistent
 * triangle winding, so no single side renders every building right (FrontSide left some inside-out
 * as a giant flat plane; BackSide made others hollow)". Normalising at source is the prerequisite
 * that attempt was missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signedAreaXZ, normalizeRingWinding, extrudePolygonWallBands } from '../src/workers/workerGeometry.js';

const CCW = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const CW  = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];

test('signed area detects orientation and is sign-symmetric', () => {
  assert.ok(signedAreaXZ(CCW) > 0, 'CCW must be positive');
  assert.ok(signedAreaXZ(CW) < 0, 'CW must be negative');
  assert.equal(signedAreaXZ(CCW), -signedAreaXZ(CW), 'reversing a ring must only flip the sign');
  assert.equal(Math.abs(signedAreaXZ(CCW)), 100, 'a 10x10 square is 100 m^2');
});

test('a duplicated closing point does not corrupt the area', () => {
  const closed = [...CCW, { x: 0, y: 0 }];
  assert.equal(signedAreaXZ(closed), signedAreaXZ(CCW));
});

test('normalisation makes BOTH input orientations agree', () => {
  const a = normalizeRingWinding(CCW, false), b = normalizeRingWinding(CW, false);
  assert.ok(signedAreaXZ(a.points) < 0 && signedAreaXZ(b.points) < 0, 'both must end up CW');
  assert.equal(a.reversed, true, 'the CCW input had to be reversed');
  assert.equal(b.reversed, false, 'the CW input was already correct — do not churn it');
});

test('it does not mutate the caller\'s array', () => {
  const input = CCW.map((p) => ({ ...p }));
  const before = JSON.stringify(input);
  normalizeRingWinding(input, false);
  assert.equal(JSON.stringify(input), before, 'reversing in place would corrupt shared footprints');
});

test('COURTYARDS wind the OTHER way — the subtle one', () => {
  // An inner ring normalised to the outer ring's handedness faces its walls away from the courtyard.
  // The building still looks solid from the street, so this does not show up on a casual drive.
  const outer = normalizeRingWinding(CCW, false).points;   // walls face out
  const inner = normalizeRingWinding(CCW, true).points;    // walls face into the courtyard
  assert.ok(signedAreaXZ(outer) < 0 && signedAreaXZ(inner) > 0, 'outer and inner must be opposite');
});

test('a degenerate ring is left alone rather than reversed on float noise', () => {
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
  assert.equal(normalizeRingWinding(collinear, false).reversed, false);
  assert.equal(normalizeRingWinding([{ x: 0, y: 0 }, { x: 1, y: 1 }], false).reversed, false);
  assert.equal(normalizeRingWinding(null, false).points, null);
});

test('AFTER normalisation EVERY face points outward, whatever the input winding', () => {
  // The payoff. Before this, two identical buildings wound differently produced opposite normals,
  // which is what made a single side flag impossible.
  //
  // Note it is NOT valid to compare face 0 between the two: reversing a ring preserves the cycle but
  // changes which vertex is first, so face 0 is a different edge. An earlier version of this test
  // asserted that and failed for that reason, not because the geometry was wrong. The invariant that
  // actually matters is that no face points into the building.
  const opts = { hRepeatM: 12, groundH: 3.8, gFrac: 0.38, storeyH: 3.5, crownH: 1.2 };
  const CX = 5, CZ = 5;                                  // centroid of the 10x10 square
  for (const [label, ring] of [['CCW input', CCW], ['CW input', CW]]) {
    const g = extrudePolygonWallBands(normalizeRingWinding(ring, false).points, 21, 0, opts);
    const quads = g.positions.length / 12;
    for (let q = 0; q < quads; q++) {
      const p0x = g.positions[q * 12],     p0z = g.positions[q * 12 + 2];
      const p1x = g.positions[q * 12 + 3], p1z = g.positions[q * 12 + 5];
      const mx = (p0x + p1x) / 2, mz = (p0z + p1z) / 2;   // edge midpoint, not a corner
      const nx = g.normals[q * 12], nz = g.normals[q * 12 + 2];
      const dot = (mx - CX) * nx + (mz - CZ) * nz;
      assert.ok(dot > 0, `${label}: quad ${q} normal points INTO the building (dot ${dot.toFixed(2)})`);
    }
  }
});

test('an un-normalised ring genuinely produces inward normals — the bug is real', () => {
  // Guards against the fix being a no-op. Feed the extruder the wrong winding on purpose.
  const opts = { hRepeatM: 12, groundH: 3.8, gFrac: 0.38, storeyH: 3.5, crownH: 1.2 };
  const g = extrudePolygonWallBands(CCW, 21, 0, opts);    // CCW is the WRONG handedness here
  const mx = (g.positions[0] + g.positions[3]) / 2, mz = (g.positions[2] + g.positions[5]) / 2;
  const dot = (mx - 5) * g.normals[0] + (mz - 5) * g.normals[2];
  assert.ok(dot < 0, 'unnormalised CCW should point inward; if not, the normalisation fixes nothing');
});

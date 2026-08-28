/**
 * v3 P4-18 — the tunnel portal falloff.
 *
 * ⚠ WHY THIS IS GEOMETRY AND NOT A LIGHT, pinned here because the obvious implementation is wrong:
 * `lightGrid` computes `uLGEnabled = (_enabled && _isNight)`, so the entire grid is OFF during the
 * day — and a tunnel is dark at noon. Punctual portal lights would deliver the effect only at
 * night, the one time it is least needed. The falloff is therefore baked into vertex colour, which
 * describes how much of the OUTSIDE reaches a point, and that does not depend on the simulated
 * time of day.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../src/map/tunnelRenderer.js';

const { portalFalloff, PORTAL_LIT_M, DEEP_LIT } = __test__;

/** smoothstep returns 0.30000000000000004 for DEEP_LIT — compare with a tolerance, not ===. */
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('a point AT the mouth is fully lit', () => {
  assert.equal(portalFalloff(0), 1);
});

test('deep inside settles at the floor brightness, never zero', () => {
  // Zero would be a black hole with a lit strip floating in it; the strip is not the only light,
  // the mouth still contributes and the lining is never truly unlit.
  near(portalFalloff(PORTAL_LIT_M), DEEP_LIT, 'at the end of the range');
  near(portalFalloff(PORTAL_LIT_M * 5), DEEP_LIT, 'clamped, not extrapolated past the range');
  assert.ok(DEEP_LIT > 0, 'the deep floor must be lit at all');
});

test('brightness decreases monotonically with depth', () => {
  let prev = Infinity;
  for (let d = 0; d <= PORTAL_LIT_M; d += 2) {
    const v = portalFalloff(d);
    assert.ok(v <= prev + 1e-9, `brightness must not rise going inward (at ${d} m)`);
    prev = v;
  }
});

test('the curve is smooth at both ends — no visible band at the mouth or the deep end', () => {
  // A linear ramp terminates in a hard edge that reads as a painted line across the lining.
  // smoothstep has zero derivative at both ends; sample either end and confirm the step is small.
  const nearStep = portalFalloff(0) - portalFalloff(PORTAL_LIT_M * 0.05);
  const farStep = portalFalloff(PORTAL_LIT_M * 0.95) - portalFalloff(PORTAL_LIT_M);
  const midStep = portalFalloff(PORTAL_LIT_M * 0.45) - portalFalloff(PORTAL_LIT_M * 0.55);
  assert.ok(nearStep < midStep, 'must flatten at the mouth');
  assert.ok(farStep < midStep, 'must flatten at the deep end');
});

test('negative depth is clamped — a mouth quad must never read brighter than full', () => {
  assert.equal(portalFalloff(-5), 1);
});

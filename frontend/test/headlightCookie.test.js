/**
 * The dipped-beam pattern. Asserts the SHAPE, because the shape is the entire point: a headlight
 * without a hard horizontal cut-off reads as a game light no matter how it is tuned, and a cookie
 * that is subtly wrong (inverted, symmetric, cut in the wrong place) still renders a plausible glow
 * — so nothing fails, it just stops looking like a car.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beamIntensity } from '../src/car/headlightCookie.js';

test('there is a HARD cut-off — the defining feature of a dipped beam', () => {
  const below = beamIntensity(0, 0.0);
  const above = beamIntensity(0, 0.15);
  assert.ok(below > 0.8, `below the cut should be near full, got ${below.toFixed(3)}`);
  assert.ok(above < 0.1, `above the cut should be nearly dark, got ${above.toFixed(3)}`);
  assert.ok(below / above > 8, 'the transition must be sharp, not a gradient');
});

test('above the cut-off is dim but NOT zero', () => {
  // A real cut-off has a thin halo and some stray light. Hard zero reads as a cardboard cut-out
  // sliding over the world as the car moves.
  const glare = beamIntensity(0, 0.7);
  assert.ok(glare > 0.005 && glare < 0.06, `expected a faint halo, got ${glare.toFixed(4)}`);
});

test('ASYMMETRIC: the kerb side kicks up, the oncoming side does not', () => {
  // ECE dipped beam. This is why it does not blind oncoming traffic while still lighting signs.
  const kerb = beamIntensity(0.5, 0.2);
  const oncoming = beamIntensity(-0.5, 0.2);
  assert.ok(kerb > oncoming * 5,
    `kerb side ${kerb.toFixed(3)} must be far brighter than oncoming ${oncoming.toFixed(3)} at the same height`);
});

test('the hotspot sits just UNDER the cut-off, not in the middle of the cone', () => {
  const justUnder = beamIntensity(0, -0.05);
  const middle = beamIntensity(0, -0.5);
  assert.ok(justUnder > middle, 'a dipped beam is brightest right below the cut line');
});

test('the foreground stays lit — the road in front of the car is not a hole', () => {
  assert.ok(beamIntensity(0, -0.8) > 0.15);
});

test('the cone edge is soft, and outside it is dark', () => {
  assert.ok(beamIntensity(0, -1.4) < 0.01, 'outside the cone must be dark');
  assert.ok(beamIntensity(1.3, 0) < 0.01);
});

test('never outside 0..1 — values over 1 clip to white and destroy the cut-off', () => {
  for (let x = -1.2; x <= 1.2; x += 0.1) {
    for (let y = -1.2; y <= 1.2; y += 0.1) {
      const v = beamIntensity(x, y);
      assert.ok(v >= 0 && v <= 1, `beamIntensity(${x.toFixed(1)}, ${y.toFixed(1)}) = ${v}`);
    }
  }
});

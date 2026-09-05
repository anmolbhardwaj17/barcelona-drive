/**
 * Camera settle tail — the drift-back after a view transition.
 *
 * User, at speed: "first camera comes in its actual position for that close look but then as im
 * moving fast it goes a little more back too quick."
 *
 * That is arithmetic. During a transition the follow stiffness is forced to 1, so the camera ends
 * the arc exactly ON its ideal with zero lag. A first-order follow at LERP_POSITION then settles a
 * real distance behind: tau = dt/lerp, steady-state offset = v*tau. At 90 km/h that is 2.60 m —
 * LARGER than the 2.1 m between the two chase rigs, re-established in ~0.10 s after a 0.6 s move.
 *
 * These pin the shape of the fix rather than the feel of it: the numbers below are why 0.45 s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LERP_POSITION = 0.16;   // must match carCamera.js
const SETTLE_TIME = 0.45;
const DT = 1 / 60;

/** Steady-state lag of a first-order follow chasing a target moving at `v` m/s. */
const lagAt = (v, lerp) => v * (DT / lerp);

/** The eased stiffness the camera uses `t` seconds after a transition ends. */
function followLerp(t, base = LERP_POSITION) {
  const s = Math.min(1, t / SETTLE_TIME);
  const se = s * s * (3 - 2 * s);
  return base + (1 - base) * (1 - se);
}

test('the drift-back the user reported is real, and bigger than the move itself', () => {
  const rigGap = 6.6 - 4.5;                       // CHASE_RIGS wide vs close
  const drift = lagAt(90 / 3.6, LERP_POSITION);
  assert.ok(drift > rigGap,
    `drift ${drift.toFixed(2)} m should exceed the ${rigGap} m rig gap — that is why it is visible`);
  assert.ok(drift > 2.5 && drift < 2.7, `expected ~2.60 m at 90 km/h, got ${drift.toFixed(2)}`);
});

test('without the tail the lag re-establishes ~6x faster than the move that preceded it', () => {
  // A first-order follow closes ~63% of the gap in one tau.
  const tau = DT / LERP_POSITION;
  assert.ok(tau < 0.11, `tau ${tau.toFixed(3)}s`);
  assert.ok(0.6 / tau > 5, 'the 0.6 s transition is more than 5x slower than the snap-back');
});

test('the tail starts locked to the arc and ends at the normal follow', () => {
  assert.ok(Math.abs(followLerp(0) - 1) < 1e-9, 'must start fully locked, or the handover steps');
  assert.ok(Math.abs(followLerp(SETTLE_TIME) - LERP_POSITION) < 1e-9, 'must end at the normal rate');
  assert.ok(Math.abs(followLerp(SETTLE_TIME * 2) - LERP_POSITION) < 1e-9, 'and stay there');
});

test('it is monotonic — the camera never stiffens back up mid-settle', () => {
  // A non-monotonic curve would pull the camera forward again partway through, which reads as a
  // bounce and is worse than the step it replaces.
  let prev = Infinity;
  for (let t = 0; t <= SETTLE_TIME; t += SETTLE_TIME / 40) {
    const v = followLerp(t);
    assert.ok(v <= prev + 1e-12, `stiffness rose at t=${t.toFixed(3)}`);
    prev = v;
  }
});

test('smoothstep means no velocity step at either end of the tail', () => {
  const d = (t) => (followLerp(t + 1e-4) - followLerp(t - 1e-4)) / 2e-4;
  assert.ok(Math.abs(d(1e-3)) < 0.5, 'derivative should be ~0 at the start');
  assert.ok(Math.abs(d(SETTLE_TIME - 1e-3)) < 0.5, 'and ~0 at the end');
});

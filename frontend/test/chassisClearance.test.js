import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// carPhysicsRapier.js cannot be imported here — it pulls in the Rapier WASM module. The numbers are
// plain literals though, and the point of this test is the ARITHMETIC RELATIONSHIP between them, so
// it reads them out of the source. Brittle to renaming, which is fine: a rename should make someone
// re-read this.
const SRC = readFileSync(new URL('../src/car/carPhysicsRapier.js', import.meta.url), 'utf8');

function num(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `could not find ${label} in carPhysicsRapier.js — did it get renamed?`);
  return parseFloat(m[1]);
}

const CH_Y     = num(/const CH = \{ x: [\d.]+, y: ([\d.]+)/, 'CH.y');
const BOX_OFF  = num(/const BOX_OFFSET_Y = ([\d.]+)/, 'BOX_OFFSET_Y');
const WHEEL_Y  = num(/const WHEEL_Y = ([\d.]+)/, 'WHEEL_Y');
const WHEEL_R  = num(/WHEEL_R = ([\d.]+)/, 'WHEEL_R');
const REST_LEN = num(/REST_LEN = ([\d.]+)/, 'REST_LEN');

const boxBottom    = BOX_OFF - CH_Y;
const contactPatch = WHEEL_Y - REST_LEN - WHEEL_R;
const clearance    = boxBottom - contactPatch;

test('the chassis box clears more than one wheel radius', () => {
  // THE BUG THIS PINS: the box bottom sat at -0.215 against a contact patch at -0.46 — 24.5 cm of
  // clearance under a 68 cm tall tyre. Any ridge taller than that hit the BOX before it could ever
  // reach a wheel, so the car stopped dead on obstacles the wheels would have rolled over, and no
  // amount of grip or engine force could help because the obstacle never touched a wheel.
  //
  // A raycast wheel climbs roughly its own radius, so clearance must exceed WHEEL_R for the wheel's
  // limit to be the binding one rather than the bodywork's.
  assert.ok(clearance > WHEEL_R,
    `clearance ${clearance.toFixed(3)} m must exceed wheel radius ${WHEEL_R} m ` +
    `(box bottom ${boxBottom.toFixed(3)}, contact patch ${contactPatch.toFixed(3)})`);
});

test('the box still wraps the bodywork it is meant to', () => {
  // The fix trimmed the UNDERSIDE only. If the top moves, the box has stopped matching the body and
  // collisions will read wrong against walls and other cars — that is a different change entirely.
  assert.ok(Math.abs((BOX_OFF + CH_Y) - 1.215) < 0.001,
    `box top is ${(BOX_OFF + CH_Y).toFixed(4)}, expected 1.215 — the trim must not raise the roof`);
});

test('clearance is not absurdly high either', () => {
  // The other failure mode: lift the box so far that the car drives over things that should stop it.
  assert.ok(clearance < WHEEL_R * 1.5,
    `clearance ${clearance.toFixed(3)} m is more than 1.5x wheel radius — the car will mount barriers`);
});

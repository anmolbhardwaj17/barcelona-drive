import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// trafficSystem.js cannot be imported here (three.js + a live scene). The values under test are
// plain literals and the point is the RELATIONSHIP between them, so they are read from source.
const SRC = readFileSync(new URL('../src/car/trafficSystem.js', import.meta.url), 'utf8');

test('a right-angle turn is legal — the Eixample is a perpendicular grid', () => {
  // THE BUG THIS PINS: `dot <= 0.15` rejects anything sharper than 81 degrees. Every cross street in
  // the Eixample is 90 degrees (dot ≈ 0.0), so every turn was rejected and the only surviving
  // candidate was straight ahead — cars never turned, and a T-junction with only 90-degree exits had
  // NO legal continuation at all, so the car stopped dead in the road and everything queued behind.
  const m = SRC.match(/if \(dot <= (-?[\d.]+)\) continue;/);
  assert.ok(m, 'could not find the U-turn rejection threshold — was it renamed?');
  const threshold = parseFloat(m[1]);
  assert.ok(threshold < 0,
    `threshold ${threshold} must be negative: dot is 0.0 at exactly 90 degrees, so any ` +
    `non-negative threshold makes a right-angle turn illegal`);
  const maxTurnDeg = Math.acos(threshold) * 180 / Math.PI;
  assert.ok(maxTurnDeg >= 90, `must permit at least 90 degrees, permits ${maxTurnDeg.toFixed(0)}`);
});

test('but a genuine U-turn is still rejected', () => {
  const threshold = parseFloat(SRC.match(/if \(dot <= (-?[\d.]+)\) continue;/)[1]);
  const maxTurnDeg = Math.acos(threshold) * 180 / Math.PI;
  // Measured: past ~96 degrees the dead-end rate is flat (16.9% -> 16.6% all the way to 120), so
  // extra permissiveness buys nothing and starts admitting turns that read as U-turns.
  assert.ok(maxTurnDeg <= 100,
    `permits ${maxTurnDeg.toFixed(0)} degrees — beyond ~100 a turn reads as a U-turn for no ` +
    `measured gain in connectivity`);
});

test('the candidate weight cannot reward a sharp turn for being sharp', () => {
  // dot*dot is SYMMETRIC. Once dot can be negative, squaring it raw would score a 96-degree turn
  // the same as an 84-degree one, and a hypothetical -1 the same as dead straight.
  assert.match(SRC, /const fwd = Math\.max\(0, dot\);/,
    'the weight must clamp dot at 0 before squaring');
  assert.doesNotMatch(SRC, /w: [\d.]+ \+ dot \* dot \*/,
    'raw dot*dot in the weight is symmetric and rewards sharpness');
});

test('a car that runs out of road is despawned even in view', () => {
  // The anti-deadlock spares near-player cars so one you are BLOCKING never vanishes as you watch.
  // A car with no legal continuation is not waiting for anything, and sparing it leaves a permanent
  // roadblock — 16.9% of directed way-ends have no exit, so this is common.
  assert.match(SRC, /car\.outOfRoad/, 'out-of-road state must be tracked');
  assert.match(SRC, /farFromPlayer \|\| car\.outOfRoad/,
    'the despawn condition must let an out-of-road car go regardless of distance');
});

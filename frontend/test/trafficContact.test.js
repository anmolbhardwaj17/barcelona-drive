/**
 * V-12 — traffic contact is an oriented-box test, not a circle.
 *
 * The old trigger was `HIT_RADIUS = 3.4 m` measured between car CENTRES, while the event it has to
 * predict is two 4.5 m boxes touching. Every symptom the user reported falls out of that mismatch:
 *
 *   "very stuttery"          head-on contact happens at 4.55 m between centres, so the player drove
 *                            more than a METRE into a static, infinite-mass box before the shove
 *                            fired; the solver resolving that penetration each step is the stutter
 *   "only my car gets        the traffic body is mass 0 and teleported along its path, so it cannot
 *    affected"               be pushed — only the shove moves it, and the shove was not firing
 *   "on edge... just glides" on a glancing pass the centres never reach 3.4 m, so the shove never
 *                            fired at all and the car sailed on
 *
 * A circle also FALSELY fires: two cars in adjacent lanes are ~3.0 m apart, inside 3.4 m, so simply
 * being overtaken would shove a car aside. These cases pin both directions.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { obbOverlap } from '../src/car/trafficSystem.js';

// Player chassis 1.90 W x 4.79 L; the authored hatchback 2.12 W x 4.30 L.
const P_W = 0.95, P_L = 2.395;
const C_W = 1.06, C_L = 2.15;
const M = 0.28;
const hit = (dx, dz, carYaw = 0, playerYaw = 0) =>
  obbOverlap(dx, dz, carYaw, C_W, C_L, playerYaw, P_W, P_L, M);

test('head-on: contact is detected before the hulls interpenetrate', () => {
  // 4.55 m is nose-to-nose. The old circle waited for 3.4 m — a metre of penetration.
  assert.equal(hit(0, 4.4), true, 'touching at 4.4 m must register');
  assert.equal(hit(0, 5.2), false, 'still clear at 5.2 m');
});

test('a glancing corner hit registers — this is the "it just glides" case', () => {
  // Centres are 4.39 m apart, well outside the old 3.4 m circle, yet the corners are overlapping.
  assert.equal(hit(1.8, 4.0), true);
});

test('being overtaken in the next lane does NOT count as contact', () => {
  // ~3.0 m of lateral separation is a normal adjacent lane, and it sits INSIDE the old 3.4 m
  // circle — so the previous trigger shoved cars aside for merely driving past.
  assert.equal(hit(3.0, 0), false, 'adjacent lane must not trigger');
  assert.equal(hit(2.1, 0), true, 'but a genuine scrape must');
});

test('a T-bone registers, which a length-based radius would miss', () => {
  assert.equal(hit(0, 3.0, Math.PI / 2, 0), true);
});

test('distant cars never trigger', () => {
  assert.equal(hit(0, 12), false);
  assert.equal(hit(12, 0), false);
});

test('the test is symmetric in approach direction', () => {
  // Front and rear contact must behave the same; a signed test would quietly fail one of them.
  assert.equal(hit(0, 4.4), hit(0, -4.4));
  assert.equal(hit(2.1, 0), hit(-2.1, 0));
});

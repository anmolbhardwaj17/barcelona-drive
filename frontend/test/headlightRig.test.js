/**
 * The scene's light COUNTS are compiled into every shader's cache key, so any light that appears or
 * disappears after the boot warm-up invalidates every material in the world and forces a
 * synchronous recompile of each one. A 2026-08-26 drive measured 72 such compiles because the car
 * created its two headlight SpotLights on spawn and removed them on dispose (D-39).
 *
 * These tests hold the invariant that fix depends on: from the moment the rig is built, the scene
 * contains exactly two spot lights, both with a `map`, through adoption by a car and back again.
 * If one of these fails, the warm-up is compiling a light set the session does not run with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getHeadlightRig, HEADLIGHT_DAY, HEADLIGHT_NIGHT } from '../src/car/headlightRig.js';

/** What three keys programs on: numSpotLights and numSpotLightMaps, counted over the whole graph. */
function lightCounts(scene) {
  let spots = 0, spotMaps = 0;
  scene.traverse((o) => {
    if (o.isSpotLight) { spots++; if (o.map) spotMaps++; }
  });
  return { spots, spotMaps };
}

const scene = new THREE.Scene();
const rig = getHeadlightRig(scene);

test('the rig puts two mapped spot lights in the scene at build time', () => {
  assert.ok(rig, 'rig should exist with CONFIG.ENABLE_CAR_LIGHTS on');
  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 });
});

test('the rig parks dark, so lights in the scene before a car do not light the world', () => {
  assert.equal(rig.spots.every((s) => s.intensity === 0), true);
});

test('adopting the rig re-parents it without changing the light count', () => {
  const body = new THREE.Group();
  scene.add(body);
  rig.attachTo(body);

  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 }, 'count must not move on attach');
  assert.equal(rig.spots.every((s) => s.parent === body), true, 'lights should hang under the body');
  assert.equal(rig.target.parent, body, 'the aim target must follow the lights');
});

test('disposing the car hands the lights back instead of removing them', () => {
  const body = scene.children.find((c) => c.isGroup && c.children.includes(rig.spots[0]));
  rig.detach();
  scene.remove(body);   // what carModel.dispose() does, in the order it does it

  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 }, 'count must survive a dispose');
  assert.equal(rig.spots.every((s) => s.intensity === 0), true, 'handed-back lights must be dark');
});

test('intensity is the only thing day/night moves — never the light count', () => {
  rig.setIntensity(HEADLIGHT_NIGHT);
  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 });
  rig.setIntensity(HEADLIGHT_DAY);
  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 });
  assert.ok(HEADLIGHT_NIGHT > HEADLIGHT_DAY, 'night beam should be stronger than the daytime DRL');
});

test('the rig is a singleton — a second call cannot add a third light', () => {
  assert.equal(getHeadlightRig(scene), rig);
  assert.deepEqual(lightCounts(scene), { spots: 2, spotMaps: 2 });
});

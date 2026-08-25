/**
 * The light grid's slot assignment decides WHICH lamps a fragment sees, and every failure mode here
 * is silent: the scene still renders, still costs the same, and is just lit by the wrong lamps.
 * Nothing throws, so only a test catches it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { initLightGrid, setLights, updateLightGrid, lightGridStats, getCellSlots, lampContribution, assertLightingVisible, GRID_DIM, MAX_LIGHTS }
  from '../src/map/lightGrid.js';

const WHITE = new THREE.Color(0xffffff);
const lamp = (x, z, radius = 26) => ({ x, y: 6, z, radius, color: WHITE, intensity: 3 });

test('a lamp lights the cells within its radius and no others', () => {
  initLightGrid();
  setLights([lamp(0, 0, 26)]);
  updateLightGrid(0, 0);
  // Circle of radius 26 over 8 m cells ~= pi*26^2/64 ~= 33 cells. The bounding SQUARE would be
  // ~42 — the difference is the corner cells the circle test rejects, which is the point.
  assert.ok(lightGridStats.cellsOccupied > 20 && lightGridStats.cellsOccupied < 42,
    `expected a disc of ~33 cells, got ${lightGridStats.cellsOccupied}`);
  assert.equal(lightGridStats.meanOccupancy, 1, 'one lamp cannot fill more than one slot per cell');
});

test('cells beyond every radius stay empty', () => {
  initLightGrid();
  setLights([lamp(0, 0, 10)]);
  updateLightGrid(0, 0);
  const lit = lightGridStats.cellsOccupied;
  assert.ok(lit > 0 && lit < GRID_DIM * GRID_DIM * 0.02,
    `a 10 m lamp must light a small fraction of a ${GRID_DIM}x${GRID_DIM} grid, got ${lit}`);
});

test('NEAREST-FIRST: a cell keeps the 4 closest lamps, not the first 4 seen', () => {
  initLightGrid();
  // Five lamps all reaching the origin cell. The far ones are listed FIRST, so first-free
  // assignment would keep exactly the wrong four and drop the nearest.
  setLights([
    lamp(20, 0), lamp(-20, 0), lamp(0, 20), lamp(0, -20),   // far, listed first
    lamp(1, 1),                                              // nearest, listed last
  ]);
  updateLightGrid(0, 0);
  const slots = getCellSlots(0, 0);
  assert.equal(slots.filter((v) => v !== 0).length, 4, 'all four slots should be taken');
  assert.ok(slots.includes(5),
    'the NEAREST lamp (index 5, listed last) must survive. First-free assignment keeps whichever ' +
    'lamps the array happened to list first, so in a dense block the visibly closest lamp is the ' +
    'one dropped — silently, since the scene still renders.');
});

test('more lamps than MAX_LIGHTS keeps the nearest, not the first loaded', () => {
  initLightGrid();
  const many = [];
  for (let i = 0; i < MAX_LIGHTS + 50; i++) many.push(lamp(1000 + i, 0));   // all far away, in order
  many.push(lamp(0, 0));                                                     // one at the camera
  setLights(many, { x: 0, z: 0 });
  updateLightGrid(0, 0);
  assert.ok(lightGridStats.cellsOccupied > 0,
    'the lamp at the camera must survive truncation — otherwise the lit area follows tile load ' +
    'order rather than the car, and lamps near the driver silently go dark');
});

test('an empty light set lights nothing', () => {
  initLightGrid();
  setLights([]);
  updateLightGrid(0, 0);
  assert.equal(lightGridStats.cellsOccupied, 0);
});

// ── Falloff physics ───────────────────────────────────────────────────────────────────────────
// These exist because the cone term shipped with an inverted sign: d points surface->lamp, so road
// under a lamp has d.y > 0, and negating it sent every road surface to the spill floor. The street
// went dark, nothing threw, and a dark street looks like an art decision. Sign errors in lighting
// are silent by nature — only an assertion about the PHYSICS catches them.
test('a lamp lights the road directly beneath it', () => {
  const road = { x: 0, y: 1, z: 0 };
  const under = lampContribution(0, 8, 0, road);
  assert.ok(under > 0.1,
    `road under an 8 m lamp got ${under.toFixed(4)} — that is a dark street. If the cone sign is ` +
    'inverted this collapses to the spill floor and nothing else fails.');
});

test('light falls off along the street but stays visible at mid range', () => {
  const road = { x: 0, y: 1, z: 0 };
  const under = lampContribution(0, 8, 0, road);
  const mid = lampContribution(0, 8, 15, road);
  const far = lampContribution(0, 8, 30, road);
  assert.ok(under > mid && mid > far, 'must decrease monotonically along the street');
  assert.ok(mid > 0.02, `at 15 m got ${mid.toFixed(4)} — pools must overlap at 22 m lamp spacing`);
});

test('THE CONE: a surface ABOVE the lamp gets far less than the road below it', () => {
  // The whole point of the cone. A six-storey facade must not be washed to the roofline by a lamp
  // head 8 m up — that was the "building lighting from road reflection" report.
  const road = { x: 0, y: 1, z: 0 };
  const wall = { x: 0, y: 0, z: 1 };
  const below = lampContribution(0, 8, 0, road);
  const above = lampContribution(0, -12, 2, wall);   // 20 m up a facade, i.e. above the lamp
  assert.ok(above < below * 0.25,
    `facade above the lamp got ${above.toFixed(4)} vs road ${below.toFixed(4)} — the cone is not shaping`);
});

test('nothing is lit beyond the radius', () => {
  assert.equal(lampContribution(0, 8, 100, { x: 0, y: 1, z: 0 }), 0);
});

test('assertLightingVisible flags a configuration that leaves the road dark', () => {
  const warned = [];
  const real = console.warn; console.warn = (...a) => warned.push(a);
  try {
    assertLightingVisible({ intensity: 0.001 });     // far too dim to see
  } finally { console.warn = real; }
  assert.equal(warned.length, 1, 'a road that cannot be seen must say so, not fail silently');
});

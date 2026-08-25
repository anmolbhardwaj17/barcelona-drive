/**
 * The light grid's slot assignment decides WHICH lamps a fragment sees, and every failure mode here
 * is silent: the scene still renders, still costs the same, and is just lit by the wrong lamps.
 * Nothing throws, so only a test catches it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { initLightGrid, setLights, updateLightGrid, lightGridStats, getCellSlots, GRID_DIM, MAX_LIGHTS }
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

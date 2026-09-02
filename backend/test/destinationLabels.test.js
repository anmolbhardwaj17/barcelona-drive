import test from 'node:test';
import assert from 'node:assert/strict';
import { signName, deriveJunctionDestinations } from '../worldBuilder/roads/destinationLabels.js';

test('strips the generic street type, because every Barcelona street is a Carrer', () => {
  assert.equal(signName('Carrer de Balmes'), 'Balmes');
  assert.equal(signName("Carrer d'Aragó"), 'Aragó');
  assert.equal(signName('Carrer de la Marina'), 'Marina');
  assert.equal(signName('Passatge de Mercader'), 'Mercader');
});

test('KEEPS the prefix where it is part of the name', () => {
  // Measured on real output: stripping these gave "Passeig de Gràcia" -> "Gràcia", which is a
  // different DISTRICT, and "Travessera de les Corts" -> "Corts", likewise. A sign that names the
  // wrong place is worse than a long one.
  assert.equal(signName('Passeig de Gràcia'), 'Passeig de Gràcia');
  assert.equal(signName('Travessera de les Corts'), 'Travessera de les Corts');
  assert.equal(signName('Rambla de Catalunya'), 'Rambla de Catalunya');
  assert.equal(signName('Ronda de Dalt'), 'Ronda de Dalt');
  assert.equal(signName('Gran Via de les Corts Catalanes'), 'Gran Via de les Corts Catalanes');
});

test('drops the carriageway suffix a dual road carries', () => {
  // OSM disambiguates each side of a dual carriageway. Correct data, wrong on a 2 m board.
  assert.equal(signName('Avinguda Diagonal (lateral muntanya)'), 'Avinguda Diagonal');
  assert.equal(signName('Gran Via (sentit Besòs)'), 'Gran Via');
});

test('handles empty and nullish input', () => {
  assert.equal(signName(''), '');
  assert.equal(signName(null), '');
  assert.equal(signName(undefined), '');
});

// ── the derivation itself ────────────────────────────────────────────────────────────────────
// A cross: a long important road E-W, a long one N-S, meeting at the origin. Each arm is one way
// so the junction has four ends.
const arm = (id, name, type, dx, dz, len) => ({
  id, name, highwayType: type,
  pts: [{ x: 0, z: 0 }, { x: dx * len, z: dz * len }],
});

test('an exit is never signed with the road you are already on', () => {
  const ways = [
    arm(1, 'Carrer de Test', 'primary', 1, 0, 900),
    arm(2, 'Carrer de Test', 'primary', -1, 0, 900),   // same name, opposite arm
    arm(3, 'Avinguda Nord', 'primary', 0, 1, 900),
    arm(4, 'Avinguda Sud', 'primary', 0, -1, 900),
  ];
  const d = deriveJunctionDestinations(ways);
  for (const exits of d.values()) {
    for (const e of exits) assert.notEqual(e.name, 'Test', 'signed the road the driver is on');
  }
});

test('a destination nearer than the minimum is not signed', () => {
  // All arms 100 m — nothing is far enough away to be a destination.
  const ways = [
    arm(1, 'Carrer A', 'primary', 1, 0, 100), arm(2, 'Carrer B', 'primary', -1, 0, 100),
    arm(3, 'Carrer C', 'primary', 0, 1, 100), arm(4, 'Carrer D', 'primary', 0, -1, 100),
  ];
  const d = deriveJunctionDestinations(ways);
  let n = 0; for (const ex of d.values()) n += ex.length;
  assert.equal(n, 0, 'signed something under the 300 m minimum');
});

test('exits DISAGREE — the whole point of a direction sign', () => {
  // THE BUG THIS PINS: without the heading cone the walk fans out, finds the most important road
  // anywhere in range, and returns the SAME answer for every exit — while reporting 100% coverage.
  //
  // ⚠ Each arm must CONTINUE into a further named way. A bare 4-arm cross has no destination at all:
  // the only other names sit across the junction, reachable solely by turning back through it, which
  // the cone rightly refuses. The first version of this test asserted otherwise and was wrong about
  // the fixture, not the code.
  const arms = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const ways = [];
  arms.forEach(([dx, dz], i) => {
    ways.push({ id: 100 + i, name: `Carrer Arm ${i}`, highwayType: 'secondary',
                pts: [{ x: 0, z: 0 }, { x: dx * 400, z: dz * 400 }] });
    ways.push({ id: 200 + i, name: `Avinguda Dest ${i}`, highwayType: 'primary',
                pts: [{ x: dx * 400, z: dz * 400 }, { x: dx * 1200, z: dz * 1200 }] });
  });
  const d = deriveJunctionDestinations(ways);
  const exits = d.get('0,0') || [];
  assert.ok(exits.length >= 3, `expected 3+ signable exits, got ${exits.length}`);
  assert.equal(new Set(exits.map((e) => e.name)).size, exits.length,
    `exits must differ, got: ${exits.map((e) => e.name).join(', ')}`);
  for (const e of exits) {
    assert.match(e.name, /^Avinguda Dest \d$/, `signed "${e.name}" — expected the continuation`);
  }
});

test('a two-way node is not a junction and gets no board', () => {
  const ways = [arm(1, 'Carrer A', 'primary', 1, 0, 900), arm(2, 'Carrer B', 'primary', -1, 0, 900)];
  assert.equal(deriveJunctionDestinations(ways).size, 0);
});

/**
 * N-1 — duplicate ways drawn on top of each other.
 *
 * `rule5_duplicateRoadRemover` was never broken: a full Barcelona bake removes ~8,700 duplicate
 * ways. What it left was a TAIL just outside its limits (`MAX_DIST` 3 m, `MIN_RATIO` 0.8) —
 * measured on the shipped tiles, 57 pairs where one way is >70% covered by another of the same
 * class at centreline separations of 0.6-4 m. `Avinguda de Pedralbes` carried THREE stacked ways
 * over 56 m, each drawn at full width.
 *
 * ⚠ WHY THE NAME IS PART OF THE RULE, AND WHY THESE TESTS MATTER. Loosening the distance for
 * everything would delete real geometry: Barcelona has dual carriageways with narrow medians, and
 * at 5 m the rule would start eating them. Of those 57 pairs, 44 shared a street NAME and only 5
 * differed. Two same-class ways carrying the same name over the same ground are a duplicate; two
 * carrying different names are two streets. So the name buys the extra reach and nothing else does.
 *
 * The pair of tests that matter are `same name ... IS removed` and `different names ... are BOTH
 * kept` at the identical separation. If a future change makes the second one fail, the relaxation
 * has leaked into real roads.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../../backend/worldBuilder/roads/OsmDataFixer.js';

const { rule5_duplicateRoadRemover } = __test__;

const LAT0 = 41.3866, LON0 = 2.1640;
const M_PER_DEG_LAT = 111320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Build a straight east-west way `lengthM` long, offset `offsetM` to the north. */
function makeWay(id, { name, lengthM = 200, offsetM = 0, highwayType = 'residential' }) {
  const nodeIds = [];
  const nodes = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const nid = id * 1000 + i;
    nodeIds.push(nid);
    nodes.push([nid, {
      lat: LAT0 + offsetM / M_PER_DEG_LAT,
      lon: LON0 + ((i / steps) * lengthM) / mPerDegLon,
    }]);
  }
  const way = {
    id, nodeIds, highwayType, bridge: false, tunnel: false, layer: 0,
    tags: name ? { name } : {},
  };
  return { way, nodes };
}

/** Run the rule over a set of ways; returns { removed, strict, sameName, survivingIds }. */
function run(specs) {
  const wayMap = new Map();
  const nodeMap = new Map();
  const nodeToWays = new Map();
  for (const spec of specs) {
    const { way, nodes } = spec;
    wayMap.set(way.id, way);
    for (const [nid, n] of nodes) {
      nodeMap.set(nid, n);
      if (!nodeToWays.has(nid)) nodeToWays.set(nid, new Set());
      nodeToWays.get(nid).add(way.id);
    }
  }
  const res = rule5_duplicateRoadRemover(wayMap, nodeToWays, nodeMap);
  return { ...res, survivingIds: [...wayMap.keys()].sort((a, b) => a - b) };
}

test('two ways with the SAME NAME 4 m apart: the shorter IS removed', () => {
  // 4 m is beyond the strict 3 m limit — this is the tail the fix was written for.
  const a = makeWay(1, { name: 'Avinguda de Pedralbes', lengthM: 200, offsetM: 0 });
  const b = makeWay(2, { name: 'Avinguda de Pedralbes', lengthM: 150, offsetM: 4 });
  const r = run([a, b]);
  assert.equal(r.removed, 1, 'the duplicate should be removed');
  assert.equal(r.sameName, 1, 'and it must be attributed to the same-name branch');
  assert.equal(r.strict, 0);
  assert.deepEqual(r.survivingIds, [1], 'the LONGER way survives');
});

test('two ways with DIFFERENT names 4 m apart: BOTH are kept', () => {
  // THE REGRESSION GUARD. Identical geometry to the test above; only the names differ. If this
  // ever fails, the relaxed distance has leaked onto real parallel streets.
  const a = makeWay(1, { name: 'Carrer de Mallorca', lengthM: 200, offsetM: 0 });
  const b = makeWay(2, { name: 'Carrer de Valencia', lengthM: 150, offsetM: 4 });
  const r = run([a, b]);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.survivingIds, [1, 2]);
});

test('UNNAMED ways 4 m apart are kept — a missing name is not evidence of duplication', () => {
  const a = makeWay(1, { name: null, lengthM: 200, offsetM: 0 });
  const b = makeWay(2, { name: null, lengthM: 150, offsetM: 4 });
  const r = run([a, b]);
  assert.equal(r.removed, 0);
});

test('the STRICT branch still fires on unnamed ways that are truly coincident', () => {
  // Within 3 m, so the original rule applies with no help from the name.
  const a = makeWay(1, { name: null, lengthM: 200, offsetM: 0 });
  const b = makeWay(2, { name: null, lengthM: 150, offsetM: 1 });
  const r = run([a, b]);
  assert.equal(r.removed, 1);
  assert.equal(r.strict, 1, 'attributed to the strict branch, not the name branch');
  assert.equal(r.sameName, 0);
});

test('same name but FAR apart is kept — the name alone must not delete a street', () => {
  // Two arms of one avenue either side of a wide median. Same name, 30 m apart.
  const a = makeWay(1, { name: 'Gran Via', lengthM: 200, offsetM: 0 });
  const b = makeWay(2, { name: 'Gran Via', lengthM: 200, offsetM: 30 });
  const r = run([a, b]);
  assert.equal(r.removed, 0, 'a dual carriageway is two roads, not a duplicate');
});

test('different highway CLASSES are never compared', () => {
  const a = makeWay(1, { name: 'Same Street', lengthM: 200, offsetM: 0, highwayType: 'primary' });
  const b = makeWay(2, { name: 'Same Street', lengthM: 150, offsetM: 1, highwayType: 'service' });
  const r = run([a, b]);
  assert.equal(r.removed, 0);
});

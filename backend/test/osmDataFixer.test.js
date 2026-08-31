/**
 * OsmDataFixer rule 9 and the N-52 overlap gates.
 *
 * ⚠ WHY THESE, of all the rules. Rule 9 ("a named street resuming across a gap is one street with
 * its middle missing") shipped 199 connectors, and then the user reported z-fighting: **313 of 366
 * connectors, 86%, were being drawn INSIDE a road that was already there.** The fix was two gates —
 * `hasRealSurfaceGap` (the ends are already touching once you account for ribbon WIDTH, not just
 * centreline distance) and `lineLiesOnExistingRoad` (a road already runs along the path). Those
 * gates then cost 7 dead ends, and nothing in the repo could tell you either fact without a
 * 10-minute bake and a hand-run audit.
 *
 * `__test__` was already exported from that module. Nobody had ever written against it.
 *
 * Run: npm test (in backend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../worldBuilder/roads/OsmDataFixer.js';

const { rule9_namedStreetResumes } = __test__;

/** Degrees of latitude per metre, near Barcelona. Longitude is scaled by cos(lat). */
const M_LAT = 1 / 111320;
const LAT0 = 41.39, LON0 = 2.18;
const M_LON = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));

/**
 * A straight way running east along a constant latitude.
 * @param x0,x1 metres east of LON0; `lat` metres north of LAT0.
 */
function way(id, { name, x0, x1, lat = 0, type = 'residential', width = 8, pts = 2, tags = {} }) {
  const nodeIds = [], nodes = [];
  for (let i = 0; i < pts; i++) {
    const x = x0 + ((x1 - x0) * i) / (pts - 1);
    const nid = `${id}n${i}`;
    nodeIds.push(nid);
    nodes.push([nid, { lat: LAT0 + lat * M_LAT, lon: LON0 + x * M_LON }]);
  }
  return {
    w: { id, nodeIds, highwayType: type, width, layer: 0, tunnel: false,
         tags: { name, ...tags } },
    nodes,
  };
}

function fixture(parts) {
  const wayMap = new Map();
  const nodeMap = new Map();
  const nodeToWays = new Map();
  for (const p of parts) {
    wayMap.set(p.w.id, p.w);
    for (const [nid, ll] of p.nodes) {
      nodeMap.set(nid, ll);
      // ⚠ SETS, not arrays. The fixer calls `.add()` on these; building arrays here threw
      // `nodeToWays.get(...).add is not a function` on the very first run — the fixture was wrong,
      // not the code, which is the good failure to get from a new test.
      if (!nodeToWays.has(nid)) nodeToWays.set(nid, new Set());
      nodeToWays.get(nid).add(p.w.id);
    }
  }
  return { wayMap, nodeToWays, nodeMap };
}

test('rule 9 joins a named street that resumes across a real gap', () => {
  // Two halves of "Carrer de Prova", 30 m apart, pointing at each other.
  const a = way('a', { name: 'Carrer de Prova', x0: 0, x1: 100 });
  const b = way('b', { name: 'Carrer de Prova', x0: 130, x1: 230 });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.ok(stats.created > 0, `expected a link, got ${JSON.stringify(stats)}`);
});

test('N-52 hairline gate — ends already touching are NOT joined', () => {
  // The gap must sit in a specific window to test THIS gate, and finding that window is the point:
  // below RESUME_MIN_M (5 m) the pair is dropped before the gate is ever reached — a 4 m gap
  // returned `candidates: 0`, so the first version of this test passed the wrong reason. 7 m clears
  // the minimum and still falls under the width threshold of (8+8)/2 + 1 = 9 m, so the two 8 m
  // ribbons already overlap and a connector would be drawn inside existing road.
  const a = way('a', { name: 'Carrer de Prova', x0: 0, x1: 100, width: 8 });
  const b = way('b', { name: 'Carrer de Prova', x0: 107, x1: 207, width: 8 });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.equal(stats.created, 0, 'a hairline gap must not produce a connector');
  assert.ok(stats.rejectedHairline > 0,
    `must be refused by the WIDTH-aware gate specifically, got ${JSON.stringify(stats)}`);
});

test('N-52 overlap gate — a path already covered by another road is NOT joined', () => {
  // The gap is real by centreline distance, but a third road lies along it. Drawing a connector
  // here stacks two ribbons — exactly the z-fighting the user photographed.
  const a = way('a', { name: 'Carrer de Prova', x0: 0, x1: 100 });
  const b = way('b', { name: 'Carrer de Prova', x0: 140, x1: 240 });
  // 'c' runs straight through the gap, wide enough to cover it.
  const c = way('c', { name: 'Altra', x0: 95, x1: 145, width: 12, type: 'service' });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b, c]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.equal(stats.created, 0, 'must not draw a connector inside an existing ribbon');
  assert.ok(stats.rejectedOnExistingRoad > 0,
    `must be refused by the PATH gate specifically, got ${JSON.stringify(stats)}`);
});

test('rule 9 refuses a different road CLASS even when the name matches', () => {
  // Barcelona pedestrianises street-ends: `Carrer d'Esteve Terradas` continues as a FOOTWAY of the
  // same name, and welding a tertiary to it would be the bug, not the fix. This is why the city's
  // top-scored "dead end" is not a defect at all (N-55).
  const a = way('a', { name: 'Carrer de Prova', x0: 0, x1: 100, type: 'tertiary' });
  const b = way('b', { name: 'Carrer de Prova', x0: 130, x1: 230, type: 'living_street' });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.equal(stats.created, 0, 'a class change must not be welded');
  assert.ok(stats.rejectedClass > 0, `expected a class rejection, got ${JSON.stringify(stats)}`);
});

test('rule 9 ignores an unnamed street — geometry alone is not evidence', () => {
  const a = way('a', { name: '', x0: 0, x1: 100 });
  const b = way('b', { name: '', x0: 130, x1: 230 });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.equal(stats.created, 0, 'no name, no join');
  assert.equal(stats.named, 0, 'unnamed free ends must not even be considered');
});

test('rule 9 refuses a gap beyond its reach', () => {
  // RESUME_MAX_M is 90 m. Two streets 200 m apart sharing a name are two streets.
  const a = way('a', { name: 'Carrer de Prova', x0: 0, x1: 100 });
  const b = way('b', { name: 'Carrer de Prova', x0: 300, x1: 400 });
  const { wayMap, nodeToWays, nodeMap } = fixture([a, b]);
  const stats = rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap);
  assert.equal(stats.created, 0, 'beyond RESUME_MAX_M must not join');
});

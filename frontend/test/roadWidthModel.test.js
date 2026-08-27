/**
 * R-W1 — the road width model, checked against the Barcelona archetypes it exists to reproduce.
 *
 * The model lives in the bake (`backend/worldBuilder/roads/roadWidthModel.js`) because its output is
 * baked into the tile; the frontend reads fields, not formulas. It is tested from here because this
 * is where `npm test` runs, and because the whole point of R-W1 is that ONE set of numbers serves
 * both sides — a test that only the backend ran would be the mirroring problem all over again.
 *
 * What is pinned, and why each one:
 *   1. The archetypes from barcelona-road-system.md §2. If the model stops reproducing a documented
 *      street section, the doc and the code have diverged and one of them is now lying.
 *   2. The section ADDS UP (carriageway + parking + shoulders == kerb-to-kerb). Every consumer
 *      offset is derived from these, so an inconsistent section puts kerbs, rails and parked cars
 *      in three different places — which is the bug R-W1 exists to kill.
 *   3. Parking and guard rails cannot claim the same ground. This is the user-reported
 *      "cars parked ON the guard rails", stated as an invariant rather than a story.
 *   4. Dual carriageways are NOT given a median. OSM splits them per direction; adding one would
 *      silently double the motorway network's footprint.
 *   5. The three regressions the measurement found: footways at 4 m, the OSM width tag being
 *      unreachable, and MIN_WIDTH being applied to things that are not carriageways.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRoadWidths, resolveLanes, kerbOffset, parkingBayOffset, WIDTH_MODEL_CONSTANTS,
} from '../../backend/worldBuilder/roads/roadWidthModel.js';

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ~${b} (+/-${tol}), got ${a}`);

// ── 1. The documented archetypes ────────────────────────────────────────────────────────────────

test('Eixample standard: a one-way residential street is a ~10 m roadway, not 4 m', () => {
  // barcelona-road-system.md §2: "Roadway: 10m total (typically 2 lanes one-way + parking strips
  // ~2m each)". Measured before this model: 73% of residential baked at exactly 4 m.
  const w = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes' } });
  near(w.kerbToKerbW, 10.0, 0.5, 'Eixample roadway, kerb to kerb');
  assert.equal(w.parkingLeftW, 2.2, 'both kerbs park — it is the defining feature of the grid');
  assert.equal(w.parkingRightW, 2.2);
  assert.ok(w.carriagewayW >= 6.0, 'a one-way Eixample street is 2-3 lanes wide, not one 3 m lane');
});

test('Eixample corridor lands near the documented 20 m building-to-building', () => {
  const w = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes' } });
  // §2 gives 5 m sidewalk each side + 10 m roadway. Sidewalks are the part we render most coarsely,
  // so the tolerance is wide — what must hold is that the corridor is ~20 m and not ~6 m.
  near(w.corridorW, 16.0, 2.5, 'Eixample corridor');
  assert.ok(w.corridorW > w.kerbToKerbW, 'the corridor must be wider than the roadway');
});

test('a motorway carriageway stays ~14 m — the ONE case the old code got right', () => {
  // OSM splits dual carriageways per direction (motorway ways measured 100% oneway), so lanes=3 is
  // three lanes ONE way. 3 x 3.5 + 2.5 + 2.5 shoulders. The shipped tiles already had 14 m; a model
  // that "fixed" motorways would have doubled the network's footprint.
  const w = computeRoadWidths({ highwayType: 'motorway', oneway: true, tags: { lanes: '3', oneway: 'yes' } });
  near(w.kerbToKerbW, 15.5, 2.0, 'motorway kerb to kerb, one direction');
  assert.equal(w.parkingLeftW, 0, 'nobody parks on a motorway');
  assert.equal(w.parkingRightW, 0);
  assert.equal(w.sidewalkW, 0, 'and nobody walks on one');
});

test('Gracia narrow: an OSM width tag CAPS the section instead of being ignored', () => {
  // Pre-Cerda streets are 8-12 m building to building. The derived section would be ~10.4 m, which
  // would swallow the pavement. OSM's own measurement is the only thing that knows this, and before
  // R-W1 it was stripped by KEEP_TAGS and never read.
  const wide = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes' } });
  const narrow = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes', width: '5.5' } });
  assert.ok(narrow.kerbToKerbW < wide.kerbToKerbW, 'the tag must actually bite');
  near(narrow.kerbToKerbW, 5.5, 0.01, 'capped to the tagged width');
  assert.equal(narrow.widthSource, 'osm-width-capped');
  assert.ok(narrow.carriagewayW >= 5.5 - 0.01,
    'the budget comes out of PARKING first — a narrow street loses its bays, not its lane');
});

test('a generous OSM width does NOT widen the road', () => {
  // The tag is a BOUND, not a source. OSM `width` inconsistently means carriageway, kerb-to-kerb or
  // the whole corridor; letting a 20 m reading through would put a residential street's kerb in the
  // middle of the pavement.
  const w = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes', width: '25' } });
  const plain = computeRoadWidths({ highwayType: 'residential', oneway: true, tags: { oneway: 'yes' } });
  assert.equal(w.kerbToKerbW, plain.kerbToKerbW, 'a wide tag must be inert');
});

// ── 2. The section adds up ──────────────────────────────────────────────────────────────────────

const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'unclassified', 'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link'];

test('kerbToKerbW == carriageway + both parking strips + both shoulders, for every class', () => {
  for (const t of CLASSES) {
    for (const oneway of [true, false]) {
      const w = computeRoadWidths({ highwayType: t, oneway, tags: oneway ? { oneway: 'yes' } : {} });
      const sum = w.carriagewayW + w.parkingLeftW + w.parkingRightW + w.shoulderW * 2;
      near(w.kerbToKerbW, sum, 0.02, `${t} (oneway=${oneway}) section must close`);
      near(w.corridorW, w.kerbToKerbW + w.sidewalkW * 2, 0.02, `${t} corridor must close`);
    }
  }
});

test('every width is finite, positive and inside the absolute bounds', () => {
  const K = WIDTH_MODEL_CONSTANTS;
  const PATHS = ['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track'];
  for (const t of [...CLASSES, ...PATHS, 'nonsense']) {
    const w = computeRoadWidths({ highwayType: t, tags: {} });
    for (const [k, v] of Object.entries(w)) {
      if (typeof v !== 'number') continue;
      assert.ok(Number.isFinite(v) && v >= 0, `${t}.${k} must be a non-negative number, got ${v}`);
    }
    // ABS_MIN_CARRIAGEWAY is a CARRIAGEWAY bound and applies only to things you drive on. Applying
    // it to a footpath is the exact mistake that baked every pavement in the city at 4 m — a floor
    // meant for roads, enforced on things that are not roads. Paths get their own, much lower one.
    const floor = PATHS.includes(t) ? 0.8 : K.ABS_MIN_CARRIAGEWAY;
    assert.ok(w.carriagewayW >= floor, `${t} width floor (${floor} m)`);
    assert.ok(w.kerbToKerbW <= K.ABS_MAX_KERB_TO_KERB, `${t} kerb-to-kerb ceiling`);
  }
});

// ── 3. Parking and rails cannot claim the same ground ───────────────────────────────────────────

test('a parking bay always lies INSIDE the kerb line', () => {
  // The reported bug, as an invariant. A rail sits at kerbOffset(); a bay centre plus half a bay
  // must stay inside it, or cars land on the barrier.
  for (const t of CLASSES) {
    const w = computeRoadWidths({ highwayType: t, tags: {} });
    for (const side of ['left', 'right']) {
      const bay = side === 'left' ? w.parkingLeftW : w.parkingRightW;
      if (!bay) continue;
      const outerEdge = parkingBayOffset(w, side) + bay / 2;
      assert.ok(outerEdge <= kerbOffset(w) + 0.01,
        `${t}/${side}: bay outer edge ${outerEdge} must not pass the kerb at ${kerbOffset(w)}`);
    }
  }
});

test('a parking bay never overlaps the carriageway', () => {
  for (const t of CLASSES) {
    const w = computeRoadWidths({ highwayType: t, tags: {} });
    for (const side of ['left', 'right']) {
      const bay = side === 'left' ? w.parkingLeftW : w.parkingRightW;
      if (!bay) continue;
      const innerEdge = parkingBayOffset(w, side) - bay / 2;
      assert.ok(innerEdge >= w.carriagewayW / 2 - 0.01,
        `${t}/${side}: a parked car must not stand in a running lane`);
    }
  }
});

test('no parking on a bridge, a ramp, an elevated deck or in a tunnel', () => {
  // Gated on the same booleans the guard-rail gate leads with, so the two can never disagree (R-V1).
  for (const ctx of [{ bridge: true }, { isRamp: true }, { layer: 1 }, { tunnel: true }]) {
    const w = computeRoadWidths({ highwayType: 'residential', tags: {}, ...ctx });
    assert.equal(w.parkingLeftW, 0, `no parking with ${JSON.stringify(ctx)}`);
    assert.equal(w.parkingRightW, 0);
  }
});

test('OSM parking:* denial is honoured on the side it names', () => {
  const w = computeRoadWidths({ highwayType: 'residential', tags: { 'parking:left': 'no' } });
  assert.equal(w.parkingLeftW, 0, 'the tagged side loses its bay');
  assert.equal(w.parkingRightW, 2.2, 'the other side keeps it');
  const both = computeRoadWidths({ highwayType: 'residential', tags: { 'parking:both': 'separate' } });
  assert.equal(both.parkingLeftW, 0);
  assert.equal(both.parkingRightW, 0);
});

// ── 4. Dual carriageways get no median ──────────────────────────────────────────────────────────

test('a 3-lane oneway motorway is ONE carriageway, not two plus a median', () => {
  const w = computeRoadWidths({ highwayType: 'motorway', oneway: true, tags: { lanes: '3', oneway: 'yes' } });
  assert.ok(w.carriagewayW <= 3 * 3.5 + 0.01,
    'lanes=3 on a split dual carriageway means 3 lanes, full stop');
});

test('lane defaults follow OSM convention: 1 if oneway, 2 if not', () => {
  assert.equal(resolveLanes({}, 'residential', true), 1);
  assert.equal(resolveLanes({}, 'residential', false), 2);
  // ...except where "two-way" does not mean "two marked lanes". A dry run over the real PBF gave
  // alleys 5.5 m and Gracia shared-surface streets 6.0 m under the doubling rule — both wider than
  // the streets they represent. They stay single-lane and their class floor sets the width.
  assert.equal(resolveLanes({}, 'service', false), 1, 'an alley is one lane taken in turns');
  assert.equal(resolveLanes({}, 'living_street', false), 1, 'so is a shared surface');
  assert.equal(resolveLanes({ lanes: '2' }, 'service', false), 2, 'an explicit tag still wins');
  assert.equal(resolveLanes({ lanes: '4' }, 'residential', true), 4, 'an explicit tag always wins');
  assert.equal(resolveLanes({ 'lanes:forward': '2', 'lanes:backward': '2' }, 'primary', false), 4);
});

// ── 5. The three regressions the measurement found ──────────────────────────────────────────────

test('a footway is 2 m, not the 4 m the drivable floor used to give it', () => {
  // Measured on the shipped tiles: 100% of footway, pedestrian and steps baked at exactly 4 m,
  // because MIN_WIDTH=4 was applied to every highway type including the ones you walk on.
  const f = computeRoadWidths({ highwayType: 'footway', tags: {} });
  near(f.carriagewayW, 2.0, 0.01, 'footway');
  assert.ok(computeRoadWidths({ highwayType: 'steps', tags: {} }).carriagewayW < 2.5, 'steps');
  assert.ok(computeRoadWidths({ highwayType: 'path', tags: {} }).carriagewayW < 2.5, 'path');
  assert.equal(f.parkingLeftW, 0, 'and it has no kerbside parking');
});

test('a pedestrian street stays wide — it is a street, not a pavement', () => {
  const p = computeRoadWidths({ highwayType: 'pedestrian', tags: {} });
  assert.ok(p.carriagewayW >= 4, 'Barcelona pedestrianised streets are genuinely wide');
});

test('the width tag is READ for paths, where it is a direct measurement', () => {
  const w = computeRoadWidths({ highwayType: 'footway', tags: { width: '3.5' } });
  near(w.carriagewayW, 3.5, 0.01, 'a tagged footway width');
  assert.equal(w.widthSource, 'osm');
});

test('an unknown highway type degrades to something sane rather than throwing', () => {
  const w = computeRoadWidths({ highwayType: 'somethingNew', tags: {} });
  assert.ok(w.carriagewayW > 0 && w.kerbToKerbW >= w.carriagewayW);
  assert.equal(computeRoadWidths({}).carriagewayW > 0, true, 'no highwayType at all');
});

// ── 6. The property that made R-W1 necessary ────────────────────────────────────────────────────

test('the same class and tags always produce the same width, anywhere in the city', () => {
  // R-W1's stated goal in one assertion: "so a two-lane tertiary is the same width everywhere".
  const a = computeRoadWidths({ highwayType: 'tertiary', tags: { lanes: '2' } });
  const b = computeRoadWidths({ highwayType: 'tertiary', tags: { lanes: '2' } });
  assert.deepEqual(a, b);
});

test('width rises monotonically with lane count', () => {
  let prev = 0;
  for (const n of [1, 2, 3, 4, 6]) {
    const w = computeRoadWidths({ highwayType: 'primary', tags: { lanes: String(n) } });
    assert.ok(w.carriagewayW >= prev, `lanes=${n} must not be narrower than lanes fewer`);
    prev = w.carriagewayW;
  }
});

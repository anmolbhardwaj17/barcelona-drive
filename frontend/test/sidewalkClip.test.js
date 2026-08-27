/**
 * R-J3 — the junction clip that was eating the pavement, and the guard against it coming back.
 *
 * SYMPTOM: bare green terrain along kerb lines and around every corner. The pavement and kerb are
 * clipped back near a junction so they do not run through the intersection; the clip was cutting
 * roughly twice as far as intended, so the strip between the asphalt and the buildings had nothing
 * drawn in it and the terrain showed through.
 *
 * TWO COMPOUNDING ERRORS, both measured on the shipped v10 tiles:
 *   1. the crossroads branch used the FULL paved width as the along-road depth. The kerb you must
 *      stop at is HALF a width away. (The tee branch, added by R-J2, always had this right.)
 *   2. the clip is a CIRCLE about the node, and the pavement runs offset to the side — so the code
 *      added `depth + offset` where the circle needs `hypot(depth, offset)`. Adding cuts at
 *      sqrt(depth² + 2·depth·offset), always further out than intended.
 *
 * Together: a median 21.4 m of pavement cut per road against a correct 9.7 m, and the pavement
 * removed ENTIRELY from 15.6% of roads that should have one (fixed: 5.4%). 138 km of kerb line.
 *
 * The logic lives in TWO files — `roadRenderer.js` (runtime ribbon path) and `sidewalkBaker.js`
 * (bake path) — and the bake half never received R-J2's tee fix at all. That is exactly how this
 * drifted. These tests pin them together.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { junctionApronDepth, offsetClipRadius, junctionClipRadius } from '../src/map/roadRenderer.js';
import * as baker from '../../backend/worldBuilder/sidewalkBaker.js';

const CURB = 0.15;
const INTERSECTION_RADIUS = 3;

/** Where a clip circle of radius R actually cuts a polyline running `offset` to the side. */
const cutAt = (R, offset) => (R <= offset ? 0 : Math.sqrt(R * R - offset * offset));

test('the clip circle cuts the pavement exactly at the intended depth', () => {
  // THE bug, stated as an equation. `depth + offset` does not put the cut at `depth`.
  for (const depth of [4, 8.575, 12, 20]) {
    for (const offset of [2, 6.85, 8.975]) {
      const R = offsetClipRadius(depth, offset);
      assert.ok(Math.abs(cutAt(R, offset) - depth) < 1e-9,
        `hypot: expected the cut at ${depth} m, got ${cutAt(R, offset)}`);
      // and the old rule always cut further out — never closer, so it always ATE pavement
      assert.ok(cutAt(depth + offset, offset) > depth - 1e-9,
        'the old depth+offset rule should over-cut, which is the defect');
    }
  }
});

test('a crossroads stops at the kerb — half a width out, not a whole one', () => {
  // Eixample secondary crossing, 14.15 m kerb to kerb.
  const j = { radius: 14.15 };
  assert.equal(junctionApronDepth(j, INTERSECTION_RADIUS), 14.15 / 2 + 1.5);
  // The old shared helper still returns the full width; that is deliberate — lane paint keeps it.
  assert.equal(junctionClipRadius(j, INTERSECTION_RADIUS), 14.15);
});

test('a tee is unchanged by R-J3 — R-J2 already had it right', () => {
  const tee = { tees: [{}], teeWidth: 10.4, radius: 20.65 };
  assert.equal(junctionApronDepth(tee, INTERSECTION_RADIUS), 10.4 / 2 + 1.5);
  assert.equal(junctionClipRadius(tee, INTERSECTION_RADIUS), 10.4 / 2 + 1.5,
    'the tee branch and the apron depth agree — that branch was the correct one all along');
});

test('the real Eixample case: 21.4 m of pavement eaten becomes 8.6 m', () => {
  const roadW = 14.15, swW = 3.5;
  const offset = roadW / 2 + CURB + swW / 2;           // pavement centreline offset
  const j = { radius: roadW };

  const wasR = junctionClipRadius(j, INTERSECTION_RADIUS) + offset;   // the shipped formula
  const nowR = offsetClipRadius(junctionApronDepth(j, INTERSECTION_RADIUS), offset);

  const was = cutAt(wasR, offset), now = cutAt(nowR, offset);
  assert.ok(was > 20 && was < 22, `expected the old rule to cut ~21 m, got ${was.toFixed(2)}`);
  assert.ok(Math.abs(now - (roadW / 2 + 1.5)) < 1e-9, 'the new rule cuts exactly to the kerb');
  assert.ok(now < was, 'the fix must restore pavement, never remove more');
});

test('the fix never cuts LESS than the road half-width — pavement must not enter the carriageway', () => {
  // The failure mode in the other direction: under-clipping runs the pavement across the junction.
  for (const w of [4, 6, 10.4, 14.15, 20.65]) {
    const depth = junctionApronDepth({ radius: w }, INTERSECTION_RADIUS);
    assert.ok(depth >= w / 2, `${w} m road: the pavement would cross its own kerb line`);
  }
});

test('a missing junction falls back rather than throwing', () => {
  assert.equal(junctionApronDepth(null, INTERSECTION_RADIUS), INTERSECTION_RADIUS);
  assert.equal(junctionApronDepth({}, INTERSECTION_RADIUS), INTERSECTION_RADIUS / 2 + 1.5);
});

test('the bake and the runtime clip the pavement identically', () => {
  // THE anti-drift guard. These two files already diverged once: R-J2's tee fix landed only in
  // roadRenderer, so the bake over-clipped every tee in the city for a whole session.
  const beDepth = baker.__test__?.junctionApronDepth;
  const beRadius = baker.__test__?.offsetClipRadius;
  assert.ok(beDepth && beRadius,
    'sidewalkBaker must export its clip helpers for this guard — see its __test__ export');

  for (const radius of [3, 4, 6, 10.4, 13.4, 14.15, 17.4, 20.65, 22]) {
    for (const offset of [1.5, 3.65, 6.85, 8.975, 12]) {
      const j = { radius };
      assert.equal(beDepth(j, INTERSECTION_RADIUS), junctionApronDepth(j, INTERSECTION_RADIUS),
        `apron depth drifted at radius ${radius}`);
      assert.equal(beRadius(beDepth(j, INTERSECTION_RADIUS), offset),
                   offsetClipRadius(junctionApronDepth(j, INTERSECTION_RADIUS), offset),
        `clip radius drifted at radius ${radius}, offset ${offset}`);
    }
  }
});

// ─── R-J4 · pavement may not lie ON a carriageway ────────────────────────────────────────────────

import { buildCarriagewayGrid, clipRunOutsideCarriageways } from '../src/map/roadRenderer.js';

/** A road record both sides accept: baked section fields + a polyline in {x, y=Z}. */
function croad(id, highwayType, kerbToKerbW, points, extra = {}) {
  return {
    id, highwayType, kerbToKerbW, width: kerbToKerbW,
    carriagewayW: kerbToKerbW, parkingLeftW: 0, parkingRightW: 0, shoulderW: 0,
    sidewalkW: 3, corridorW: kerbToKerbW + 6, layer: 0, points, ...extra,
  };
}
const along = (x0, z, n, step) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, y: z }));
const runLen = (r) => r.reduce((L, p, i) => i ? L + Math.hypot(p.x - r[i-1].x, p.y - r[i-1].y) : 0, 0);

test('a pavement lying along ANOTHER carriageway is removed', () => {
  // Gran Via in miniature: a 20 m avenue with a lateral service road 14 m off its centreline.
  // The lateral's pavement (offset ~+3.5 m toward the avenue) lands ON the avenue's asphalt.
  const avenue  = croad(1, 'primary',     20, along(0, 0, 21, 10));
  const lateral = croad(2, 'service',      6, along(0, 14, 21, 10));
  const covered = buildCarriagewayGrid([avenue, lateral]);

  // pavement centreline of the lateral, on the avenue side: 14 - (3 + 0.15 + 1.5) = 9.35 → inside
  // the avenue's 10 m half-width.
  const onAvenue = along(0, 9.35, 21, 10);
  assert.equal(clipRunOutsideCarriageways(onAvenue, covered, 1.5, lateral.id).length, 0,
    'a 200 m pavement lying down the middle of the avenue must be removed entirely');

  // the lateral's OTHER pavement, away from the avenue, is untouched
  const away = along(0, 18.65, 21, 10);
  const kept = clipRunOutsideCarriageways(away, covered, 1.5, lateral.id);
  assert.equal(kept.length, 1);
  assert.ok(Math.abs(runLen(kept[0]) - 200) < 0.5, 'the far pavement must survive in full');
});

test("a pavement beside its OWN road is never clipped — that is what a kerb is", () => {
  const street = croad(1, 'residential', 10.4, along(0, 0, 21, 10));
  const covered = buildCarriagewayGrid([street]);
  // Its own pavement sits at 10.4/2 + 0.15 + 1.5 = 6.85 — just outside its own kerb.
  const own = along(0, 6.85, 21, 10);
  const kept = clipRunOutsideCarriageways(own, covered, 1.5, street.id);
  assert.equal(kept.length, 1, 'self-exclusion must keep the road its own pavement');
  assert.ok(Math.abs(runLen(kept[0]) - 200) < 0.5);
  // NOTE: on a STRAIGHT road the offset (half + curb + swW/2) clears the inflated radius
  // (half - margin + swW/2) by curb + margin = 0.4 m on its own, so selfId is not what saves it
  // here. selfId exists for CURVES, where the offset polyline on the inside of a bend swings in
  // toward its own centreline and would otherwise clip itself away.
  const bend = croad(7, 'residential', 10.4,
    Array.from({ length: 19 }, (_, i) => {
      const a = (i / 18) * Math.PI;              // a tight 180-degree bend, radius 20 m
      return { x: 20 * Math.cos(a), y: 20 * Math.sin(a) };
    }));
  const bendCovered = buildCarriagewayGrid([bend]);
  const inner = Array.from({ length: 19 }, (_, i) => {
    const a = (i / 18) * Math.PI;
    return { x: (20 - 6.85) * Math.cos(a), y: (20 - 6.85) * Math.sin(a) };   // inside-of-bend pavement
  });
  assert.ok(clipRunOutsideCarriageways(inner, bendCovered, 1.5, bend.id).length >= 1,
    'self-exclusion must keep the inside-of-bend pavement its own road would otherwise swallow');
});

test('a pavement CROSSING a carriageway is split, not deleted', () => {
  const cross = croad(1, 'residential', 10.4, [{ x: 100, y: -200 }, { x: 100, y: 200 }]);
  const covered = buildCarriagewayGrid([cross]);
  const walk = along(0, 0, 41, 10);   // runs west→east straight through it
  const runs = clipRunOutsideCarriageways(walk, covered, 1.5, 999);
  assert.equal(runs.length, 2, 'one run each side of the carriageway');
  for (const r of runs) assert.ok(runLen(r) > 50, 'both sides must survive as real pavement');
});

test('the clip REMOVES geometry — it must never densify', () => {
  // A 1 m resample took the baked pavement from 1,968 to 20,670 floats on one tile. The clip
  // keeps source vertices and inserts only boundaries.
  const other = croad(1, 'residential', 10.4, [{ x: 500, y: -100 }, { x: 500, y: 100 }]);
  const covered = buildCarriagewayGrid([other]);
  const line = along(0, 0, 11, 100);   // 1 km, 11 points, crossing `other` once
  const runs = clipRunOutsideCarriageways(line, covered, 1.5, 999);
  const outVerts = runs.reduce((n, r) => n + r.length, 0);
  assert.ok(outVerts <= line.length + 2 * runs.length,
    `clip emitted ${outVerts} vertices from ${line.length} — it is resampling, not clipping`);
});

test('the bake and the runtime clip pavement identically', () => {
  const beGrid = baker.__test__?.buildCarriagewayGrid;
  const beClip = baker.__test__?.clipRunOutsideCarriageways;
  assert.ok(beGrid && beClip, 'sidewalkBaker must export its carriageway helpers for this guard');

  const roads = [
    croad(1, 'primary',      20,   along(0, 0, 21, 10)),
    croad(2, 'service',       6,   along(0, 14, 21, 10)),
    croad(3, 'residential', 10.4,  [{ x: 100, y: -60 }, { x: 100, y: 60 }]),
  ];
  const fe = buildCarriagewayGrid(roads);
  const be = beGrid(roads);

  for (const z of [0, 4, 9.35, 12, 14, 18.65, 25]) {
    const line = along(-50, z, 26, 10);
    for (const [extra, selfId] of [[0, null], [1.5, 2], [1.5, null], [0.15, 3]]) {
      const a = clipRunOutsideCarriageways(line, fe, extra, selfId);
      const b = beClip(line, be, extra, selfId);
      assert.equal(a.length, b.length, `run count drifted at z=${z}, extra=${extra}, self=${selfId}`);
      for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].length, b[i].length, `run ${i} vertex count drifted at z=${z}`);
        assert.ok(Math.abs(runLen(a[i]) - runLen(b[i])) < 1e-6, `run ${i} length drifted at z=${z}`);
      }
    }
  }
});

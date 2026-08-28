/**
 * N-36 / N-38 — the two rules that were deleting guard rails from the places that most need them.
 *
 * These are masking rules, so their failure mode is SILENCE: the rail is simply not there, and a
 * rail that is not there looks exactly like a road that was never meant to have one. That is how
 * both of these survived — nothing errors, nothing logs, the city just quietly has no barrier on a
 * 24 m flyover. Hence tests rather than a counter alone.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __railTest__ } from '../src/map/roadRenderer.js';

const { detectRoundaboutZonesForRails, GUARD_RAIL_ROUNDABOUT_DY } = __railTest__;

/** A closed ring of `n` points, radius r, centred at (cx, cz). Ends meet, so it reads as a roundabout. */
function ring(cx, cz, r, n = 12) {
  const points = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * r, y: cz + Math.sin(a) * r });
  }
  return { points, highwayType: 'tertiary', width: 8, id: 1 };
}

/** Terrain at a fixed height everywhere — enough for hasLateralDrop, which only needs a number. */
const flatOptions = (groundM) => ({ getElevationAt: () => groundM });

test('a roundabout ON THE GROUND still gets an exclusion zone', () => {
  // The zone is correct at grade: a ring of barrier round a normal roundabout walls off every entry.
  const zones = detectRoundaboutZonesForRails([ring(0, 0, 20)], flatOptions(0));
  assert.equal(zones.length, 1, 'a ground-level ring must still exclude rails near it');
});

test('the zone carries a height, so it can tell an entry from a flyover', () => {
  const zones = detectRoundaboutZonesForRails([ring(0, 0, 20)], flatOptions(0));
  assert.ok(Number.isFinite(zones[0].y), 'a zone without a height is the bug: a 2D circle');
});

test('the zone reaches beyond the ring itself, or it would not cover the entries', () => {
  const zones = detectRoundaboutZonesForRails([ring(0, 0, 20)], flatOptions(0));
  assert.ok(Math.sqrt(zones[0].rSq) > 20, 'zone radius must exceed the ring radius');
});

test('an ELEVATED ring gets NO zone — it is the one ring that needs a barrier', () => {
  // Ground far below the deck: hasLateralDrop sees a fall beside the ring, so it is a flyover
  // roundabout, and excluding it is backwards. This is the user-reported "floating roundabout".
  // The deck carries a BAKED elevation (as a real road does) while the terrain beside it is at 0,
  // so `hasLateralDrop` sees 25 m of air. Feeding the drop through the deck's own elevation rather
  // than through getElevationAt matters: that is the path the shipped tiles take.
  const deck = ring(0, 0, 20);
  deck.points = deck.points.map((p) => ({ ...p, elevation: 25 }));
  const zones = detectRoundaboutZonesForRails([deck], {
    getElevationAt: () => 0,
    elevationOffset: 0,
  });
  assert.equal(zones.length, 0, 'an elevated roundabout must not exclude its own rails');
});

test('the height band is small enough that a flyover is never mistaken for an entry', () => {
  // A road approaching at grade differs from the ring by ~0; one passing over differs by metres.
  // The band only has to separate those two, so anything much above a kerb and well under a
  // storey is right. Locked here because widening it silently re-breaks the 107 measured roads.
  assert.ok(GUARD_RAIL_ROUNDABOUT_DY >= 1 && GUARD_RAIL_ROUNDABOUT_DY <= 5,
    `height band ${GUARD_RAIL_ROUNDABOUT_DY} m is outside the range that separates an entry from an overpass`);
});

test('a plain straight road is not mistaken for a roundabout', () => {
  const straight = { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }],
                     highwayType: 'tertiary', width: 8, id: 2 };
  assert.equal(detectRoundaboutZonesForRails([straight], flatOptions(0)).length, 0);
});

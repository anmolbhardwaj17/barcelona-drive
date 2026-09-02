/**
 * Day/night preset invariants (P-L1, 2026-09-02).
 *
 * THE BUG THESE EXIST TO CATCH. NIGHT shipped with ambientIntensity 1.0 against DAY's 0.30 and an
 * exposure of 1.5 against DAY's 1.6. Night was lit FLATTER than day and was barely darker, so:
 *   - the sodium-warm street lamps (0xFFB25E, 26 m radius at ~22 m spacing = overlapping coverage)
 *     and the blue ambient wash were of comparable strength, and averaged to a LAVENDER carriageway;
 *   - nothing local could read against the floor, so the light grid and the car's headlights —
 *     both live, both fed real data — were invisible.
 *
 * Ambient alone is not the invariant: night legitimately carries a higher fill-to-key ratio than a
 * sunlit day, because there is no sun. What must never invert again is the AGGREGATE directionless
 * fill, and the exposure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, NIGHT } from '../src/ui/envPresets.js';

/** Ambient + hemisphere: the light that arrives from no particular direction and so flattens form. */
const flatFill = (p) => p.ambientIntensity + p.hemiIntensity;

test('night is not lit flatter than day', () => {
  assert.ok(flatFill(NIGHT) < flatFill(DAY),
    `night flat fill ${flatFill(NIGHT)} must stay below day's ${flatFill(DAY)}`);
});

test('night is actually darker than day, not merely bluer', () => {
  assert.ok(NIGHT.toneMappingExposure < DAY.toneMappingExposure - 0.2,
    `night exposure ${NIGHT.toneMappingExposure} must be meaningfully below day's ${DAY.toneMappingExposure}`);
});

test('the sun is the key by day; the moon never is', () => {
  assert.ok(NIGHT.dirIntensity < DAY.dirIntensity * 0.5);
  // The moon must still give SOME direction — form should not come from an omnidirectional wash.
  assert.ok(NIGHT.dirIntensity > 0.5);
});

test('night fill does not overpower the lamps it is meant to sit under', () => {
  // REGION.night.lampIntensity is 1.1. If the directionless floor rivals that, a surface beside a
  // lamp and one 40 m away start at the same brightness and no pool can form.
  assert.ok(flatFill(NIGHT) < 1.1, `night flat fill ${flatFill(NIGHT)} must stay under lamp intensity 1.1`);
});

test('day keeps its high-key airy look', () => {
  // P-L1 must not have quietly restyled the day frame — D-20 owns that look.
  assert.equal(DAY.ambientIntensity, 0.30);
  assert.equal(DAY.toneMappingExposure, 1.6);
  assert.equal(DAY.dirIntensity, 2.7);
});

test('lights come on at night and not by day', () => {
  assert.equal(NIGHT.lightsOn, true);
  assert.equal(DAY.lightsOn, false);
});

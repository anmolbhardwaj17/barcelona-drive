/**
 * P-3 — which clip plays which pedestrian state.
 *
 * The bug this replaces: a panicking pedestrian played the WALK flipbook at 2.6 cycles/s while an
 * actual `Run` clip sat unused in all three GLBs. The trap in the fix is that `walk` itself falls
 * back to /run/, so a file with no Walk would bake its run clip TWICE and the gait would never
 * change — which looks identical to the bug. That case is pinned below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPedClips } from '../src/car/pedClips.js';

// The real clip list, verified against all three files in frontend/public/models/people/.
const SHIPPED = ['Clapping', 'Death', 'Idle', 'Jump', 'Punch', 'Run', 'RunningJump',
                 'Sitting', 'Standing', 'SwordSlash', 'Walk']
  .map((n) => ({ name: `HumanArmature|Man_${n}` }));

test('the shipped GLBs resolve every state to the clip a human would pick', () => {
  const c = pickPedClips(SHIPPED);
  assert.match(c.walk.name, /Walk$/);
  assert.match(c.idle.name, /Idle$/);
  assert.match(c.run.name, /Run$/);
  assert.match(c.stand.name, /Standing$/);
  assert.match(c.fall.name, /Death$/);
});

test('RunningJump is not mistaken for the run cycle', () => {
  // /run/i matches it. A pedestrian bolting from a car should not be doing a running jump.
  const c = pickPedClips([{ name: 'Walk' }, { name: 'RunningJump' }, { name: 'Idle' }]);
  assert.equal(c.run, null, `picked ${c.run?.name}`);
});

test('THE TRAP: a file with no Walk does not bake its run clip as both gaits', () => {
  // `walk` falls back to /run/. If `run` were picked independently, walk and run would be the same
  // frames and the gait would not change under panic — the exact defect P-3 removes, reintroduced.
  const c = pickPedClips([{ name: 'Run' }, { name: 'Idle' }]);
  assert.match(c.walk.name, /Run/);
  assert.equal(c.run, null, 'run and walk resolved to the same clip');
});

test('run and stand are optional — a file without them yields null, not a throw', () => {
  const c = pickPedClips([{ name: 'Walk' }, { name: 'Idle' }]);
  assert.equal(c.run, null);
  assert.equal(c.stand, null);
  assert.equal(c.fall, null);
  assert.match(c.walk.name, /Walk/);
});

test('Sitting is never selected — nothing in the city is baked to sit on', () => {
  // urbanFeatureRenderer has no bench builder, so a seated pedestrian sits on the pavement. If a
  // bench builder ever lands, THIS test is the one to delete, deliberately.
  const c = pickPedClips(SHIPPED);
  for (const [state, clip] of Object.entries(c)) {
    if (clip) assert.doesNotMatch(clip.name, /Sitting|Clapping|Punch|Sword/i, `${state} picked ${clip.name}`);
  }
});

test('an empty animation list degrades to nulls instead of throwing', () => {
  const c = pickPedClips([]);
  assert.equal(c.walk, null);
  assert.equal(c.idle, null);
  const c2 = pickPedClips(undefined);
  assert.equal(c2.walk, null);
});

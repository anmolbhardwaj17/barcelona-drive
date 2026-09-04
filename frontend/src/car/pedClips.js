/**
 * pedClips.js — which animation clip in a people GLB plays which pedestrian state.
 *
 * Split out of carModels.js so it can be tested without loading three.js, a GLTFLoader and a 4 MB
 * binary. It takes NAMES and returns names; the baker does the rest.
 *
 * Every people GLB (man, woman-casual, woman-dress) ships eleven clips —
 *   Clapping, Death, Idle, Jump, Punch, Run, RunningJump, Sitting, Standing, SwordSlash, Walk
 * — and until P-3 exactly three were baked. `Run` is the one that shows: a panicking pedestrian was
 * playing the WALK flipbook at 2.6 cycles/s, which reads as fast-forward, not as running.
 *
 * WHAT IS DELIBERATELY LEFT UNUSED, so nobody "fixes" it later:
 *   • Sitting  — there is nothing in the city to sit on. `urbanFeatureRenderer` has no bench builder,
 *                so a seated pedestrian sits cross-legged on the pavement.
 *   • Jump / RunningJump / Punch / SwordSlash / Clapping — no state asks for them.
 */

/**
 * @param {{name:string}[]} clips  gltf.animations (or anything with `.name`)
 * @returns {{walk, idle, run, stand, fall}} clip objects; `run`, `stand` and `fall` may be null.
 */
export function pickPedClips(clips) {
  const list = clips || [];
  // ⚠ Both helpers take the regex as a PARAMETER rather than calling `/re/i.test(x)` inline. The
  // stale-reference check in undefinedRefs.test.js strips regex literals from the source and then
  // reads the leftover flag as an identifier, so `/run/i.test(name)` reports a phantom `i.test(…)`.
  const find = (re) => list.find((a) => re.test(a.name)) || null;
  const is = (a, re) => !!a && re.test(a.name);

  // Walk falls back through run → first clip, because a file with neither is still better animated
  // than a T-pose.
  const walk = find(/walk/i) || find(/run/i) || list[0] || null;
  const idle = find(/idle/i) || walk;

  // ⚠ If `walk` ALREADY fell back to the run clip, do not also bake it as the run: run and walk
  // would be the same frames, and a pedestrian would visibly not change gait when the car bears down
  // on them — the exact defect P-3 set out to remove, reintroduced silently.
  // (`RunningJump` also matches /run/, hence the explicit jump exclusion rather than a clever regex.)
  const run = is(walk, /run/i)
    ? null
    : (list.find((a) => is(a, /run/i) && !is(a, /jump/i)) || null);

  // `Standing` but not `RunningJump`-style names; a second stationary pose so a crowd of people
  // waiting at a kerb is not one pose stamped out N times.
  const stand = find(/stand/i);

  const fall = find(/death|dead|die|hit|faint|collapse|defeat|ko/i) || find(/roll|fall/i);

  return { walk, idle, run, stand, fall };
}

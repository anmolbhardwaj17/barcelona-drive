/**
 * nightFakes.js — one switch for the six stand-ins that faked street lighting before P2's real
 * light grid existed.
 *
 * WHY THIS EXISTS FOR A SHORT TIME. Before the grid, nothing in the world was lit by a lamp, so six
 * separate hacks approximated it: lamp emissive × bloom, additive ground-pool decals, hero-building
 * spill decals, and three per-vertex warm emissive "washes" (road, facade, vegetation). None of them
 * light anything — they paint warmth onto surfaces near lamps.
 *
 * With the grid on, both run at once and the road is lit TWICE. That is exactly what the too-bright
 * asphalt in the first P2-04 night drive was.
 *
 * These are scheduled for deletion in P2-05. This switch exists so the delete can be VERIFIED
 * rather than taken on faith: `?nofakes` turns them off in a live session, so the real grid can be
 * judged on its own against the same street, in the same drive, before any code is removed. The
 * tracker's own P2 exit gate asks for that night A/B.
 *
 * ⚠ When P2-05 deletes the fakes, DELETE THIS MODULE TOO. A kill switch that outlives what it
 * kills becomes a config flag nobody dares remove.
 */
const OFF = (() => {
  try { return new URLSearchParams(location.search).has('nofakes'); } catch { return false; }
})();

/** True when the fake-night stack should be suppressed (`?nofakes`). */
export function fakesDisabled() { return OFF; }

/** Scale any fake-night strength through this: returns 0 when suppressed. */
export function fakeNight(value) { return OFF ? 0 : value; }

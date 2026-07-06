/**
 * adaptiveResolution — trades render resolution for a stable framerate.
 *
 * The scene is GPU-bound (millions of fragments through the bloom/grade post chain at DPR 1.5).
 * When the GPU can't hold the frame budget this lowers the effective pixel ratio (fewer fragments
 * everywhere — the single biggest GPU lever), and restores it when there's headroom again. The
 * point is SMOOTHNESS: hold the framerate steady and let resolution flex, instead of the reverse.
 *
 * Evaluated on a rolling window so a single hitch (tile stream, GC) doesn't yank the resolution;
 * only a sustained slow/fast trend moves it, one small step at a time (no visible popping).
 */
export function createAdaptiveResolution(renderer, composer, bloomPass, { width, height }) {
  const CAP = Math.min(window.devicePixelRatio || 1, 1.2);  // best quality when idle (lowered 1.5→1.2 for smoothness — user opted into lower res)
  const FLOOR = Math.min(CAP, 0.7);                         // worst we'll accept under load (lowered 0.8→0.7 for more headroom)
  const STEP_DOWN = 0.08;   // small steps near the target so it settles instead of oscillating
  const STEP_UP = 0.05;
  // Under vsync the frame time is pinned to the refresh period (~16.7 ms @ 60 Hz) no matter how much GPU
  // headroom exists — so we CANNOT detect headroom by asking for a sub-12 ms frame (that needs >80 fps,
  // impossible at 60). Instead: drop when we're missing 60 (>SLOW_MS), and probe UP when we're comfortably
  // holding 60 (<FAST_MS, i.e. ~60+ fps). A learned ceiling (probeCeiling) stops it oscillating/black-
  // flashing across the boundary: once a scale fails, we won't probe back up to it until the scene lightens.
  const SLOW_MS = 17.6;     // avg frame slower than this (~<57 fps) → drop resolution
  const FAST_MS = 16.9;     // avg frame at/under this (~60 fps, holding vsync) → headroom, probe resolution up
  const WINDOW = 45;        // frames between adjustments (~0.7s at 60fps) — long enough to ignore one-off hitches
  const COOLDOWN = 210;     // frames (~3.5s) to hold after a change. Each change reallocates the render
                            // targets (a resize can flash black), so we must NOT thrash — settle, then rest.

  const PHOTO_SCALE = Math.min(window.devicePixelRatio || 1, 2); // full crispness for photos (retina if available)
  let scale = CAP;
  let acc = 0, n = 0;
  let cool = 0;   // frames left in the post-change cooldown
  let photo = false;
  let preScale = CAP;   // scale to restore when photo mode ends
  let w = width, h = height;
  let probeCeiling = CAP;   // highest scale we'll probe up to — lowered below a scale that fails, so we
                            //   settle just under it instead of oscillating. Slowly forgiven back toward CAP.
  let fastRun = 0;          // consecutive "holding 60" windows — used to forgive the ceiling when the scene lightens

  function apply() {
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h, false); // updateStyle=false: backing buffer only, CSS size unchanged
    if (composer.setPixelRatio) composer.setPixelRatio(scale);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
  }
  apply();

  return {
    /** Effective pixel ratio in [FLOOR, CAP] — for HUD readout. */
    getScale() { return scale; },
    /** Call from the resize handler instead of renderer/composer.setSize. */
    setSize(nw, nh) { w = nw; h = nh; apply(); },
    /** Photo Mode: pin full resolution (no adaptive downscaling) for crisp screenshots. */
    setPhotoMode(on) {
      if (on === photo) return;
      photo = on;
      if (on) { preScale = scale; scale = PHOTO_SCALE; }
      else { scale = preScale; }
      apply();
    },
    /** Call once per frame with the frame delta (seconds). */
    tick(frameDtSeconds) {
      if (photo) return;   // resolution pinned high for photos — don't auto-adjust
      acc += (frameDtSeconds || 0) * 1000;
      n += 1;
      if (cool > 0) cool -= 1;
      if (n < WINDOW) return;
      const avg = acc / n;
      acc = 0; n = 0;
      if (cool > 0) return;   // holding after a change — don't reallocate again yet (anti-flicker)
      let next = scale;
      if (avg > SLOW_MS && scale > FLOOR) {
        // Missing the frame budget at this scale → it's too high. Remember it as the ceiling (probe stays
        // strictly below it) so we don't climb straight back up and oscillate, then step down.
        probeCeiling = Math.max(FLOOR, +(scale - STEP_UP).toFixed(3));
        fastRun = 0;
        next = Math.max(FLOOR, +(scale - STEP_DOWN).toFixed(3));
      } else if (avg < FAST_MS) {
        // Comfortably holding 60. Slowly forgive the ceiling after a sustained smooth run so a lightening
        // scene (fewer buildings/trees) can reclaim resolution it previously lost.
        fastRun += 1;
        if (fastRun >= 6 && probeCeiling < CAP) { probeCeiling = Math.min(CAP, +(probeCeiling + STEP_UP).toFixed(3)); fastRun = 0; }
        if (scale < probeCeiling) next = Math.min(probeCeiling, +(scale + STEP_UP).toFixed(3));
      } else {
        fastRun = 0; // borderline (dead zone) — hold steady
      }
      if (next !== scale) { scale = next; apply(); cool = COOLDOWN; }
    },
  };
}

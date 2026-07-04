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
  const CAP = Math.min(window.devicePixelRatio || 1, 1.5); // best quality when we have headroom
  const FLOOR = Math.min(CAP, 0.75);                       // worst we'll accept (~1080p→810p) before giving up sharpness
  const STEP_DOWN = 0.12;   // shed resolution faster than we add it back (bias toward smooth)
  const STEP_UP = 0.05;
  const SLOW_MS = 20.5;     // avg frame slower than this (~<49 fps) → drop resolution
  const FAST_MS = 13.8;     // avg frame faster than this (~>72 fps) → we can afford more
  const WINDOW = 45;        // frames between adjustments (~0.7s at 60fps) — long enough to ignore one-off hitches

  let scale = CAP;
  let acc = 0, n = 0;
  let w = width, h = height;

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
    /** Call once per frame with the frame delta (seconds). */
    tick(frameDtSeconds) {
      acc += (frameDtSeconds || 0) * 1000;
      n += 1;
      if (n < WINDOW) return;
      const avg = acc / n;
      acc = 0; n = 0;
      let next = scale;
      if (avg > SLOW_MS && scale > FLOOR) next = Math.max(FLOOR, +(scale - STEP_DOWN).toFixed(3));
      else if (avg < FAST_MS && scale < CAP) next = Math.min(CAP, +(scale + STEP_UP).toFixed(3));
      if (next !== scale) { scale = next; apply(); }
    },
  };
}

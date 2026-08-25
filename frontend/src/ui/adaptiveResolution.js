import { QUALITY } from '../quality.js';   // v3 P1-08
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
  const CAP = Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio);   // v3 P1-08: tier-capped  // best quality when idle (lowered 1.5→1.2 for smoothness — user opted into lower res)
  const FLOOR = Math.min(CAP, 0.55);                        // worst we'll accept under load — LOW so heavy areas hold 60 by softening slightly instead of dropping frames (was 0.7, which couldn't recover 60 in dense Eixample)
  const STEP_DOWN = 0.08;   // small steps near the target so it settles instead of oscillating
  const STEP_UP = 0.05;
  // Priority is SMOOTHNESS: hold 60 by flexing resolution DOWN under load. We do NOT aggressively probe
  // resolution up — under vsync the frame time is pinned to ~16.7 ms whether the GPU is 50% or 95% loaded,
  // so "am I at 60?" can't tell us if there's room to climb; probing up just overshoots and drops frames
  // (that's what happened at 0.70 → 45-55). So climb only very gently, in the genuinely idle case, and let
  // load reduction (fewer tris) be what earns real sharpness. Drop is decisive; climb is a slow trickle.
  const SLOW_MS = 17.2;     // avg frame slower than this (~<58 fps) → drop resolution decisively
  const FAST_MS = 15.5;     // avg frame comfortably under budget (~>64 fps) → trickle resolution back up
  const WINDOW = 45;        // frames between adjustments (~0.7s at 60fps) — long enough to ignore one-off hitches
  const COOLDOWN = 240;     // frames (~4s) to hold after a change. Each change reallocates the render
                            // targets (a resize can flash black), so we must NOT thrash — settle, then rest.

  const PHOTO_SCALE = Math.min(window.devicePixelRatio || 1, 2); // full crispness for photos (retina if available)
  let scale = CAP;
  let acc = 0, n = 0;
  let gacc = 0, gn = 0;   // GPU ms accumulator over the same window
  // Share of the frame the GPU must own before resolution is treated as the right lever. 0.55 is
  // deliberately generous: we would rather occasionally fail to drop than blur the game chasing a
  // CPU stall. A genuinely GPU-bound frame sits far above this.
  const GPU_BOUND_SHARE = 0.55;
  let cool = 0;   // frames left in the post-change cooldown
  let photo = false;
  let preScale = CAP;   // scale to restore when photo mode ends
  let w = width, h = height;

  // Cost of one resolution change, measured rather than assumed. This reallocates every render
  // target in the composer chain — bloom's mip pyramid included — and the frame attributor caught a
  // 46 ms `post` on a drive, with this as the only plausible occupant. Timed here so the claim is a
  // number instead of an inference.
  //
  // ⚠ THE BENCHMARK CANNOT SEE THIS. main.js runs `if (!_BENCH) adaptiveRes.tick(...)` — pinning is
  // correct for comparability (an unpinned run measures "did the controller give up" rather than
  // "how expensive is the frame"), but it means every baseline is structurally blind to this stall
  // while a real player meets one every few seconds. Do not conclude from a clean bench run that
  // this does not happen.
  let _applyWorst = 0;
  function apply() {
    const t0 = performance.now();
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h, false); // updateStyle=false: backing buffer only, CSS size unchanged
    if (composer.setPixelRatio) composer.setPixelRatio(scale);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
    const ms = performance.now() - t0;
    if (ms > _applyWorst) _applyWorst = ms;
    if (ms >= 8) {
      console.warn('[adaptRes] resize to %s cost %sms — reallocated the composer chain (worst %sms)',
        scale.toFixed(2), ms.toFixed(1), _applyWorst.toFixed(1));
    }
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
    /**
     * Call once per frame with the frame delta (seconds) and, if available, the measured GPU ms.
     *
     * ⚠ RESOLUTION IS A GPU LEVER. Dropping it shrinks the number of fragments shaded and does
     * NOTHING for a frame that is slow on the CPU — streaming, tile builds, physics, GC. Without
     * the gate below, a CPU-bound frame looks identical to a GPU-bound one from `frameDt` alone,
     * so the controller kept cutting resolution against a bottleneck it cannot move: the picture
     * got blurrier, the frame did not get faster, and each attempt cost ~47 ms of composer
     * reallocation which itself caused more slow frames. Measured in the wild: frames at 87 ms
     * with GPU at 7.7 ms, resolution collapsed to 0.56.
     *
     * So we only drop when the GPU is plausibly the constraint. With no GPU timer (unsupported),
     * we fall back to the old behaviour rather than never adapting at all.
     */
    tick(frameDtSeconds, gpuMs = null) {
      if (photo) return;   // resolution pinned high for photos — don't auto-adjust
      acc += (frameDtSeconds || 0) * 1000;
      if (gpuMs != null && gpuMs > 0) { gacc += gpuMs; gn += 1; }
      n += 1;
      if (cool > 0) cool -= 1;
      if (n < WINDOW) return;
      const avg = acc / n;
      const gAvg = gn ? gacc / gn : null;
      acc = 0; n = 0; gacc = 0; gn = 0;
      if (cool > 0) return;   // holding after a change — don't reallocate again yet (anti-flicker)
      // GPU-bound test. If the GPU is using less than this share of the frame, the time is being
      // spent somewhere resolution cannot reach, and cutting it only costs a 47 ms reallocation.
      const gpuBound = gAvg == null || gAvg > avg * GPU_BOUND_SHARE;
      let next = scale;
      if (avg > SLOW_MS && scale > FLOOR && gpuBound) next = Math.max(FLOOR, +(scale - STEP_DOWN).toFixed(3));
      else if (avg < FAST_MS && scale < CAP) next = Math.min(CAP, +(scale + STEP_UP).toFixed(3));
      if (next !== scale) { scale = next; apply(); cool = COOLDOWN; }
    },
  };
}

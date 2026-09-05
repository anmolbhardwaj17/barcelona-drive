import { QUALITY } from '../quality.js';   // v3 P1-08
import { CONFIG } from '../config.js';   // DEBUG_INIT gating
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
/**
 * `?adaptres=0` pins resolution and disables the controller entirely — an ATTRIBUTION switch, so a
 * "does this controller help or hurt?" question is answered by driving the same street both ways
 * rather than argued. Its own resizes cost 70-144 ms each, so it is a plausible suspect in any
 * stutter report and must be falsifiable.
 */
const ENABLED = (() => {
  try { return new URLSearchParams(location.search).get('adaptres') !== '0'; } catch { return true; }
})();

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
  let _applyTotal = 0, _applyCount = 0;

  // v3 — DOES THE LEVER ACTUALLY WORK? Measured on a dense-Eixample drive 2026-08-26: the controller
  // stepped 1.12 → 1.04 → 0.96 → 0.88 → 0.80, which is **49% fewer pixels shaded**, and the long
  // frames stayed at 50-90 ms throughout. Five reallocations cost ~590 ms of hitches, and the cost
  // per resize GREW from 70 ms to 144 ms.
  //
  // The GPU_BOUND_SHARE gate below was satisfied — the GPU genuinely was busy. But "GPU-bound" is not
  // the same as "FILL-RATE-bound": a frame limited by draw calls and vertex processing shows a busy
  // GPU while being completely indifferent to resolution. Halving the pixels proves which one it is,
  // and here it proved fill rate is NOT the constraint.
  //
  // So the controller now VERIFIES its own lever: after a drop it compares the new frame average
  // against the one that triggered the drop. Two ineffective drops and resolution is locked out and
  // restored, because continuing means paying ~120 ms a step to blur the picture for nothing.
  let _probe = null;        // {beforeAvg, beforeScale} — a drop awaiting its verdict
  let _ineffective = 0;

  /**
   * ── IT WAS MAKING ITS DECISION DURING THE LOAD ────────────────────────────────────────────────
   *
   * Measured over four consecutive drives (2026-08-27): the controller probed twice, both probes
   * failed, it locked out, and it did that EVERY time — costing 4 resizes, 210-519 ms and 15.3 MB,
   * enough to earn its own `adaptRes` line in the drive report. Its verdict was always the same and
   * always correct: *"the GPU is busy but not with FRAGMENTS."*
   *
   * The reason it kept spending that budget to learn nothing is WHEN it spent it. It ticked from
   * frame one, so every probe landed inside the first ~20 s — where the frame is long because the
   * world is streaming, not because of fill rate. It was answering a steady-state question with
   * transient data, and no resolution change can fix a frame that is waiting on a tile build.
   *
   * This is D-66's shape exactly (the tile build budget shrank itself during the load, because
   * loading is what was making frames long). Two independent adaptive controllers, same mistake:
   * **an adaptive controller tuned for the steady state will read the transient as a fault.**
   *
   * So it now waits to be ARMED, at the same instant `cpuTimer.armLongFrames()` fires — the moment
   * main.js already considers "the measured thing has actually started" — plus a settling window.
   * The two-probe limit is deliberately kept: the readings were noisy in the transient (one drive
   * measured +4.3%, the next -23.5% on the same step), and one noisy negative should not lock the
   * controller out for a session on a machine where resolution IS the right lever.
   *
   * NOT disabled by default. On a weaker GPU this is a real safety net; what was broken here is
   * when it measured, not that it exists.
   */
  let _armed = false;
  let _settle = 0;
  const SETTLE_FRAMES = 180;   // ~3 s after the world is drivable, before the first probe
  let _restoreScale = null;   // scale before the FIRST ineffective drop — the whole streak unwinds
  let _lockedOut = false;
  const PROBE_MIN_GAIN = 0.05;   // a real fill-rate win from -0.08 dpr is far more than 5%
  /**
   * @param {boolean} updateStyle  true ONLY when the window itself changed size.
   *
   * ⚠ THIS FLAG IS THE DIFFERENCE BETWEEN TWO OPERATIONS THAT LOOK IDENTICAL.
   *
   * An adaptive-resolution change alters the BACKING BUFFER and must leave the canvas's CSS size
   * alone — that is the whole mechanism: same box on screen, fewer pixels in it. So `false` is right
   * there.
   *
   * A WINDOW resize is the opposite: the box changed. `scene.js` calls `renderer.setSize(w, h)` once
   * at startup, which writes inline `style.width/height` in px, and `index.html` gives the canvas no
   * CSS size of its own (`canvas { display: block; }`). So with `updateStyle` false everywhere, that
   * inline size was frozen at whatever the window was when the game loaded. Going fullscreen grew the
   * drawing buffer and left the canvas element the old size — the game stayed windowed-sized with
   * dead space below it. User-reported 2026-09-05.
   */
  function apply(updateStyle = false) {
    const t0 = performance.now();
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h, updateStyle);
    if (composer.setPixelRatio) composer.setPixelRatio(scale);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
    const ms = performance.now() - t0;
    if (ms > _applyWorst) _applyWorst = ms;
    _applyTotal += ms;
    _applyCount += 1;
    if (ms >= 8) {
      // Routine bookkeeping — the VERDICT lines below stay ungated, because those are findings.
      if (CONFIG.DEBUG_INIT) console.warn('[adaptRes] resize to %s cost %sms — reallocated the composer chain (worst %sms, %d resizes = %dms total)',
        scale.toFixed(2), ms.toFixed(1), _applyWorst.toFixed(1), _applyCount, Math.round(_applyTotal));
    }
  }
  apply();

  return {
    /** Effective pixel ratio in [FLOOR, CAP] — for HUD readout. */
    getScale() { return scale; },
    /** Call from the resize handler instead of renderer/composer.setSize. */
    setSize(nw, nh) { w = nw; h = nh; apply(true); },   // the WINDOW moved — restyle the canvas
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
    /**
     * Start measuring. Called at the time-to-drive instant — see the note by `_armed`: before that
     * the frame is long because of streaming, and resolution cannot reach it.
     */
    arm() { if (!_armed) { _armed = true; _settle = SETTLE_FRAMES; } },

    tick(frameDtSeconds, gpuMs = null) {
      if (photo) return;   // resolution pinned high for photos — don't auto-adjust
      if (!ENABLED) return;   // ?adaptres=0 — attribution switch, see ENABLED
      if (!_armed) return;    // the world is still loading; nothing here can be measured yet
      if (_settle > 0) { _settle -= 1; return; }
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

      // Verdict on the previous drop, now that a full window has passed at the lower resolution.
      if (_probe) {
        const gain = (_probe.beforeAvg - avg) / _probe.beforeAvg;
        if (gain < PROBE_MIN_GAIN) {
          // Remember where the streak STARTED. Restoring only the last step would leave every earlier
          // ineffective drop in place — the picture stays blurred by exactly the amount that was
          // proven not to help.
          if (_ineffective === 0) _restoreScale = _probe.beforeScale;
          _ineffective += 1;
          console.warn('[adaptRes] dropping to %s changed the frame by %s%% (%sms → %sms) — resolution is NOT the constraint (%d/2)',
            scale.toFixed(2), (gain * 100).toFixed(1), _probe.beforeAvg.toFixed(1), avg.toFixed(1), _ineffective);
          if (_ineffective >= 2) {
            _lockedOut = true;
            scale = _restoreScale ?? _probe.beforeScale;
            apply();
            cool = COOLDOWN;
            console.warn('[adaptRes] LOCKED OUT — restored %s. The GPU is busy but not with FRAGMENTS ' +
              '(draw calls / vertices), so cutting resolution only costs reallocations. %d resizes have cost %dms.',
              scale.toFixed(2), _applyCount, Math.round(_applyTotal));
          }
        } else {
          _ineffective = 0; _restoreScale = null;   // it worked — resolution is a live lever again
        }
        _probe = null;
        if (_lockedOut) return;
      }
      if (_lockedOut) return;

      let next = scale;
      let dropping = false;
      if (avg > SLOW_MS && scale > FLOOR && gpuBound) {
        next = Math.max(FLOOR, +(scale - STEP_DOWN).toFixed(3));
        dropping = true;
      } else if (avg < FAST_MS && scale < CAP) next = Math.min(CAP, +(scale + STEP_UP).toFixed(3));
      if (next !== scale) {
        const beforeScale = scale;
        scale = next; apply();
        // Cost-aware rest: a resize that cost 144 ms has already burnt ~9 frames of budget. Resting
        // proportionally stops the controller from adding more stalls than it removes.
        cool = COOLDOWN + Math.round(Math.min(600, _applyWorst * 4));
        if (dropping) _probe = { beforeAvg: avg, beforeScale };
      }
    },
  };
}

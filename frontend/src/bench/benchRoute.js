/**
 * benchRoute.js — the v3 baseline benchmark (P0-04/05/06).
 *
 * WHY A SCRIPTED ROUTE. Hand-driving is not a benchmark: the route, speed and tile-load order differ
 * every run, so a 1 ms delta is indistinguishable from having taken a different street. This drives
 * the REAL car through the REAL physics and the REAL streaming pipeline, but along a fixed waypoint
 * list with CLOSED-LOOP steering — so it self-corrects and lands on the same tiles every time, which
 * an open-loop "hold these keys" script does not (physics drift compounds over 90 s).
 *
 * Input goes in as synthetic KeyboardEvents, the same path touchControls.js uses, so the car is
 * driven exactly as a player drives it — no special-case code in the physics or control layer.
 *
 * USAGE:  http://localhost:4040/?bench          (dev)
 *         npm run build && npm run preview → /?bench   ← USE THIS ONE for a committed baseline
 * Forces: car mode, NIGHT, pixel ratio 1.0, adaptive-resolution pinned, fpscap off.
 * Writes v3-baseline JSON to Downloads and prints a summary via console.warn.
 *
 * ⚠ Pixel ratio and the adaptive-resolution floor MUST be pinned or the numbers are meaningless —
 * adaptiveResolution silently trades resolution for frame time, so an unpinned run measures "did the
 * controller give up" rather than "how expensive is the frame".
 */

// Gran Via de les Corts Catalanes, north-eastbound through the dense Eixample grid.
//
// ⚠ THESE MUST LIE ON THE STREET. The first version of this list ran lat-DOWN / lon-UP, which is
// roughly PERPENDICULAR to Gran Via — the Cerdà grid is rotated ~45°, so that diagonal steered the
// car straight into building blocks. It reached 1 of 6 waypoints, spent 29% of the run at 0 km/h,
// and produced a "benchmark" of a stationary car. Gran Via runs lat-UP as lon-UP (SW→NE):
// Pl. Espanya 41.3754/2.1490 → Universitat → Tetuan → Glòries 41.4030/2.1870.
//
// If you re-route this, plot the points on a map first and confirm they follow one continuous
// street. Straight-line steering has no idea buildings exist.
const ROUTE = [
  { lat: 41.3866, lon: 2.1640 },   // Plaça Universitat
  { lat: 41.3888, lon: 2.1672 },
  { lat: 41.3912, lon: 2.1710 },
  { lat: 41.3936, lon: 2.1745 },   // Plaça Tetuan
  { lat: 41.3968, lon: 2.1793 },
  { lat: 41.4000, lon: 2.1838 },   // toward Glòries  (~2.25 km ≈ 101 s at 80 km/h)
];

const TARGET_KMH = 80;
const MAX_SECONDS = 130;   // ~2.25 km route needs ~101 s at target speed, plus recovery slack
const WAYPOINT_RADIUS_M = 45;
const WAYPOINT_TIMEOUT_MS = 20000;   // skip a waypoint we cannot reach rather than grind on it
const RECORD_SECONDS = 90;           // manual mode: seconds of driving to record once moving
const STUCK_MS = 1800;               // <3 km/h for this long = wedged
const REVERSE_MS = 1400;             // back out, steering the opposite way

function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    mean: +mean.toFixed(2), p50: +pct(s, 50).toFixed(2),
    p95: +pct(s, 95).toFixed(2), p99: +pct(s, 99).toFixed(2), max: +s[s.length - 1].toFixed(2),
  };
}

export function isBenchMode() {
  try { return new URLSearchParams(location.search).has('bench'); } catch { return false; }
}

/**
 * 'manual' (default) — YOU drive; the harness only pins settings and records.
 * 'auto'             — the scripted waypoint route drives itself.
 *
 * Manual is the default because a human trivially does the one thing the bot could not: avoid
 * traffic and street furniture. The bot's route is geometrically correct but it steers straight
 * lines and has no idea a fountain is there, so it wedges. A person driving the same avenue twice
 * is far more reproducible than a bot that spends a third of the run stationary.
 */
export function benchModeKind() {
  try { return new URLSearchParams(location.search).get('bench') === 'auto' ? 'auto' : 'manual'; }
  catch { return 'manual'; }
}

/**
 * @param {object} deps
 *  latLonToWorld, getCarPos()->{wx,wz}, getSpeedKmh(), getHeadingDeg(),
 *  renderer, gpuTimer, programsAtLoaderHide, timeToDriveMs
 */
export function startBenchRoute(deps) {
  const { latLonToWorld, getCarPos, getSpeedKmh, getHeadingDeg, renderer, gpuTimer } = deps;
  const wps = ROUTE.map((p) => latLonToWorld(p.lat, p.lon));
  let wi = 1;
  let held = { up: false, down: false, left: false, right: false };
  let _prev = null, _lastBearing = 0;   // for movement-derived bearing (see tick)
  // Stuck recovery. Closed-loop steering fixes HEADING but has no answer to "wedged against a
  // building" — holding throttle into a wall does nothing forever. The first run spent 29% of its
  // time at 0 km/h and reached 1 of 6 waypoints because of exactly this.
  let _stuckSince = 0, _reverseUntil = 0, _reverseDir = 1, _wpDeadline = 0;
  const t0 = performance.now();
  const samples = [];
  const heap0 = performance.memory?.usedJSHeapSize ?? 0;
  let done = false;

  const manual = deps.manual !== false;
  let armed = !manual;          // manual: wait for the driver to actually move before timing
  let armT = 0;

  let hud = null;
  if (manual) {
    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:100000;' +
      "font:600 13px/1.5 'Inter',system-ui,sans-serif;color:#f3ede1;background:rgba(28,25,22,0.72);" +
      'backdrop-filter:blur(15px);border:1px solid rgba(243,237,225,0.16);border-radius:13px;' +
      'padding:10px 16px;text-align:center;letter-spacing:0.02em;pointer-events:none;';
    hud.innerHTML = '<b>BENCHMARK — drive normally</b><br>' +
      'Head NE along Gran Via, hold ~80 km/h.<br>' +
      '<span style="opacity:.7">Recording starts when you move · ' + RECORD_SECONDS + 's</span>';
    document.body.appendChild(hud);
  }
  console.warn('[bench] START — %s, night, %ds of recording',
    manual ? 'MANUAL (you drive)' : 'AUTO (' + wps.length + ' waypoints)',
    manual ? RECORD_SECONDS : MAX_SECONDS);

  function holdBack(want) { hold('down', 'ArrowDown', want); }
  function hold(name, code, want) {
    if (want && !held[name]) { key('keydown', code); held[name] = true; }
    else if (!want && held[name]) { key('keyup', code); held[name] = false; }
  }
  function release() {
    hold('up', 'ArrowUp', false); hold('down', 'ArrowDown', false);
    hold('left', 'ArrowLeft', false); hold('right', 'ArrowRight', false);
  }

  function finish(reason) {
    if (done) return; done = true;
    release();
    if (hud) hud.remove();
    const frame = stats(samples.map((s) => s.ms));
    const gpu = stats(samples.filter((s) => s.gpuMs > 0).map((s) => s.gpuMs));
    const draws = stats(samples.map((s) => s.draws));
    const tris = stats(samples.map((s) => s.tris));
    const heap1 = performance.memory?.usedJSHeapSize ?? 0;
    const out = {
      meta: {
        label: 'v3-baseline', reason, git: deps.gitLabel || null,
        durationS: +((performance.now() - t0) / 1000).toFixed(1),
        frames: samples.length,
        mode: 'night / 80kmh target / Gran Via eastbound',
        pixelRatio: renderer?.getPixelRatio?.() ?? null,
        userAgent: navigator.userAgent,
        savedAt: new Date().toISOString(),
      },
      gates: {
        frameMs: frame, gpuMs: gpu, draws, tris,
        programsAtLoaderHide: deps.programsAtLoaderHide ?? null,
        programsAtEnd: renderer?.info?.programs?.length ?? null,
        programsDelta: (renderer?.info?.programs?.length ?? 0) - (deps.programsAtLoaderHide ?? 0),
        timeToDriveMs: deps.timeToDriveMs ?? null,
        heapStartMB: +(heap0 / 1048576).toFixed(1),
        heapEndMB: +(heap1 / 1048576).toFixed(1),
        heapGrowthPct: heap0 ? +(((heap1 - heap0) / heap0) * 100).toFixed(1) : null,
      },
      worstFrames: [...samples].sort((a, b) => b.ms - a.ms).slice(0, 30),
      samples,
    };
    console.warn(
      '[bench] DONE (%s)\n' +
      '  frame ms  p50 %s  p95 %s  p99 %s  max %s\n' +
      '  GPU ms    p50 %s  p95 %s  p99 %s  max %s   ← GATE: p95 <= 12.3 for P0\n' +
      '  draws     p50 %s  p95 %s                  ← GATE: <= 265 for P0\n' +
      '  triangles p50 %s  p95 %s\n' +
      '  programs  %s → %s (delta %s)              ← GATE: delta 0\n' +
      '  heap      %s MB → %s MB (%s%%)\n' +
      '  time-to-drive %s ms',
      reason,
      frame?.p50, frame?.p95, frame?.p99, frame?.max,
      gpu?.p50, gpu?.p95, gpu?.p99, gpu?.max,
      draws?.p50, draws?.p95, tris?.p50, tris?.p95,
      out.gates.programsAtLoaderHide, out.gates.programsAtEnd, out.gates.programsDelta,
      out.gates.heapStartMB, out.gates.heapEndMB, out.gates.heapGrowthPct,
      out.gates.timeToDriveMs,
    );
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'v3-baseline.json';
    document.body.appendChild(a); a.click(); a.remove();
    window._ddBenchResult = out;   // also readable from the console
  }

  /** Call once per frame from main.js's loop, after metrics for the frame are available. */
  function tick(frameMs) {
    if (done) return;
    const pos = getCarPos();
    if (!pos) return;

    // ── MANUAL: the driver steers. We only pin, sample and stop. ──
    if (manual) {
      const kmhNow = getSpeedKmh();
      if (!armed) {
        if (kmhNow < 5) return;             // not rolling yet — do not start the clock
        armed = true; armT = performance.now();
        if (hud) hud.innerHTML = '<b>BENCHMARK — recording</b><br><span style="opacity:.7">' +
          RECORD_SECONDS + 's · keep driving</span>';
        console.warn('[bench] recording started');
      }
      const el = (performance.now() - armT) / 1000;
      samples.push({
        t: +el.toFixed(2), ms: +frameMs.toFixed(2),
        gpuMs: +(gpuTimer?.getMs?.() ?? 0).toFixed(2),
        draws: renderer?.info?.render?.calls ?? 0,
        tris: renderer?.info?.render?.triangles ?? 0,
        kmh: Math.round(kmhNow), wp: 0,
      });
      if (hud && (samples.length % 30) === 0) {
        hud.innerHTML = '<b>BENCHMARK — recording</b><br><span style="opacity:.7">' +
          Math.max(0, Math.round(RECORD_SECONDS - el)) + 's left · keep driving</span>';
      }
      if (el > RECORD_SECONDS) finish('manual-complete');
      return;
    }

    const elapsed = (performance.now() - t0) / 1000;

    // ── closed-loop steering toward the current waypoint ──
    const tgt = wps[wi];
    const dx = tgt.x - pos.wx, dz = tgt.z - pos.wz;
    const dist = Math.hypot(dx, dz);
    const nowMs = performance.now();
    if (_wpDeadline === 0) _wpDeadline = nowMs + WAYPOINT_TIMEOUT_MS;
    if (dist < WAYPOINT_RADIUS_M) {
      _wpDeadline = nowMs + WAYPOINT_TIMEOUT_MS;
      if (++wi >= wps.length) { finish('route-complete'); return; }
    } else if (nowMs > _wpDeadline) {
      // Unreachable in a sane time — skip it rather than grind for the whole run.
      console.warn('[bench] waypoint %d unreachable in %ds — skipping', wi, WAYPOINT_TIMEOUT_MS / 1000);
      _wpDeadline = nowMs + WAYPOINT_TIMEOUT_MS;
      if (++wi >= wps.length) { finish('route-exhausted'); return; }
    }

    // ── stuck recovery ──
    const kmh = getSpeedKmh();
    if (nowMs < _reverseUntil) {
      hold('up', 'ArrowUp', false); holdBack(true);
      hold('left', 'ArrowLeft', _reverseDir < 0); hold('right', 'ArrowRight', _reverseDir > 0);
      _prev = { wx: pos.wx, wz: pos.wz };
      return;   // no sample while recovering: this is harness behaviour, not game behaviour
    }
    if (kmh < 3) {
      if (_stuckSince === 0) _stuckSince = nowMs;
      else if (nowMs - _stuckSince > STUCK_MS) {
        _reverseUntil = nowMs + REVERSE_MS;
        _reverseDir = -_reverseDir;          // alternate, so we do not re-wedge the same way
        _stuckSince = 0;
        console.warn('[bench] stuck — reversing out');
        return;
      }
    } else { _stuckSince = 0; }
    holdBack(false);
    // Bearing is derived from ACTUAL MOVEMENT, not getHeadingDeg(). The reported heading and the
    // world XZ frame do not share a sign convention — main.js:955 passes -headingDeg to the minimap
    // precisely because physics X is mirrored — so mixing them risks steering the wrong way. A
    // bearing measured from the car's own displacement is in the same frame as the waypoints by
    // construction, and it cannot be wrong. Falls back to the reported heading below ~2 km/h, where
    // displacement is too small to be a reliable direction.
    const want = Math.atan2(dx, dz) * 180 / Math.PI;
    let cur;
    if (_prev && getSpeedKmh() > 2) {
      const mdx = pos.wx - _prev.wx, mdz = pos.wz - _prev.wz;
      cur = (mdx * mdx + mdz * mdz) > 1e-4 ? Math.atan2(mdx, mdz) * 180 / Math.PI : _lastBearing;
    } else {
      cur = getHeadingDeg();
    }
    _lastBearing = cur;
    _prev = { wx: pos.wx, wz: pos.wz };
    const err = ((want - cur) % 360 + 540) % 360 - 180;
    hold('left', 'ArrowLeft', err < -6);
    hold('right', 'ArrowRight', err > 6);
    hold('up', 'ArrowUp', getSpeedKmh() < TARGET_KMH);

    samples.push({
      t: +elapsed.toFixed(2), ms: +frameMs.toFixed(2),
      gpuMs: +(gpuTimer?.getMs?.() ?? 0).toFixed(2),
      draws: renderer?.info?.render?.calls ?? 0,
      tris: renderer?.info?.render?.triangles ?? 0,
      kmh: Math.round(getSpeedKmh()), wp: wi,
    });

    if (elapsed > MAX_SECONDS) finish('time-cap');
  }

  return { tick, abort: () => finish('aborted') };
}

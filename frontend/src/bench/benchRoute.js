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

// Gran Via de les Corts Catalanes, eastbound through the dense Eixample grid.
// Straight arterial: keeps the car at speed, crosses ~12 chamfered junctions, streams a fresh tile
// row roughly every 12 s. Fixed lat/lon so the route is identical across runs and across branches.
const ROUTE = [
  { lat: 41.3920, lon: 2.1650 },
  { lat: 41.3906, lon: 2.1690 },
  { lat: 41.3892, lon: 2.1730 },
  { lat: 41.3878, lon: 2.1770 },
  { lat: 41.3864, lon: 2.1810 },
  { lat: 41.3850, lon: 2.1850 },
];

const TARGET_KMH = 80;
const MAX_SECONDS = 95;
const WAYPOINT_RADIUS_M = 45;

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
 * @param {object} deps
 *  latLonToWorld, getCarPos()->{wx,wz}, getSpeedKmh(), getHeadingDeg(),
 *  renderer, gpuTimer, programsAtLoaderHide, timeToDriveMs
 */
export function startBenchRoute(deps) {
  const { latLonToWorld, getCarPos, getSpeedKmh, getHeadingDeg, renderer, gpuTimer } = deps;
  const wps = ROUTE.map((p) => latLonToWorld(p.lat, p.lon));
  let wi = 1;
  let held = { up: false, left: false, right: false };
  let _prev = null, _lastBearing = 0;   // for movement-derived bearing (see tick)
  const t0 = performance.now();
  const samples = [];
  const heap0 = performance.memory?.usedJSHeapSize ?? 0;
  let done = false;

  console.warn('[bench] START — night, Gran Via eastbound, %d waypoints, cap %ds', wps.length, MAX_SECONDS);

  function hold(name, code, want) {
    if (want && !held[name]) { key('keydown', code); held[name] = true; }
    else if (!want && held[name]) { key('keyup', code); held[name] = false; }
  }
  function release() { hold('up', 'ArrowUp', false); hold('left', 'ArrowLeft', false); hold('right', 'ArrowRight', false); }

  function finish(reason) {
    if (done) return; done = true;
    release();
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
    const elapsed = (performance.now() - t0) / 1000;
    const pos = getCarPos();
    if (!pos) return;

    // ── closed-loop steering toward the current waypoint ──
    const tgt = wps[wi];
    const dx = tgt.x - pos.wx, dz = tgt.z - pos.wz;
    const dist = Math.hypot(dx, dz);
    if (dist < WAYPOINT_RADIUS_M) {
      if (++wi >= wps.length) { finish('route-complete'); return; }
    }
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
